package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.InputStream
import java.security.MessageDigest
import java.text.Normalizer
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/**
 * Writing files of a metadata-only account from the phone, in the formats of packages/metadata-client
 * (MetadataClient.upload): the file is cut into fragments of [FileWriter.CHUNK] bytes, each sealed with the
 * file's content key and posted to one of the account's channels (round-robin, paced per channel); the
 * manifest (the fragment list) is sealed the same way and posted with the thumbnail and preview as extra
 * attachments of its message; then one group operation (upload_commit + create) puts the file in the tree.
 * The upload holds a lease on the instance for the whole time (renewed every minute).
 */
object FileWrite {
    /** As DEFAULT_CHUNK_SIZE in drive-client.ts: 10 MiB minus the 28 bytes AES-GCM adds. */
    const val CHUNK = 10 * 1024 * 1024 - 28
    const val MANIFEST_SCHEMA = 1
    const val BLOB_EXT = ".txt"
    private val MAGIC = byteArrayOf(0x44, 0x44, 0x50, 0x56)

    /** manifestRef "ddn1:[1, f, k, webhookId, channelId, messageId, attachmentId]" (JSON array, as JSON.stringify). */
    fun encodeManifestRef(fileKey: ByteArray, webhookId: String, channelId: String, messageId: String, attachmentId: String): String =
        "ddn1:" + json.encodeToString(JsonArray.serializer(), buildJsonArray {
            add(JsonPrimitive(1)); add(JsonPrimitive(FileFormat.FRAGMENT_FORMAT)); add(JsonPrimitive(B64.enc(fileKey)))
            add(JsonPrimitive(webhookId)); add(JsonPrimitive(channelId)); add(JsonPrimitive(messageId)); add(JsonPrimitive(attachmentId))
        })

    /** A picture stored with the file: 't' thumbnail (short side 320, long ≤ 640, ≤ 48 KB), 'p' preview (long side 1280, ≤ 400 KB). */
    data class Picture(val kind: Char, val mime: String, val width: Int, val height: Int, val data: ByteArray)

    /** As sealPreview in previews.ts: "DDPV" | 1 | kind | w u16 | h u16 | mime length | mime | bytes, AES-GCM with the preview key. */
    fun sealPicture(keys: FileFormat.PreviewKeys, p: Picture): Pair<String, ByteArray> {
        val mime = p.mime.toByteArray(Charsets.UTF_8)
        val head = ByteArray(11 + mime.size)
        MAGIC.copyInto(head)
        head[4] = FileFormat.PREVIEW_FORMAT.toByte()
        head[5] = p.kind.code.toByte()
        head[6] = (p.width shr 8).toByte(); head[7] = p.width.toByte()
        head[8] = (p.height shr 8).toByte(); head[9] = p.height.toByte()
        head[10] = mime.size.toByte()
        mime.copyInto(head, 11)
        return keys.name(p.kind) to Aes.encrypt(keys.key, head + p.data)
    }

    /** Picture limits of PREVIEW_LIMITS (previews.ts): a picture outside them is left out, not sent. */
    fun pictureOk(p: Picture): Boolean {
        if (p.mime !in setOf("image/webp", "image/jpeg", "image/png") || p.data.isEmpty() || p.width < 1 || p.height < 1) return false
        return if (p.kind == 't') p.data.size <= 48 * 1024 && maxOf(p.width, p.height) <= 640 else p.kind == 'p' && p.data.size <= 400 * 1024 && maxOf(p.width, p.height) <= 1280
    }
}

/**
 * Posts to Discord webhooks (multipart, ?wait=true) with the per-channel pacing of rate-limit.ts (a token
 * bucket of 30/min with a burst of 4 per channel, shared by every webhook in it) and retries on 429 / 5xx /
 * a dropped connection. `apiOrigin` replaces https://discord.com in tests.
 */
