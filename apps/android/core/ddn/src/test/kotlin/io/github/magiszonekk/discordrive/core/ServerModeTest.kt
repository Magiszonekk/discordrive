package io.github.magiszonekk.discordrive.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test

/**
 * The phone in an e2ee / plain account (apps/android/interop/server-modes.mts): pairing, joining from the log
 * (no vault, no client snapshot), the same state as the TS device, files and a thumbnail read through the
 * instance, an upload through the instance (with a thumbnail) the TS device reads, trash + purge and the
 * release reported to the instance. Skipped unless started by that script.
 */
class ServerModeTest {
    @Test
    fun phoneInAServerBlobsAccount() {
        val rpcUrl = System.getenv("DDN_INTEROP_RPC")
        assumeTrue(System.getProperty("ddn.interop") != null && rpcUrl != null && System.getenv("DDN_INTEROP_SERVER") != null)
        val server = System.getenv("DDN_INTEROP_SERVER")!!
        val origin = System.getenv("DDN_INTEROP_DISCORD")!!
        val sc = InteropScenario(rpcUrl!!, server, origin)
        val r = LinkedHashMap<String, Boolean>()
        val mode = sc.rpc("mode").jsonPrimitive.content

        // Pairing (the same as metadata only); the mode comes from the instance.
        val device = Ed25519Key.generate()
        val pending = Pairing.start(device.publicKey)
        val anon = InstanceApi(server, null, null, null)
        sc.rpc("offer", JsonPrimitive(pending.offer))
        val acct = AccountSync.finishPairing(server, "Pixel 7", device, pending.complete(anon.pairingTake(pending.pairingId)!!), anon)
        r["modeFromInstance"] = acct.mode == mode && acct.serverBlobs

        val api = InstanceApi(server, acct.accountId, acct.deviceId, acct.device, acct.instanceId)
        val discord = Discord(apiOrigin = origin)
        val sync = AccountSync(acct, api, discord, sc.rpcReplica())
        val j = sync.join()
        val want = sc.rpc("expect").jsonObject
        r["joinedFromLog"] = j.baseHeadSeq == 0L && j.tailEntries.toLong() == want.getValue("head").jsonPrimitive.long
        r["sameState"] = sync.replica.stateSha256() == want.getValue("sha").jsonPrimitive.content
        r["noVault"] = Vault.webhooks(sync.vault).isEmpty()

        // Files through the instance.
        val f = sc.rpc("files").jsonObject
        val reader = FileReader(sync.blobSource())
        val inFolder = sync.replica.children(f.getValue("folder").jsonPrimitive.content).associateBy { it.name }
        var ok = true
        for ((name, meta) in f.getValue("files").jsonObject) {
            val c = inFolder[name] ?: run { ok = false; null } ?: continue
            val out = java.io.ByteArrayOutputStream()
            reader.download(c.manifestRef!!, c.size!!, c.sha256, out)
            if (sha256Hex(out.toByteArray()) != meta.jsonObject.getValue("sha").jsonPrimitive.content) ok = false
            val mid = c.size!! / 2
            if (!reader.range(c.manifestRef!!, c.size!!, mid, mid + 99).contentEquals(out.toByteArray().copyOfRange(mid.toInt(), mid.toInt() + 100))) ok = false
        }
        r["readsThroughInstance"] = ok
        val photo = inFolder["Zdj\u0119cie \u017B.jpg"]!!
        r["thumbnailThroughInstance"] = reader.preview(photo.manifestRef!!, 't')?.let { sha256Hex(it.data) == f.getValue("thumbSha").jsonPrimitive.content } == true

        // An AI description added later through the instance (blob "x<name>" of the version's upload).
        run {
            val loc = FileFormat.decodeManifestRef(photo.manifestRef!!)
            val rec = Describe.Record("Zdjęcie testowe", listOf("test"), model = "fake", at = 1)
            val w = ExtraWriter()
            val added = w.addThroughInstance(api, photo.uploadId!!, Describe.name(loc.fileKey), Describe.seal(loc.fileKey, rec))
            val again = w.addThroughInstance(api, photo.uploadId!!, Describe.name(loc.fileKey), Describe.seal(loc.fileKey, rec))
            val fresh = FileReader(sync.blobSource())
            r["descriptionThroughInstance"] = added && !again && fresh.description(photo.manifestRef!!) == rec &&
                fresh.preview(photo.manifestRef!!, 't')?.let { sha256Hex(it.data) == f.getValue("thumbSha").jsonPrimitive.content } == true
        }

        // An upload through the instance (fragments, the manifest, the thumbnail as an extra).
        val fw = FileWriter(DiscordWriter(apiOrigin = origin), api, { emptyList() }, { op -> sync.commit(op) }, chunkSize = 64 * 1024, viaInstance = true)
        val data = randomBytes(150_007)
        val pic = FileWrite.Picture('t', "image/webp", 320, 240, randomBytes(3000))
        val up = fw.upload({ data.inputStream() }, data.size.toLong(), "z telefonu.jpg", "fold-0000000002", listOf(pic))
        r["uploadThroughInstance"] = up.outcome == "applied" && up.chunks == 3
        val seen = sc.rpc("phoneUpload", buildJsonObject { put("folder", "fold-0000000002"); put("name", "z telefonu.jpg"); put("sha", up.sha256); put("thumbSha", sha256Hex(pic.data)) }).jsonObject
        r["webReadsPhoneUpload"] = seen.getValue("sha").jsonPrimitive.boolean
        r["webReadsPhoneThumbnail"] = seen.getValue("thumb").jsonPrimitive.boolean

        // Trash, purge, the release reported (the instance deletes it 30 days later).
        sync.trash(listOf(up.nodeId)); sync.purge(listOf(up.nodeId))
        val rel = sync.replica.released(0)
        r["releasedListed"] = rel.any { it.first == up.uploadId }
        sync.reportReleased(rel.map { it.first to it.second })
        r["instanceHasRelease"] = sc.rpc("uploadState", JsonPrimitive(up.uploadId)).jsonPrimitive.content == "released"
        r["sameStateAfter"] = sync.replica.stateSha256() == sc.rpc("expect").jsonObject.getValue("sha").jsonPrimitive.content

        // The account's settings in this mode too: the phone stores the AI endpoint, the TS device reads it;
        // the TS device changes the model, the phone reads that.
        val settings = AccountSettings(api, AccountKey.fromB64(acct.accountKey), acct.accountId)
        settings.update { v -> Describe.withConfig(v, Describe.AiConfig("http://localhost:8080/v1", "k1", "m1")) }
        val roundTrip = sc.rpc("settingsRoundTrip").jsonObject
        r["settingsReadByWeb"] = roundTrip["model"]?.jsonPrimitive?.content == "m1"
        r["settingsFromWeb"] = Describe.configOf(settings.load())?.model == "m2"

        // A rescue kit of an e2ee / plain instance opens.
        r["kit2Parses"] = RescueKit.parse("ddn-kit2:" + B64.encUrl("""{"v":2,"accountId":"${acct.accountId}","key":"${acct.accountKey}","server":"$server"}""".toByteArray())).accountId == acct.accountId

        sc.rpc("done", JsonObject(r.mapValues { JsonPrimitive(it.value) }))
        println("server mode $mode: $r")
        assertTrue(r.values.all { it }, "server mode checks: $r")
    }
}
