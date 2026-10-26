package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * A description of a file made by an AI model the user configured (search by what is on a photo): a short
 * description, tags, the text seen on the picture and, for videos, a transcript. Stored like a thumbnail:
 * one small extra object next to the version's manifest, encrypted with a key from the file key
 * (HKDF "ddv4-file-description-v1"), under a name only holders of the file key can compute
 * (HMAC(HKDF "ddv4-file-preview-name-v1", "ddn-description:1")). Nothing in the tree or the log changes;
 * the instance sees one more small encrypted object.
 * Plaintext: JSON {v:1, description, tags[], text?, transcript?, model, at, lang}.
 */
object Describe {
    const val FORMAT = 1
    const val MAX_BYTES = 64 * 1024

    data class Record(
        val description: String,
        val tags: List<String>,
        val text: String? = null,
        val transcript: String? = null,
        val model: String,
        val at: Long,
        val lang: String = "pl",
    ) {
        /** Case-insensitive search over everything the record holds. */
        fun matches(query: String): Boolean {
            val q = query.trim().lowercase()
            if (q.isEmpty()) return false
            return description.lowercase().contains(q) || tags.any { it.lowercase().contains(q) } ||
                text?.lowercase()?.contains(q) == true || transcript?.lowercase()?.contains(q) == true
        }
    }

    private fun key(fileKey: ByteArray) = Hkdf.derive(fileKey, "ddv4-file-description-v1")