class DiscordWriter(
    private val http: OkHttpClient = defaultHttp(),
    private val apiOrigin: String? = null,
    private val perMin: Double = 30.0,
    private val burst: Double = 4.0,
    private val now: () -> Long = System::currentTimeMillis,
) {
    data class Posted(val webhookId: String, val channelId: String, val messageId: String, val attachmentId: String, val size: Long, val extras: List<Discord.Attachment>)

    private class Bucket(var tokens: Double, var at: Long)
    private val buckets = HashMap<String, Bucket>()
    val stats = Stats()
    class Stats { val posts = AtomicLong(); val retries = AtomicLong(); val rateLimited = AtomicLong() }

    private fun map(url: String): String = apiOrigin?.let { url.replace(Regex("^https://(?:ptb\\.|canary\\.)?discord(?:app)?\\.com"), it) } ?: url

    /** Wait for a slot on the channel (shared by its webhooks). */
    private fun acquire(channelKey: String) {
        while (true) {
            val wait: Long
            synchronized(buckets) {
                val t = now()
                val b = buckets.getOrPut(channelKey) { Bucket(burst, t) }
                b.tokens = minOf(burst, b.tokens + (t - b.at) * perMin / 60_000.0)
                b.at = t
                if (b.tokens >= 1) { b.tokens -= 1; return }
                wait = ((1 - b.tokens) * 60_000.0 / perMin).toLong() + 1
            }
            Thread.sleep(wait)
        }
    }

    private fun slowDown(channelKey: String, seconds: Double) = synchronized(buckets) {
        buckets[channelKey]?.let { it.tokens = minOf(it.tokens, 0.0) - seconds * perMin / 60.0 }
    }

    /** One message with `main` and `extras` as attachments (main first). */
    fun post(hook: Vault.Webhook, filename: String, data: ByteArray, extras: List<Pair<String, ByteArray>> = emptyList()): Posted {
        require(extras.size <= 9) { "at most 10 attachments" }
        val files = listOf(filename to data) + extras
        val channelKey = hook.channelId.ifEmpty { hook.id }
        var lastErr: Exception? = null
        for (attempt in 0 until 8) {
            acquire(channelKey)
            val payload = buildJsonObject {
                put("content", "")
                put("attachments", buildJsonArray { files.forEachIndexed { i, f -> add(buildJsonObject { put("id", i); put("filename", f.first) }) } })
            }
            val body = MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("payload_json", null, json.encodeToString(JsonObject.serializer(), payload).toRequestBody("application/json".toMediaType()))
                .apply { files.forEachIndexed { i, f -> addFormDataPart("files[$i]", f.first, f.second.toRequestBody(OCTET)) } }
                .build()
            try {
                http.newCall(Request.Builder().url(map(hook.url) + "?wait=true").post(body).build()).execute().use { res ->
                    val text = res.body?.string().orEmpty()
                    when {
                        res.code == 429 -> {
                            stats.rateLimited.incrementAndGet()
                            val ra = runCatching { json.parseToJsonElement(text).jsonObject["retry_after"]?.jsonPrimitive?.content?.toDouble() }.getOrNull()
                                ?: res.header("retry-after")?.toDoubleOrNull() ?: 1.0
                            slowDown(channelKey, ra.coerceIn(0.1, 60.0))
                            lastErr = ServerException(429, "rate_limited")
                        }
                        res.code >= 500 -> lastErr = ServerException(res.code, "discord")
                        !res.isSuccessful -> throw ServerException(res.code, "discord post")
                        else -> {
                            stats.posts.incrementAndGet()
                            val j = json.parseToJsonElement(text).jsonObject
                            val atts = (j["attachments"] as? JsonArray ?: JsonArray(emptyList())).map {
                                val o = it.jsonObject
                                Discord.Attachment(o.str("id"), o.str("url"), o["size"]?.jsonPrimitive?.long ?: 0, o.strOrNull("filename") ?: "")
                            }
                            // Discord answers in the order sent; matched by name to be sure.
                            val first = atts.firstOrNull { it.filename == filename } ?: atts.firstOrNull() ?: throw IllegalStateException("webhook post: no attachment in the answer")
                            val ex = extras.map { e -> atts.firstOrNull { it.filename == e.first && it !== first } ?: throw IllegalStateException("webhook post: an attachment is missing in the answer") }
                            return Posted(hook.id, j.strOrNull("channel_id") ?: hook.channelId, j.str("id"), first.id, first.size, ex)
                        }
                    }
                }
            } catch (e: java.io.IOException) {
                lastErr = e
            }
            stats.retries.incrementAndGet()
            Thread.sleep(minOf(30_000L, 500L shl attempt))
        }
        throw lastErr ?: IllegalStateException("webhook post failed")
    }

    fun delete(hook: Vault.Webhook, messageId: String) {
        http.newCall(Request.Builder().url(map(hook.url) + "/messages/$messageId").delete().build()).execute().close()
    }

    private companion object {
        val OCTET = "application/octet-stream".toMediaType()
    }
}

/**
 * Upload of one file into the account (the phone's MetadataClient.upload). Thread-safe per call; the sync
 * (the index) is touched only through [commit] and [leaseGuard], which the caller routes to the index thread.
 */
