package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import java.text.Normalizer
import java.util.TimeZone

/**
 * One JavaScript context (the sync core runs in it). [evaluate] runs a script and returns the value of its
 * last expression as a string (null for undefined/null); globals persist. Blocks: never on the main thread.
 * Implementations (in :syncjs): the WebView's V8 sandbox, QuickJS.
 */
interface JsEngine : AutoCloseable {
    /** Short label for logs and measurements, e.g. "quickjs" or "v8-sandbox". */
    val name: String
    fun evaluate(script: String): String?
}

class JsEngineException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

/** Rules 4: the root of the account's Gallery (a second space next to the Drive, "root"). */
const val GALLERY_ID = "gallery"

/** The local index: the sync core's tree, fed with a snapshot and log entries (implemented in the JS engine). */
interface IndexReplica : AutoCloseable {
    /** Rules version of the operations this device writes. */
    val rulesVersion: Int
    val headSeq: Long
    fun reset()
    /**
     * A sync-core IndexSnapshot as JSON text in slices (a base of a large account is tens of MB: it goes to
     * the engine as text and is parsed there). Returns the snapshot's headSeq.
     */
    fun loadSnapshotText(slices: Sequence<String>): Long
    /** Decrypted log entries in order, from headSeq + 1. */
    fun apply(entries: List<JsonObject>): ApplySummary
    /** Uploads an operation touches (its lease guard). */
    fun leaseGuard(op: JsonObject): List<String>
    /** SHA-256 (hex) of the canonical state: identical on every device at the same headSeq. */
    fun stateSha256(): String
    /** Children of a folder that are not in the trash: folders first, then by name. */
    fun children(parentId: String): List<Child>

    /**
     * Files whose name ends with one of `extensions` (lower case, with the dot), anywhere outside the
     * trash, newest version first: the Gallery. `limit` per call, `after` = the createdAt/id of the last one.
     */
    fun media(extensions: List<String>, limit: Int, after: Pair<Long, String>? = null, space: String? = null): List<Child> = emptyList()

    /**
     * Rules 4 (the Gallery): the rules version an operation is written with: 4 when it touches the Gallery (its
     * root, a node in it, a `space` field), else what this device writes ([rulesVersion]).
     */
    fun rulesVersionFor(op: JsonObject): Int = rulesVersion

    /** The space a node is in: "gallery" (under the Gallery's root) or "drive" (also for an unknown node). */
    fun spaceOf(id: String): String = "drive"

    /** The whole index as a sync-core IndexSnapshot in JSON text slices (a local copy for a fast start). */
    fun snapshotText(): Sequence<String> = throw UnsupportedOperationException("snapshotText")

    /** One node (null when unknown); [Child.trashedAt] is set when it is in the trash (0: inside a trashed folder). */
    fun node(id: String): Child? = null

    /**
     * The trash: nodes trashed themselves (not those inside a trashed folder), newest first, with the server
     * time of the trash (the 30-day clock, [Child.trashedAt]).
     */
    fun trash(): List<Child> = emptyList()

    /**
     * Albums: folders with media files (by `extensions`) right inside them, outside the trash, the newest
     * first; with the count and the newest file (the cover).
     */
    fun albums(extensions: List<String>, space: String? = null): List<Album> = emptyList()

    data class Album(val id: String, val name: String, val count: Int, val cover: Child)

    /** Uploads released (purged / superseded) after `afterSeq`: (uploadId, server time of the release, seq). */
    fun released(afterSeq: Long): List<Triple<String, Long, Long>> = emptyList()

    /** Trashed nodes whose 30 days (server time `nowServerMs`) are over (sync-core expiredTrash). */
    fun expiredTrash(nowServerMs: Long): List<String> = emptyList()

    /**
     * A node. Files: size, version (manifestRef: where the manifest is and the file key, secret), plaintext
     * SHA-256 if known, when the version was written.
     */
    data class Child(
        val id: String,
        val name: String,
        val kind: String,
        val size: Long?,
        val manifestRef: String? = null,
        val sha256: String? = null,
        val createdAt: Long = 0,
        val parentId: String? = null,
        /** Server time of the trash operation (only in [trash]). */
        val trashedAt: Long? = null,
        /** The upload holding this version (e2ee / plain: extras added later go to it). */
        val uploadId: String? = null,
    ) {
        val isFolder: Boolean get() = kind == "folder"
    }
    data class ApplySummary(val headSeq: Long, val outcomes: Map<String, Int>, val results: List<JsonObject>)
}

/**
 * The phone's side of an account in metadata only: the vault (read with a rollback check, edited by
 * compare-and-swap), joining from the snapshot on the storage backends (base + the log after it from the
 * instance, so a large account is not replayed from the first operation), pulling and submitting operations.
 */