    /** The stored name (without the extension every object gets). */
    fun name(fileKey: ByteArray): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(Hkdf.derive(fileKey, "ddv4-file-preview-name-v1"), "HmacSHA256"))
        return B64.encUrl(mac.doFinal("ddn-description:$FORMAT".toByteArray(Charsets.UTF_8))).substring(0, 22)
    }

    fun seal(fileKey: ByteArray, r: Record): ByteArray {
        val o = buildJsonObject {
            put("v", FORMAT)
            put("description", r.description.take(2000))
            put("tags", JsonArray(r.tags.take(30).map { JsonPrimitive(it.take(60)) }))
            r.text?.let { put("text", it.take(8000)) }
            r.transcript?.let { put("transcript", it.take(20000)) }
            put("model", r.model.take(200))
            put("at", r.at)
            put("lang", r.lang)
        }
        val plain = json.encodeToString(JsonObject.serializer(), o).toByteArray(Charsets.UTF_8)
        val out = Aes.encrypt(key(fileKey), plain, "ddn-description-v$FORMAT".toByteArray())
        require(out.size <= MAX_BYTES) { "description too large" }
        return out
    }

    fun open(fileKey: ByteArray, data: ByteArray): Record {
        require(data.size in 29..MAX_BYTES) { "description: bad size" }
        val o = json.parseToJsonElement(Aes.decrypt(key(fileKey), data, "ddn-description-v$FORMAT".toByteArray(), "description").toString(Charsets.UTF_8)).jsonObject
        require(o["v"]?.jsonPrimitive?.content == FORMAT.toString()) { "description: unknown format" }
        return Record(
            description = o.strOrNull("description") ?: "",
            tags = (o["tags"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList(),
            text = o.strOrNull("text"),
            transcript = o.strOrNull("transcript"),
            model = o.strOrNull("model") ?: "",
            at = o.longOrNull("at") ?: 0,
            lang = o.strOrNull("lang") ?: "pl",
        )
    }

    // ── the AI settings of the account (in the encrypted vault, so other devices can use them) ──

    data class AiConfig(val url: String, val key: String, val model: String) {
        /** The key is never printed (logs, reports). */
        override fun toString() = "AiConfig(url=$url, model=$model, key=***)"
    }

    fun configOf(vault: JsonObject): AiConfig? = (vault["ai"] as? JsonObject)?.let { a ->
        val u = a.strOrNull("url") ?: return null
        AiConfig(u, a.strOrNull("key") ?: "", a.strOrNull("model") ?: "")
    }

    /** The vault with the AI settings set (null: removed); every other field is kept. */
    fun withConfig(vault: JsonObject, c: AiConfig?): JsonObject =
        JsonObject(vault.filterKeys { it != "ai" } + (if (c != null) mapOf("ai" to buildJsonObject { put("url", c.url); put("key", c.key); put("model", c.model) }) else emptyMap()))
}

class SettingsRollbackException(seen: Long, got: Long) : Exception("account settings went back from revision $seen to $got: refusing")

/**
 * Settings of the account shared by its devices, in every mode (packages/metadata-client account-settings.ts):
 * JSON {format:"ddn-account-settings", version:1, ai?:{url,key,model}, …} sealed with the account subkey
 * "settings" (AAD "ddn-settings-v1|account|revision"), stored on the instance with a compare-and-swap.
 * Unknown fields are kept.
 */
class AccountSettings(private val api: InstanceApi, private val key: AccountKey, private val accountId: String, var seenRevision: Long = 0) {
    private var revision = 0L
    var content: JsonObject = empty()
        private set

    private fun aad(rev: Long) = "ddn-settings-v1|$accountId|$rev"

    private fun open(rev: Long, blob: ByteArray?): JsonObject {
        if (rev < seenRevision) throw SettingsRollbackException(seenRevision, rev)
        val v = if (blob == null) empty() else Seal.unsealJson(key.subkey("settings"), blob, aad(rev), "account settings").jsonObject
        require(v.strOrNull("format") == FORMAT && v["version"]?.jsonPrimitive?.content == "1") { "unsupported account settings format" }
        seenRevision = rev; revision = rev; content = v
        return v
    }

    fun load(): JsonObject = api.settings().let { (r, b) -> open(r, b) }

    fun update(change: (JsonObject) -> JsonObject): JsonObject {
        load()
        repeat(5) {
            val next = change(content)
            val rev = revision + 1
            val won = api.putSettings(revision, rev, Seal.sealJson(key.subkey("settings"), next, aad(rev)))
            if (won == null) { seenRevision = rev; revision = rev; content = next; return next }
            open(won.first, won.second)
        }
        throw IllegalStateException("account settings: too many concurrent edits")
    }

    companion object {
        const val FORMAT = "ddn-account-settings"
        fun empty(): JsonObject = buildJsonObject { put("format", FORMAT); put("version", 1) }
    }
}

/**
 * Adds an extra object to a version already stored (a description made later). Metadata only: the
 * manifest's message is edited, keeping its attachments by ID (measured on Discord: kept byte for byte);
 * e2ee / plain: the instance stores it as blob "x<name>" of the version's upload. Returns false when the
 * version already has an object of that name (another device was first).
 */
class ExtraWriter(
    private val http: OkHttpClient = defaultHttp(),
    private val apiOrigin: String? = null,
) {
    private fun map(url: String): String = apiOrigin?.let { url.replace(Regex("^https://(?:ptb\\.|canary\\.)?discord(?:app)?\\.com"), it) } ?: url

    fun addToMessage(discord: Discord, webhookUrl: String, messageId: String, name: String, data: ByteArray): Boolean {
        val now = discord.attachments(webhookUrl, messageId)
        if (now.any { FileFormat.extraKey(it.filename) == FileFormat.extraKey(name) }) return false
        require(now.size < 10) { "the message has no room for another attachment" }
        val fname = name + FileWrite.BLOB_EXT
        val payload = buildJsonObject {
            put("attachments", JsonArray(now.map { buildJsonObject { put("id", it.id) } } + buildJsonObject { put("id", 0); put("filename", fname) }))
        }
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("payload_json", null, json.encodeToString(JsonObject.serializer(), payload).toRequestBody("application/json".toMediaType()))
            .addFormDataPart("files[0]", fname, data.toRequestBody("application/octet-stream".toMediaType()))
            .build()
        for (attempt in 0 until 5) {
            http.newCall(Request.Builder().url(map(webhookUrl) + "/messages/$messageId").patch(body).build()).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (res.isSuccessful) {
                    val atts = (json.parseToJsonElement(text).jsonObject["attachments"] as? JsonArray)?.map { it.jsonObject.str("id") } ?: emptyList()
                    if (now.any { it.id !in atts }) throw IllegalStateException("message edit dropped an attachment")
                    return true
                }
                if (res.code != 429 && res.code < 500) throw ServerException(res.code, "discord edit")
                val ra = if (res.code == 429) DiscordRateLimit.wait({ res.header(it) }, text).seconds else 1.0
                Thread.sleep((ra.coerceIn(0.2, 30.0) * 1000).toLong() + (500L shl attempt) + DiscordRateLimit.jitterMs())
            }
        }
        throw ServerException(429, "discord edit")
    }

    fun addThroughInstance(api: InstanceApi, uploadId: String, name: String, data: ByteArray): Boolean {
        val p = api.putBlobResult(uploadId, "x$name", data, sha256Hex(data))
        return !p.second
    }
}