class FileWriter(
    private val writer: DiscordWriter,
    private val api: InstanceApi,
    /** Webhooks that take new pieces (not retired); read at each call (the vault may change). */
    private val writable: () -> List<Vault.Webhook>,
    /** Submit an operation (rule 10: after catching up) and return its result (on the index thread). */
    private val commit: (JsonObject) -> JsonObject,
    private val parallel: Int = 4,
    private val chunkSize: Int = FileWrite.CHUNK,
    private val now: () -> Long = System::currentTimeMillis,
) {
    data class Result(val nodeId: String, val uploadId: String, val manifestRef: String, val sha256: String, val size: Long, val name: String, val chunks: Int, val outcome: String)

    companion object {
        /** Webhook IDs that answered 401 / 404 in this process (removed on Discord). */
        val dead: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()
    }

    class Cancelled : Exception("upload cancelled")

    /**
     * Post on the next channel; a webhook removed on Discord (401 / 404) is marked dead for this process
     * (`dead`, shared by every writer: the vault still lists it until someone removes it) and the post goes to
     * another channel.
     */
    private fun postAny(filename: String, data: ByteArray, extras: List<Pair<String, ByteArray>> = emptyList()): Pair<Vault.Webhook, DiscordWriter.Posted> {
        while (true) {
            val hook = nextHook()
            try {
                return hook to writer.post(hook, filename, data, extras)
            } catch (e: ServerException) {
                if (e.status != 401 && e.status != 404) throw e
                dead += hook.id
            }
        }
    }

    private var rr = 0

    @Synchronized private fun nextHook(): Vault.Webhook {
        val listed = writable()
        if (listed.isEmpty()) throw IllegalStateException("need_channel: no active channel to post to")
        // Webhooks Discord answered 401/404 for (removed there) are skipped while others remain.
        val all = listed.filter { it.id !in dead }
        if (all.isEmpty()) throw IllegalStateException("need_channel: every channel of the account answered 'unknown webhook' (removed on Discord); remove them from the account and add a working one")
        // Round-robin over channels (webhooks of one channel share its limit).
        val byChannel = all.groupBy { it.channelId.ifEmpty { it.id } }.values.toList()
        val group = byChannel[rr % byChannel.size]
        return group[(rr++ / byChannel.size) % group.size]
    }

    /**
     * Upload `size` bytes from `open()` (opened once, read in order) as `name` into `parentId`.
     * `pictures` (thumbnail, preview) go with the manifest; a bad one is left out. `progress(sent, total)`;
     * `cancelled()` is checked between fragments.
     */
    fun upload(
        open: () -> InputStream,
        size: Long,
        name: String,
        parentId: String = "root",
        pictures: List<FileWrite.Picture> = emptyList(),
        progress: (Long, Long) -> Unit = { _, _ -> },
        cancelled: () -> Boolean = { false },
    ): Result {
        val nfc = Normalizer.normalize(name, Normalizer.Form.NFC)
        val uploadId = OpCodec.newId()
        val nodeId = OpCodec.newId()
        if (!api.renewLease(uploadId)) throw IllegalStateException("lease refused")
        // Messages posted for this upload: deleted again when it fails before the commit (nothing refers to them).
        val posted = java.util.Collections.synchronizedList(ArrayList<Pair<Vault.Webhook, String>>())
        var committed = false
        var lastRenew = now()
        val renew = {
            synchronized(this) {
                if (now() - lastRenew >= 60_000) {
                    lastRenew = now()
                    if (!api.renewLease(uploadId)) throw IllegalStateException("upload lease lost")
                }
            }
        }
        try {
            val begin = commit(buildJsonObject { put("type", "upload_begin"); put("uploadId", uploadId) })
            if (begin.strOrNull("outcome") != "applied") throw IllegalStateException("upload_begin: ${begin.strOrNull("outcome")}")
            val fileKey = randomBytes(32)
            val ck = FileFormat.contentKey(fileKey)
            val count = maxOf(1, ((size + chunkSize - 1) / chunkSize).toInt())
            val chunks = arrayOfNulls<JsonObject>(count)
            val md = MessageDigest.getInstance("SHA-256")
            val sent = AtomicLong()
            val pool = Executors.newFixedThreadPool(parallel)
            val done = ExecutorCompletionService<Unit>(pool)
            var read = 0L
            try {
                open().use { input ->
                    var inFlight = 0
                    for (i in 0 until count) {
                        if (cancelled()) throw Cancelled()
                        // Read in order (the whole-file hash takes the plaintext in order), post in parallel.
                        val n = minOf(chunkSize.toLong(), size - read).toInt()
                        val plain = ByteArray(n)
                        var off = 0
                        while (off < n) { val r = input.read(plain, off, n - off); if (r < 0) throw IllegalStateException("file shorter than $size bytes"); off += r }
                        read += n
                        md.update(plain)
                        while (inFlight >= parallel) { done.take().get(); inFlight-- }
                        done.submit {
                            renew()
                            val ct = Aes.encrypt(ck, plain)
                            val hash = sha256Hex(ct)
                            val blobId = OpCodec.newId()
                            val (hook, p) = postAny(blobId + FileWrite.BLOB_EXT, ct)
                            posted += hook to p.messageId
                            chunks[i] = buildJsonObject {
                                put("index", i); put("blobId", blobId); put("ciphertextSizeBytes", ct.size); put("ciphertextHash", hash)
                                put("placements", buildJsonArray { add(placement(p)) })
                            }
                            progress(sent.addAndGet(n.toLong()), size)
                        }
                        inFlight++
                    }
                    while (inFlight > 0) { done.take().get(); inFlight-- }
                    if (input.read() >= 0) throw IllegalStateException("file longer than $size bytes (changed while uploading?)")
                }
            } catch (e: java.util.concurrent.ExecutionException) {
                throw e.cause ?: e
            } finally {
                // Posts in flight finish (not interrupted): what they posted is then in `posted` and is deleted
                // on a failure or a cancel, instead of a message landing on Discord after the clean-up.
                pool.shutdown()
                if (!pool.awaitTermination(3, java.util.concurrent.TimeUnit.MINUTES)) pool.shutdownNow()
            }
            val sha = md.digest().joinToString("") { "%02x".format(it) }
            val manifest = buildJsonObject {
                put("schemaVersion", FileWrite.MANIFEST_SCHEMA); put("chunkSizeBytes", chunkSize)
                put("chunks", JsonArray(chunks.map { it!! }))
            }
            val mct = Aes.encrypt(ck, json.encodeToString(JsonObject.serializer(), manifest).toByteArray(Charsets.UTF_8))
            val keys = FileFormat.PreviewKeys(fileKey)
            val extras = pictures.filter(FileWrite::pictureOk).distinctBy { it.kind }.map { p -> FileWrite.sealPicture(keys, p).let { (n, d) -> n + FileWrite.BLOB_EXT to d } }
            renew()
            val (mhook, mp) = postAny(OpCodec.newId() + FileWrite.BLOB_EXT, mct, extras)
            posted += mhook to mp.messageId
            val ref = FileWrite.encodeManifestRef(fileKey, mp.webhookId, mp.channelId, mp.messageId, mp.attachmentId)
            // Rules v3: pieces per location (fragments + the manifest), sorted by location.
            val per = sortedMapOf<String, Pair<Int, Long>>()
            for (c in chunks) {
                val loc = c!!.getValue("placements").jsonArray[0].jsonObject.str("locationId")
                val (n, b) = per[loc] ?: (0 to 0L)
                per[loc] = (n + 1) to (b + c.getValue("ciphertextSizeBytes").jsonPrimitive.long)
            }
            per[mp.webhookId] = ((per[mp.webhookId]?.first ?: 0) + 1) to ((per[mp.webhookId]?.second ?: 0L) + mct.size)
            val content = buildJsonObject {
                put("versionId", OpCodec.newId()); put("uploadId", uploadId); put("sizeBytes", size); put("manifestRef", ref)
                put("chunkCount", count); put("plaintextSha256", sha)
                put("pieces", buildJsonArray { per.forEach { (loc, x) -> add(buildJsonObject { put("loc", loc); put("n", x.first); put("bytes", x.second) }) } })
            }
            renew()
            committed = true
            val r = commit(buildJsonObject {
                put("type", "group")
                put("ops", buildJsonArray {
                    add(buildJsonObject { put("type", "upload_commit"); put("uploadId", uploadId) })
                    add(buildJsonObject { put("type", "create"); put("kind", "file"); put("nodeId", nodeId); put("parentId", parentId); put("name", nfc); put("content", content) })
                })
            })
            val outcome = r.strOrNull("outcome") ?: "?"
            if (outcome != "applied") throw IllegalStateException("upload_commit+create: $outcome")
            return Result(nodeId, uploadId, ref, sha, size, nfc, count, outcome)
        } catch (e: Exception) {
            if (!committed) for ((h, m) in posted.toList()) runCatching { writer.delete(h, m) }
            throw e
        } finally {
            runCatching { api.releaseLease(uploadId) }
        }
    }

    private fun placement(p: DiscordWriter.Posted) = buildJsonObject {
        put("provider", Discord.PROVIDER); put("locationId", p.webhookId); put("channelId", p.channelId); put("messageId", p.messageId); put("attachmentId", p.attachmentId)
    }
}