class AccountSync(
    val acct: AccountState,
    val api: InstanceApi,
    val discord: Discord,
    val replica: IndexReplica,
    /** Highest vault revision this phone has seen (persist it). */
    var vaultRevision: Long = 0,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val key = acct.key
    /** Plain mode: the server reads the operations; otherwise they are sealed with the account key. */
    private val codec: LogCodec = if (acct.mode == AccountState.MODE_PLAIN) PlainCodec(acct.accountId) else OpCodec(key, acct.accountId)
    var vault: JsonObject = Vault.empty()
        private set

    fun loadVault(): JsonObject {
        // e2ee / plain: the instance holds the webhooks; there is no vault of the account's own.
        if (acct.serverBlobs) return vault
        val (rev, blob) = api.vault()
        return accept(rev, blob)
    }

    private fun accept(rev: Long, blob: ByteArray?): JsonObject {
        if (rev < vaultRevision) throw VaultRollbackException(vaultRevision, rev)
        vault = if (blob == null) Vault.empty() else Vault.open(key, acct.accountId, rev, blob)
        vaultRevision = rev
        return vault
    }

    /** Apply `change` to the newest vault and store it; on a concurrent edit re-read and apply again. */
    fun updateVault(change: (JsonObject) -> JsonObject): JsonObject {
        loadVault()
        repeat(5) {
            val next = change(vault)
            val cur = api.putVault(vaultRevision, vaultRevision + 1, Vault.seal(key, acct.accountId, vaultRevision + 1, next))
            if (cur == null) {
                vaultRevision += 1
                vault = next
                return next
            }
            accept(cur.first, cur.second)
        }
        throw IllegalStateException("vault update: too many concurrent edits")
    }

    private fun hookUrl(id: String): String =
        Vault.webhooks(vault).firstOrNull { it.id == id }?.url ?: throw IllegalStateException("webhook $id not in vault")

    private fun fetchRef(r: Snapshots.ObjRef): ByteArray {
        if (r.other != null) throw IllegalStateException("storage backend ${r.other["provider"]} is not supported on the phone yet")
        return discord.fetch(hookUrl(r.webhookId), r.messageId, r.attachmentId)
    }

    /**
     * `snapshotSkipped`: why the snapshot could not be read (its channel removed on Discord, …); the index then
     * comes from the whole log on the instance (slower, the same state).
     */
    data class JoinReport(val pointerToSeq: Long, val baseHeadSeq: Long, val tailEntries: Int, val headSeq: Long, val ms: Long, val snapshotSkipped: String? = null)

    /** Fresh index: the newest base from the pointer (if any), then the log after it. */
    fun join(): JoinReport {
        val t0 = now()
        loadVault()
        replica.reset()
        // e2ee / plain: the snapshot chain is the instance's (written with its own key, on its channels): the
        // phone replays the log from the instance (the server compacts it, rewriteChain).
        if (acct.serverBlobs) {
            val n = pull()
            return JoinReport(0, 0, n, replica.headSeq, now() - t0)
        }
        var toSeq = 0L
        var baseHead = 0L
        var skipped: String? = null
        Vault.pointer(vault)?.let { (hook, msg) ->
            try {
                val p = Snapshots.openPointer(key, acct.accountId, discord.fetch(hookUrl(hook), msg))
                toSeq = p.toSeq
                p.base?.let { b ->
                    val head = replica.loadSnapshotText(Snapshots.baseSlices(key, acct.accountId, b, ::fetchRef))
                    if (head != b.headSeq) throw IllegalStateException("base headSeq mismatch ($head, pointer says ${b.headSeq})")
                    baseHead = b.headSeq
                }
            } catch (e: Exception) {
                // The snapshot is only a shortcut: the log on the instance holds every operation. A pointer or
                // base that cannot be read (e.g. its webhook removed on Discord) must not leave the device empty.
                if (e is VaultRollbackException) throw e
                skipped = e.message ?: e.javaClass.simpleName
                toSeq = 0; baseHead = 0
                replica.reset()
            }
        }
        val n = pull()
        return JoinReport(toSeq, baseHead, n, replica.headSeq, now() - t0, skipped)
    }

    /** Everything new from the instance, decrypted here, applied in the engine. Returns the number of entries. */
    fun pull(): Int {
        var n = 0
        while (true) {
            val batch = api.read(replica.headSeq, 1000)
            if (batch.isEmpty()) return n
            observe(replica.apply(batch.map(codec::decrypt).also { seen(it) }), batch)
            n += batch.size
        }
    }

    /**
     * Submit one operation (rule 10: after catching up) and pull until it is applied. Returns its result
     * (outcome + notices). Names in operations are NFC (the rules compare them as they are).
     */
    fun commit(op0: JsonObject): JsonObject {
        pull()
        val op = withSpace(op0)
        val createdAt = now()
        val lg = replica.leaseGuard(op)
        val env = buildJsonObject {
            put("opId", OpCodec.newId())
            put("rulesVersion", replica.rulesVersionFor(op))
            put("baseSeq", replica.headSeq)
            put("device", buildJsonObject { put("id", acct.deviceId); put("name", acct.deviceName) })
            put("createdAt", createdAt)
            put("tzOffsetMin", TimeZone.getDefault().getOffset(createdAt) / 60_000)
            if (lg.isNotEmpty()) put("leaseGuard", JsonArray(lg.map { JsonPrimitive(it) }))
            put("op", op)
        }
        val r = api.submit(codec.encrypt(env))
        val status = r.strOrNull("status")
        if (status != "accepted" && status != "duplicate") throw IllegalStateException("operation refused: $status")
        val seq = r.getValue("entry").jsonObject.getValue("seq").jsonPrimitive.long
        var mine: JsonObject? = null
        while (replica.headSeq < seq) {
            val batch = api.read(replica.headSeq, 1000)
            if (batch.isEmpty()) break
            val dec = batch.map(codec::decrypt).also { seen(it) }
            val s = replica.apply(dec)
            observe(s, batch)
            mine = s.results.firstOrNull { it.strOrNull("opId") == env.str("opId") } ?: mine
        }
        return mine ?: throw IllegalStateException("operation not in the log")
    }

    /**
     * What the log tells about the trash cleanup (Q4): server time of the newest applied purge by any device and
     * of the first entry this phone saw (null = not seen in this session; the instance's /v1/gc says it too).
     */
    @Volatile var lastPurgeAt: Long? = null
        private set
    @Volatile var logStartedAt: Long? = null
        private set
    private val purgeAt = HashMap<Long, Long>()

    private fun seen(entries: List<JsonObject>) {
        for (e in entries) {
            val t = e["serverTime"]?.jsonPrimitive?.long ?: continue
            if (logStartedAt == null && e["seq"]?.jsonPrimitive?.long == 1L) logStartedAt = t
            val op = e["op"] as? JsonObject ?: continue
            val ops = if (op.strOrNull("type") == "group") (op["ops"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList() else listOf(op)
            if (ops.any { it.strOrNull("type") == "purge" }) purgeAt[e.getValue("seq").jsonPrimitive.long] = t
        }
    }

    private fun observe(s: IndexReplica.ApplySummary, @Suppress("UNUSED_PARAMETER") raw: List<JsonObject>) {
        for (r in s.results) {
            val seq = r["seq"]?.jsonPrimitive?.long ?: continue
            val t = purgeAt.remove(seq) ?: continue
            if (r.strOrNull("outcome") == "applied") lastPurgeAt = maxOf(lastPurgeAt ?: 0, t)
        }
        purgeAt.clear()
    }

    /** Move nodes to the trash (one operation; a group for several). */
    fun trash(ids: List<String>): JsonObject = commit(group(ids.map { id -> buildJsonObject { put("type", "trash"); put("nodeId", id) } }))

    /** Move nodes into `parentId` (one operation; a group for several). Drive <-> Gallery is a plain move (rules 4). */
    fun move(ids: List<String>, parentId: String): JsonObject = commit(group(ids.map { id -> buildJsonObject { put("type", "move"); put("nodeId", id); put("parentId", parentId) } }))

    /** Back from the trash to where they were (or "Odzyskane" when that folder is gone). */
    fun restore(ids: List<String>): JsonObject = commit(group(ids.map { id -> buildJsonObject { put("type", "restore"); put("nodeId", id) } }))

    /** Delete for good (only nodes in the trash; unseen changes of other devices are kept, rule Q3). */
    fun purge(ids: List<String>): JsonObject = commit(group(ids.map { id -> buildJsonObject { put("type", "purge"); put("nodeId", id) } }))

    private fun group(ops: List<JsonObject>): JsonObject {
        require(ops.isNotEmpty()) { "no nodes" }
        return if (ops.size == 1) ops[0] else buildJsonObject { put("type", "group"); put("ops", JsonArray(ops)) }
    }

    /** Readers of the account's files: the vault's webhooks (metadata only) or the instance (e2ee / plain). */
    fun blobSource(): BlobSource = if (acct.serverBlobs) InstanceSource(api, discord) else WebhookSource(discord, ::hookUrl)

    /**
     * e2ee / plain: the instance deletes a version's fragments 30 days after a release; it learns of releases
     * from the clients' indexes (POST /v1/uploads/released). Releases after `afterSeq` (from the replica).
     */
    fun reportReleased(released: List<Pair<String, Long>>) { if (acct.serverBlobs && released.isNotEmpty()) api.released(released) }

    /** The account's webhooks that take new pieces (not retired, not being drained). */
    fun writableWebhooks(): List<Vault.Webhook> = Vault.webhooks(vault).filter { !it.retired }

    /**
     * Rules 4: a file created in the Gallery (or a new version of one) carries `space: "gallery"`, so that if its
     * album is deleted for good meanwhile it lands in the Gallery's root instead of „Odzyskane”. Drive ops stay
     * as they were (rules 3).
     */
    private fun withSpace(op: JsonObject): JsonObject {
        fun one(o: JsonObject): JsonObject {
            val at = when (o.strOrNull("type")) { "create" -> o.strOrNull("parentId"); "new_content_version" -> o.strOrNull("nodeId"); else -> null } ?: return o
            if (o.containsKey("space") || (at != GALLERY_ID && replica.spaceOf(at) != "gallery")) return o
            return JsonObject(o + ("space" to JsonPrimitive("gallery")))
        }
        if (op.strOrNull("type") != "group") return one(op)
        return JsonObject(op + ("ops" to JsonArray(op.getValue("ops").jsonArray.map { one(it.jsonObject) })))
    }

    /**
     * The instance replays rules 4 (its /v1/health): only then the phone writes into the Gallery. Asked once (a
     * network call: never on the main thread; [galleryKnown] is what the UI reads). A failure is not remembered.
     */
    @Volatile var galleryKnown: Boolean? = null
        private set
    fun galleryAvailable(): Boolean = galleryKnown ?: runCatching { (api.health()["rulesVersion"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0) >= 4 }
        .getOrElse { return false }.also { galleryKnown = it }

    /** A folder named `name` in `parentId` (outside the trash), made when there is none. Returns its ID. */
    fun folder(name: String, parentId: String = "root"): String {
        val nfc = Normalizer.normalize(name, Normalizer.Form.NFC)
        replica.children(parentId).firstOrNull { it.isFolder && it.name == nfc }?.let { return it.id }
        val r = mkdir(nfc, parentId)
        if (r.strOrNull("outcome") != "applied") throw IllegalStateException("mkdir $nfc: ${r.strOrNull("outcome")}")
        return replica.children(parentId).firstOrNull { it.isFolder && it.name == nfc }?.id ?: throw IllegalStateException("mkdir $nfc: not in the index")
    }

    fun mkdir(name: String, parentId: String = "root"): JsonObject = commit(buildJsonObject {
        put("type", "create")
        put("kind", "folder")
        put("nodeId", OpCodec.newId())
        put("parentId", parentId)
        put("name", Normalizer.normalize(name, Normalizer.Form.NFC))
    })

    /** This device's name on the instance (sealed, the server stores an opaque blob). */
    fun setOwnName(name: String) = api.setDeviceName(acct.deviceId, DeviceNames.seal(key, acct.accountId, acct.deviceId, name))

    /** Devices of the account with their names opened here. */
    fun devices(): List<Pair<String, String?>> = api.devices().map { d ->
        val id = d.str("deviceId")
        id to DeviceNames.open(key, acct.accountId, id, d.strOrNull("nameSealed"))
    }

    companion object {
        /**
         * New device by pairing: show `pending.offer` (QR), poll [InstanceApi.pairingTake] until the other
         * device answered, compare the code, then [finishPairing].
         */
        fun finishPairing(serverUrl: String, deviceName: String, device: Ed25519Key, r: Pairing.Result, http: InstanceApi): AccountState {
            val c = http.challenge()
            return AccountState(serverUrl, c.instanceId, r.accountId, r.deviceId, deviceName, r.key.rawB64, B64.enc(device.exportSeed()), modeOf(http))
        }

        /** The instance's storage mode (GET /v1/health "mode"; older instances: metadata only). */
        fun modeOf(http: InstanceApi): String =
            runCatching { http.health().strOrNull("mode") }.getOrNull()?.takeIf { it in setOf(AccountState.MODE_METADATA, AccountState.MODE_E2EE, AccountState.MODE_PLAIN) } ?: AccountState.MODE_METADATA

        /** New device from a rescue kit: registered with the rescue key derived from the account key. */
        fun joinWithKit(serverUrl: String, deviceName: String, kitText: String, http: InstanceApi = InstanceApi(serverUrl, null, null, null)): AccountState {
            val kit = RescueKit.parse(kitText)
            val key = AccountKey.fromB64(kit.key)
            val device = Ed25519Key.generate()
            val deviceId = http.rescueRegisterDevice(key, kit.accountId, device)
            return AccountState(serverUrl, http.challenge().instanceId, kit.accountId, deviceId, deviceName, kit.key, B64.enc(device.exportSeed()), modeOf(http))
        }
    }
}

internal fun JsonElement.asObj(): JsonObject = jsonObject
internal fun JsonObject.arr(k: String): JsonArray = getValue(k).jsonArray