/** A failure of the AI endpoint: kind "auth" (key refused), "rate" (429, retryAfterS), "http", "parse", "net". */
class AiException(val kind: String, message: String, val retryAfterS: Long = 0) : Exception(message)

/**
 * The user's AI endpoint in the OpenAI format (`/v1/chat/completions` with an image, `/v1/models`): one
 * downscaled picture in, a description, tags and the text seen on it out. The base URL may end with /v1 or not.
 */
class AiDescriber(baseUrl: String, private val key: String, val model: String, private val http: OkHttpClient = defaultHttp()) {
    private val base = baseUrl.trim().trimEnd('/').let { if (it.endsWith("/v1")) it else "$it/v1" }

    private fun prompt(lang: String) = if (lang == "pl")
        "Opisz obraz do wyszukiwania w galerii. Odpowiedz TYLKO czystym JSON bez markdown: " +
            """{"description":"1-2 zdania po polsku, co przedstawia","tags":["6-10 krótkich tagów po polsku, małymi literami"],"text":"tekst widoczny na obrazie dosłownie albo pusty"}"""
    else
        "Describe the picture for gallery search. Answer ONLY with plain JSON, no markdown: " +
            """{"description":"1-2 sentences, what it shows","tags":["6-10 short lowercase tags"],"text":"text visible on the picture verbatim, or empty"}"""

    private fun req(path: String) = Request.Builder().url(base + path).header("Authorization", "Bearer $key")

    private fun fail(code: Int, retryAfter: String?, text: String): Nothing = when (code) {
        401, 403 -> throw AiException("auth", "AI: the key was refused (HTTP $code)")
        429 -> throw AiException("rate", "AI: rate limited", retryAfter?.toLongOrNull() ?: 30)
        else -> throw AiException("http", "AI: HTTP $code ${text.take(200)}")
    }

    fun models(): List<String> {
        val res = try { http.newCall(req("/models").get().build()).execute() } catch (e: java.io.IOException) { throw AiException("net", "AI: ${e.message}") }
        res.use {
            val text = it.body?.string().orEmpty()
            if (!it.isSuccessful) fail(it.code, it.header("retry-after"), text)
            val root = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: throw AiException("parse", "AI: no model list")
            val list = (root["data"] ?: root["models"]) as? JsonArray ?: throw AiException("parse", "AI: no model list")
            return list.mapNotNull { (it as? JsonObject)?.strOrNull("id") }.sorted()
        }
    }

    /** One picture (JPEG) → its description. */
    fun describe(jpeg: ByteArray, lang: String = "pl", hint: String? = null, now: Long = System.currentTimeMillis()): Describe.Record {
        val body = buildJsonObject {
            put("model", model)
            put("max_tokens", 1024)
            put("messages", JsonArray(listOf(buildJsonObject {
                put("role", "user")
                put("content", JsonArray(listOf(
                    buildJsonObject { put("type", "text"); put("text", (if (!hint.isNullOrBlank()) "$hint\n" else "") + prompt(lang)) },
                    buildJsonObject { put("type", "image_url"); put("image_url", buildJsonObject { put("url", "data:image/jpeg;base64," + B64.enc(jpeg)) }) },
                )))
            })))
        }
        val res = try {
            http.newCall(req("/chat/completions").post(json.encodeToString(JsonObject.serializer(), body).toRequestBody("application/json".toMediaType())).build()).execute()
        } catch (e: java.io.IOException) { throw AiException("net", "AI: ${e.message}") }
        res.use {
            val text = it.body?.string().orEmpty()
            if (!it.isSuccessful) fail(it.code, it.header("retry-after"), text)
            val content = runCatching {
                json.parseToJsonElement(text).jsonObject.getValue("choices").jsonArray[0].jsonObject.getValue("message").jsonObject.getValue("content").jsonPrimitive.content
            }.getOrNull() ?: throw AiException("parse", "AI: an answer without a message")
            return parse(content, model, lang, now)
        }
    }

