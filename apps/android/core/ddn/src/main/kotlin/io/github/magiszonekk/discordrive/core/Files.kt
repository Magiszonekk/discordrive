package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import java.io.OutputStream
import java.security.MessageDigest
import java.util.Collections
import java.util.LinkedHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Reading files on the phone (any storage mode, see BlobSource), in the formats of packages/metadata-client:
 *  - manifestRef "ddn1:[1, format, fileKey, webhookId, channelId, messageId, attachmentId]" (the file key
 *    travels only inside the encrypted tree);
 *  - manifest and fragments: iv(12) || AES-256-GCM with the content key HKDF(fileKey, "ddv4-file-content-v1");
 *  - thumbnails / previews: extra attachments of the manifest's message, named HMAC(name key, kind), sealed
 *    with HKDF(fileKey, "ddv4-file-preview-v1"); plaintext "DDPV" | 1 | kind | w u16 | h u16 | mime | bytes.
 */
object FileFormat {
    const val FRAGMENT_FORMAT = 1
    const val PREVIEW_FORMAT = 1
    private val MAGIC = byteArrayOf(0x44, 0x44, 0x50, 0x56)
    private val MIMES = setOf("image/webp", "image/jpeg", "image/png")
    const val PREVIEW_READ_MAX = 1024 * 1024

    data class Location(val format: Int, val fileKey: ByteArray, val webhookId: String, val channelId: String, val messageId: String, val attachmentId: String)

    fun decodeManifestRef(ref: String): Location {
        if (ref.startsWith("ddn2:")) throw IllegalArgumentException("storage backend other than Discord: not supported on the phone yet")
        require(ref.startsWith("ddn1:")) { "unknown manifestRef format" }
        val a = json.parseToJsonElement(ref.substring(5)).jsonArray
        require(a.size == 7 && a[0].jsonPrimitive.content == "1") { "bad manifestRef" }
        val key = B64.dec(a[2].jsonPrimitive.content)
        require(key.size == 32) { "file key must be 32 bytes" }
        return Location(a[1].jsonPrimitive.content.toInt(), key, a[3].jsonPrimitive.content, a[4].jsonPrimitive.content, a[5].jsonPrimitive.content, a[6].jsonPrimitive.content)
    }

    fun contentKey(fileKey: ByteArray): ByteArray = Hkdf.derive(fileKey, "ddv4-file-content-v1")

    data class Chunk(val index: Int, val size: Long, val sha256: String?, val webhookId: String, val messageId: String, val attachmentId: String, val channelId: String = "")
    /** `takenAt`: when the content was made (a photo's date, a file's mtime), if the uploader stored it. */
    data class Manifest(val chunkSize: Long, val chunks: List<Chunk>, val takenAt: Long? = null)

    fun openManifest(fileKey: ByteArray, sealed: ByteArray): Manifest {
        val m = json.parseToJsonElement(Aes.decrypt(contentKey(fileKey), sealed, null, "manifest").toString(Charsets.UTF_8)).jsonObject
        val chunks = m.getValue("chunks").jsonArray.map { c ->
            val o = c.jsonObject
            val p = (o["placements"] as? JsonArray)?.firstOrNull()?.jsonObject ?: throw IllegalStateException("fragment without a location")
            if (p.strOrNull("provider") != Discord.PROVIDER) throw IllegalStateException("storage backend ${p.strOrNull("provider")} not supported on the phone yet")
            Chunk(o.getValue("index").jsonPrimitive.content.toInt(), o.getValue("ciphertextSizeBytes").jsonPrimitive.long, o.strOrNull("ciphertextHash"), p.str("locationId"), p.str("messageId"), p.str("attachmentId"), p.strOrNull("channelId") ?: "")
        }.sortedBy { it.index }
        return Manifest(m.getValue("chunkSizeBytes").jsonPrimitive.long, chunks, m.longOrNull("takenAt")?.takeIf { it > 0 })
    }

    fun openFragment(contentKey: ByteArray, sealed: ByteArray): ByteArray = Aes.decrypt(contentKey, sealed, null, "fragment")

    // ── previews ──

    data class Preview(val kind: Char, val mime: String, val width: Int, val height: Int, val data: ByteArray)

