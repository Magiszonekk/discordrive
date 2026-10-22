package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * The interop scenario between the phone and the TypeScript client, run by apps/android/interop/harness.mts
 * (it starts a real instance, a fake Discord and this RPC): pairing as a new device by the QR offer, joining
 * from the snapshot plus the log tail, the same state hash as the TS device, then operations the TS device
 * sees. On the JVM the sync core comes over the RPC (rpcReplica); on a phone it is the phone's JS engine.
 */
class InteropScenario(private val rpcUrl: String, private val server: String, private val discordOrigin: String) {
    private val http = OkHttpClient()
    private var seq = 0

    fun rpc(m: String, a: JsonElement = JsonNull): JsonElement {
        val body = buildJsonObject { put("id", ++seq); put("m", m); put("a", a) }
        val req = Request.Builder().url(rpcUrl).post(json.encodeToString(JsonElement.serializer(), body).toRequestBody("application/json".toMediaType())).build()
        http.newCall(req).execute().use { res ->
            val o = json.parseToJsonElement(res.body!!.string()).jsonObject
            if (o["ok"]?.jsonPrimitive?.boolean != true) throw IllegalStateException("harness: ${o["e"]}")
            return o.getValue("r")
        }
    }

    /** The harness's sync core as an IndexReplica (JVM tests: no JS engine there). */
    fun rpcReplica(): IndexReplica = object : IndexReplica {
        override val rulesVersion: Int get() = rpc("rules").jsonPrimitive.int
        override val headSeq: Long get() = rpc("head").jsonPrimitive.long
        override fun reset() { rpc("reset") }
        override fun loadSnapshotText(slices: Sequence<String>): Long {
            rpc("load", json.parseToJsonElement(slices.joinToString("")))
            return headSeq
        }
        override fun apply(entries: List<JsonObject>): IndexReplica.ApplySummary {
            val rs = rpc("apply", JsonArray(entries)).jsonArray.map { it.jsonObject }
            return IndexReplica.ApplySummary(headSeq, rs.groupingBy { it.str("outcome") }.eachCount(), rs)
        }
        override fun leaseGuard(op: JsonObject): List<String> = rpc("guard", op).jsonArray.map { it.jsonPrimitive.content }
        override fun stateSha256(): String = rpc("sha").jsonPrimitive.content
        override fun children(parentId: String): List<IndexReplica.Child> = rpc("children", JsonPrimitive(parentId)).jsonArray.map {
            val o = it.jsonObject
            IndexReplica.Child(o.str("id"), o.str("name"), o.str("kind"), null)
        }
        override fun close() {}
    }

    /** Runs every step; returns the checks (all must be true). `log` gets progress lines. */
    fun run(newReplica: () -> IndexReplica, deviceName: String, log: (String) -> Unit = ::println): Map<String, Boolean> {
        val results = LinkedHashMap<String, Boolean>()

        // 1. Pairing: the phone shows its offer; the signed-in TS device accepts it; the phone takes the answer.
        val device = Ed25519Key.generate()
        val pending = Pairing.start(device.publicKey)
        val anon = InstanceApi(server, null, null, null)
        results["mailboxEmptyBeforeAnswer"] = anon.pairingTake(pending.pairingId) == null
        val webSas = rpc("offer", JsonPrimitive(pending.offer)).jsonObject.str("sas")
        val msg = anon.pairingTake(pending.pairingId)!!
        val res = pending.complete(msg)
        results["sasMatches"] = res.sas == webSas
        results["mailboxOneShot"] = anon.pairingTake(pending.pairingId) == null
        val acct = AccountSync.finishPairing(server, deviceName, device, res, anon)

        // 2. Join: vault, pointer, base from Discord, the tail from the instance.
        val api = InstanceApi(server, acct.accountId, acct.deviceId, acct.device, acct.instanceId)
        val sync = AccountSync(acct, api, Discord(apiOrigin = discordOrigin.takeUnless { it.isEmpty() || it == "none" }), newReplica())
        val j = sync.join()
        log("join: $j")
        val want = rpc("expect").jsonObject
        results["joinedFromBase"] = j.baseHeadSeq > 0 && j.tailEntries == (want.getValue("head").jsonPrimitive.long - j.baseHeadSeq).toInt()
        results["sameStateAsWebClient"] = sync.replica.stateSha256() == want.str("sha") && sync.replica.headSeq == want.getValue("head").jsonPrimitive.long
        results["signedInOnce"] = api.logins == 1
        val kids = sync.replica.children("root")
        results["seesRenameAndTrash"] = kids.any { it.name == "Dokumenty" } && kids.none { it.name == "Zdjęcia 4" } && kids.size == 39

        // 3. The phone works: its name, a folder, a channel added to the vault (compare-and-swap).
        sync.setOwnName(deviceName)
        val r = sync.mkdir("Z telefonu \u017C")
        results["mkdirApplied"] = r.str("outcome") == "applied"
        val hook = rpc("newHook").jsonObject
        sync.updateVault { v ->
            Vault.withWebhook(v, buildJsonObject {
                put("id", hook.str("id")); put("url", hook.str("url")); put("channelId", hook.str("channelId"))
                put("guildId", JsonNull); put("label", "z telefonu"); put("addedAt", System.currentTimeMillis())
            })
        }
        // A rollback by the server is refused.
        val stale = AccountSync(acct, api, Discord(apiOrigin = discordOrigin.takeUnless { it.isEmpty() || it == "none" }), newReplica(), vaultRevision = sync.vaultRevision + 5)
        results["vaultRollbackRefused"] = runCatching { stale.loadVault() }.exceptionOrNull() is VaultRollbackException

        // 4. The TS device sees all of it.
        val seen = rpc("verify").jsonObject
        results["webSeesPhoneFolder"] = seen.getValue("phoneFolder").jsonPrimitive.boolean
        results["webSeesPhoneChannel"] = seen.getValue("webhooks").jsonArray.map { it.jsonPrimitive.content }.contains(hook.str("id"))
        results["webSeesPhoneName"] = seen["phoneName"]?.jsonPrimitive?.content == deviceName
        sync.pull()
        results["sameStateAfterChanges"] = sync.replica.stateSha256() == seen.str("sha")
        results["twoDevices"] = seen.getValue("devices").jsonPrimitive.int == 2
        // The device list names both devices (names opened on the phone).
        results["phoneListsDevices"] = sync.devices().any { it.second == deviceName }

        rpc("done", JsonObject(results.mapValues { JsonPrimitive(it.value) }))
        log("interop: $results")
        return results
    }
}