    companion object {
        /**
         * The model's JSON, tolerant: fences and prose around it, an answer cut off mid-JSON (the description and
         * the complete tags are kept). Nothing usable → AiException("parse").
         */
        fun parse(content: String, model: String, lang: String = "pl", now: Long = 0): Describe.Record {
            val s = content.indexOf('{'); val e = content.lastIndexOf('}')
            if (s >= 0 && e > s) runCatching { json.parseToJsonElement(content.substring(s, e + 1)).jsonObject }.getOrNull()?.let { o ->
                val d = (o["description"] as? kotlinx.serialization.json.JsonPrimitive)?.content.orEmpty().trim()
                val tags = (o["tags"] as? JsonArray)?.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.trim()?.lowercase()?.takeIf { t -> t.isNotEmpty() } } ?: emptyList()
                val t = (o["text"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.trim()?.takeIf { it.isNotEmpty() }
                if (d.isNotEmpty() || tags.isNotEmpty()) return Describe.Record(d, tags.distinct(), t, model = model, at = now, lang = lang)
            }
            fun field(k: String) = Regex("\"$k\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)").find(content)?.groupValues?.get(1)?.replace("\\\"", "\"")?.replace("\\n", " ")?.trim().orEmpty()
            val d = field("description")
            val tags = Regex("\"((?:[^\"\\\\]|\\\\.)+)\"").findAll(content.substringAfter("\"tags\"", "").substringAfter('[', "").substringBefore(']'))
                .map { it.groupValues[1].lowercase() }.toList()
            if (d.isEmpty() && tags.isEmpty()) throw AiException("parse", "AI: no description in the answer: ${content.take(120)}")
            return Describe.Record(d, tags.distinct(), field("text").ifEmpty { null }, model = model, at = now, lang = lang)
        }
    }
}

/**
 * Search over the account's files on the phone: names, dates and the AI descriptions (description, tags, the
 * text on the picture, a transcript). Case and Polish diacritics do not matter ("zolty" finds "żółty"); every
 * word of the query must be found somewhere in the file's text (name + description); a word that is a year
 * ("2024"), a year-month ("2024-05") or a day ("2024-05-17") matches the file's date instead.
 */
object Search {
    private val marks = Regex("\\p{Mn}+")

    fun fold(s: String): String = java.text.Normalizer.normalize(s.lowercase().replace('ł', 'l'), java.text.Normalizer.Form.NFD).replace(marks, "")

    data class Item(val id: String, val name: String, val createdAt: Long, val record: Describe.Record?)

    private val dateWord = Regex("^(\\d{4})(?:-(\\d{2})(?:-(\\d{2}))?)?$")

    /** Results best first: more words in the name and the description, then newer. */
    fun run(items: List<Item>, query: String, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): List<Item> {
        val words = fold(query).split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return emptyList()
        val scored = ArrayList<Pair<Item, Int>>()
        for (it in items) {
            val name = fold(it.name)
            val r = it.record
            val desc = if (r == null) "" else fold(r.description + " " + r.tags.joinToString(" ") + " " + (r.text ?: "") + " " + (r.transcript ?: ""))
            val day = if (it.createdAt > 0) java.time.Instant.ofEpochMilli(it.createdAt).atZone(zone).toLocalDate() else null
            var score = 0
            var all = true
            for (w in words) {
                val d = dateWord.find(w)
                val hit = when {
                    d != null && day != null -> {
                        val (y, m, dd) = d.destructured
                        day.year == y.toInt() && (m.isEmpty() || day.monthValue == m.toInt()) && (dd.isEmpty() || day.dayOfMonth == dd.toInt())
                    }
                    else -> false
                }
                val inName = name.contains(w)
                val inDesc = desc.contains(w)
                if (!(hit || inName || inDesc)) { all = false; break }
                score += (if (inName) 3 else 0) + (if (r != null && r.tags.any { t -> fold(t) == w }) 2 else 0) + (if (inDesc) 1 else 0) + (if (hit) 1 else 0)
            }
            if (all) scored += it to score
        }
        return scored.sortedWith(compareByDescending<Pair<Item, Int>> { it.second }.thenByDescending { it.first.createdAt }).map { it.first }
    }
}