    class PreviewKeys(fileKey: ByteArray) {
        val key: ByteArray = Hkdf.derive(fileKey, "ddv4-file-preview-v1")
        private val nameKey: ByteArray = Hkdf.derive(fileKey, "ddv4-file-preview-name-v1")
        fun name(kind: Char): String {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(nameKey, "HmacSHA256"))
            return B64.encUrl(mac.doFinal("ddn-preview:$kind".toByteArray(Charsets.UTF_8))).substring(0, 22)
        }
    }

    /** Attachment names carry the extension every blob gets; the stored name is without it. */
    fun stripExt(name: String): String = name.lastIndexOf('.').let { if (it > 0) name.substring(0, it) else name }

    /**
     * The name an extra is found by: no extension, no leading underscores. Discord drops leading underscores
     * from attachment names (the names are base64url: about one file in 32 has one); compared this way on both
     * sides, an extra stored under either form is found.
     */
    fun extraKey(name: String): String = stripExt(name).trimStart('_')

    fun openPreview(keys: PreviewKeys, kind: Char, data: ByteArray): Preview {
        require(data.size in (12 + 16 + 12)..PREVIEW_READ_MAX) { "preview: bad size" }
        val p = Aes.decrypt(keys.key, data, null, "preview")
        require(p.size > 11 && p.copyOfRange(0, 4).contentEquals(MAGIC) && p[4].toInt() == PREVIEW_FORMAT) { "preview: unknown format" }
        require(p[5].toInt().toChar() == kind) { "preview: other kind" }
        val w = ((p[6].toInt() and 0xff) shl 8) or (p[7].toInt() and 0xff)
        val h = ((p[8].toInt() and 0xff) shl 8) or (p[9].toInt() and 0xff)
        val ml = p[10].toInt() and 0xff
        val mime = String(p, 11, ml, Charsets.UTF_8)
        val img = p.copyOfRange(11 + ml, p.size)
        require(mime in MIMES && img.isNotEmpty()) { "preview: bad content" }
        return Preview(kind, mime, w, h, img)
    }
}

/**
 * Files of the account on Discord: manifests (cached), thumbnails, ranges and whole downloads, fragments
 * checked against their SHA-256 and decrypted on the phone. Thread-safe; downloads fetch a few fragments
 * at a time.
 */
/**
 * Where a file's stored objects are read from: the account's own webhooks (metadata only: GET the message,
 * then the CDN) or the instance (e2ee / plain: fresh CDN links from it, the instance as a fallback).
 */
interface BlobSource {
    /** One stored object (a manifest or a fragment). */
    fun fetch(webhookId: String, channelId: String, messageId: String, attachmentId: String): ByteArray
    /** The extra objects next to a manifest (thumbnail, preview): stored name (no extension) → reader. */
    fun extras(webhookId: String, channelId: String, messageId: String, manifestAttachmentId: String): Map<String, Pair<Long, () -> ByteArray>>
}

/** Metadata only: the account's own webhooks (from the vault). */
class WebhookSource(private val discord: Discord, private val webhookUrl: (String) -> String) : BlobSource {
    override fun fetch(webhookId: String, channelId: String, messageId: String, attachmentId: String) = discord.fetch(webhookUrl(webhookId), messageId, attachmentId)
    override fun extras(webhookId: String, channelId: String, messageId: String, manifestAttachmentId: String): Map<String, Pair<Long, () -> ByteArray>> =
        discord.attachments(webhookUrl(webhookId), messageId).filter { it.id != manifestAttachmentId }
            .associate { a -> FileFormat.extraKey(a.filename) to (a.size to { discord.download(a.url) }) }
}

/**
 * e2ee / plain: the instance knows the webhooks. Fresh CDN links come from it (kept an hour), the bytes from the
 * CDN; when the CDN cannot be read the instance reads them (its proxy). No webhook URL reaches the phone.
 */
class InstanceSource(private val api: InstanceApi, private val discord: Discord) : BlobSource {
    private val links = java.util.concurrent.ConcurrentHashMap<String, Pair<String, Long>>()

    private fun placement(w: String, c: String, m: String, a: String) = kotlinx.serialization.json.buildJsonObject {
        put("provider", Discord.PROVIDER); put("locationId", w); put("channelId", c); put("messageId", m); put("attachmentId", a)
    }

    private fun read(p: JsonObject): ByteArray {
        val a = p.str("attachmentId")
        val now = System.currentTimeMillis()
        val url = links[a]?.takeIf { it.second > now }?.first ?: api.blobUrls(listOf(p))[a]?.also { links[a] = it to now + 3_600_000 }
        if (url != null) runCatching { return discord.download(url) }.onFailure { links.remove(a) }
        return api.blobProxy(p)
    }

    override fun fetch(webhookId: String, channelId: String, messageId: String, attachmentId: String) = read(placement(webhookId, channelId, messageId, attachmentId))

    override fun extras(webhookId: String, channelId: String, messageId: String, manifestAttachmentId: String): Map<String, Pair<Long, () -> ByteArray>> =
        api.extras(manifestAttachmentId).entries.associate { (k, p) -> FileFormat.extraKey(k) to ((p.longOrNull("size") ?: 0L) to { read(p) }) }
}

class FileReader(private val src: BlobSource, private val parallel: Int = 4) {
    /** Metadata only (the account's own webhooks). */
    constructor(discord: Discord, webhookUrl: (String) -> String, parallel: Int = 4) : this(WebhookSource(discord, webhookUrl), parallel)

    private val manifests = Collections.synchronizedMap(object : LinkedHashMap<String, FileFormat.Manifest>(64, 0.75f, true) {
        override fun removeEldestEntry(e: MutableMap.MutableEntry<String, FileFormat.Manifest>) = size > 256
    })

    fun manifest(manifestRef: String): Pair<FileFormat.Location, FileFormat.Manifest> {
        val loc = FileFormat.decodeManifestRef(manifestRef)
        require(loc.format == FileFormat.FRAGMENT_FORMAT) { "unsupported fragment format ${loc.format}" }
        val m = manifests[manifestRef] ?: FileFormat.openManifest(loc.fileKey, src.fetch(loc.webhookId, loc.channelId, loc.messageId, loc.attachmentId)).also { manifests[manifestRef] = it }
        return loc to m
    }

    /** The thumbnail ('t') or preview ('p') stored with the version, or null when it has none. */
    fun preview(manifestRef: String, kind: Char): FileFormat.Preview? {
        val loc = FileFormat.decodeManifestRef(manifestRef)
        val keys = FileFormat.PreviewKeys(loc.fileKey)
        val name = keys.name(kind)
        val (size, get) = src.extras(loc.webhookId, loc.channelId, loc.messageId, loc.attachmentId)[FileFormat.extraKey(name)] ?: return null
        if (size > FileFormat.PREVIEW_READ_MAX) return null
        return FileFormat.openPreview(keys, kind, get())
    }

    /** The AI description stored with the version (Describe), or null when it has none. */
    fun description(manifestRef: String): Describe.Record? {
        val loc = FileFormat.decodeManifestRef(manifestRef)
        val (size, get) = src.extras(loc.webhookId, loc.channelId, loc.messageId, loc.attachmentId)[FileFormat.extraKey(Describe.name(loc.fileKey))] ?: return null
        if (size > Describe.MAX_BYTES) return null
        return Describe.open(loc.fileKey, get())
    }

    private fun fragment(contentKey: ByteArray, c: FileFormat.Chunk): ByteArray {
        val ct = src.fetch(c.webhookId, c.channelId, c.messageId, c.attachmentId)
        if (c.sha256 != null && sha256Hex(ct) != c.sha256) throw IllegalStateException("fragment ${c.index}: ciphertext hash mismatch")
        return FileFormat.openFragment(contentKey, ct)
    }

    /** Fragment `index` of the version, decrypted (players read one fragment at a time). */
    fun fragmentPlain(manifestRef: String, index: Int): ByteArray {
        val (loc, m) = manifest(manifestRef)
        return fragment(FileFormat.contentKey(loc.fileKey), m.chunks[index])
    }

    /** Bytes start..end (inclusive) of the version: only the fragments that overlap. */
    fun range(manifestRef: String, size: Long, start: Long, end: Long): ByteArray {
        require(start in 0 until size) { "range start $start outside 0..${size - 1}" }
        val e = minOf(end, size - 1)
        val (loc, m) = manifest(manifestRef)
        val ck = FileFormat.contentKey(loc.fileKey)
        val out = java.io.ByteArrayOutputStream((e - start + 1).toInt())
        for (i in (start / m.chunkSize).toInt()..(e / m.chunkSize).toInt()) {
            val pt = fragment(ck, m.chunks[i])
            val base = i * m.chunkSize
            val from = (maxOf(start, base) - base).toInt()
            val to = (minOf(e, base + pt.size - 1) - base).toInt()
            out.write(pt, from, to - from + 1)
        }
        return out.toByteArray()
    }

    /**
     * The whole version into `out`, in order, `parallel` fragments in flight; checks the plaintext SHA-256
     * when the tree has it. `progress(done, total)` after each fragment written.
     */
    fun download(manifestRef: String, size: Long, plaintextSha256: String?, out: OutputStream, progress: (Long, Long) -> Unit = { _, _ -> }) {
        val (loc, m) = manifest(manifestRef)
        val ck = FileFormat.contentKey(loc.fileKey)
        val md = MessageDigest.getInstance("SHA-256")
        val pool = Executors.newFixedThreadPool(parallel)
        try {
            val ahead = ArrayDeque<Future<ByteArray>>()
            var next = 0
            var done = 0L
            for (i in m.chunks.indices) {
                while (next < m.chunks.size && ahead.size < parallel) {
                    val c = m.chunks[next++]
                    ahead.addLast(pool.submit<ByteArray> { fragment(ck, c) })
                }
                val pt = ahead.removeFirst().get()
                md.update(pt)
                out.write(pt)
                done += pt.size
                progress(done, size)
            }
            if (done != size) throw IllegalStateException("file is $done bytes, the tree says $size")
            if (plaintextSha256 != null && md.digest().joinToString("") { "%02x".format(it) } != plaintextSha256) throw IllegalStateException("file hash mismatch")
        } finally {
            pool.shutdownNow()
        }
    }
}

internal fun JsonObject.longOrNull(k: String): Long? = (this[k] as? JsonPrimitive)?.content?.toLongOrNull()
