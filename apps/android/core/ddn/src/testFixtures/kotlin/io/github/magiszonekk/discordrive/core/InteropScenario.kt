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
import kotlinx.serialization.json.contentOrNull
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
        override fun children(parentId: String): List<IndexReplica.Child> = rows(rpc("children", JsonPrimitive(parentId)))
        override fun media(extensions: List<String>, limit: Int, after: Pair<Long, String>?, space: String?): List<IndexReplica.Child> =
            rows(rpc("media", buildJsonObject { put("e", JsonArray(extensions.map { JsonPrimitive(it) })); space?.let { put("s", it) } }))
        override fun rulesVersionFor(op: JsonObject): Int = rpc("rulesFor", op).jsonPrimitive.int
        override fun spaceOf(id: String): String = rpc("space", JsonPrimitive(id)).jsonPrimitive.content
        override fun trash(): List<IndexReplica.Child> = rows(rpc("trash"))
        override fun node(id: String): IndexReplica.Child? = runCatching { rows(rpc("node", JsonPrimitive(id))).firstOrNull() }.getOrNull()
        override fun released(afterSeq: Long): List<Triple<String, Long, Long>> = rpc("released", JsonPrimitive(afterSeq)).jsonArray.map { val x = it.jsonArray; Triple(x[0].jsonPrimitive.content, x[1].jsonPrimitive.long, x[2].jsonPrimitive.long) }
        override fun albums(extensions: List<String>, space: String?): List<IndexReplica.Album> = rpc("albums", buildJsonObject { put("e", JsonArray(extensions.map { JsonPrimitive(it) })); space?.let { put("s", it) } }).jsonArray.map {
            val o = it.jsonObject
            IndexReplica.Album(o.str("id"), o.str("name"), o.getValue("count").jsonPrimitive.int, rows(JsonArray(listOf(o.getValue("cover")))).first())
        }
        override fun expiredTrash(nowServerMs: Long): List<String> = rpc("expired", JsonPrimitive(nowServerMs)).jsonArray.map { it.jsonPrimitive.content }
        private fun rows(e: JsonElement) = e.jsonArray.map {
            val o = it.jsonObject
            IndexReplica.Child(o.str("id"), o.str("name"), o.str("kind"), o.longOrNull("size"), o.strOrNull("ref"), o.strOrNull("sha"), o.longOrNull("at") ?: 0, o.strOrNull("parent"), o.longOrNull("tat"), o.strOrNull("up"))
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

        // 2b. Files: list, thumbnail stored with the photo, a range, whole downloads checked by hash.
        val f = rpc("files").jsonObject
        val reader = FileReader(sync.discord, { id -> Vault.webhooks(sync.vault).first { it.id == id }.url })
        val inFolder = sync.replica.children(f.str("folder")).associateBy { it.name }
        var filesOk = true
        for ((name, meta) in f.getValue("files").jsonObject) {
            val m = meta.jsonObject
            val c = inFolder[name]
            if (c?.manifestRef == null || c.size != m.getValue("size").jsonPrimitive.long) { filesOk = false; log("file $name: not listed right ($c)"); continue }
            val out = java.io.ByteArrayOutputStream()
            reader.download(c.manifestRef!!, c.size!!, c.sha256, out)
            if (sha256Hex(out.toByteArray()) != m.str("sha")) { filesOk = false; log("file $name: content differs") }
            val mid = c.size!! / 2
            val part = reader.range(c.manifestRef!!, c.size!!, mid, mid + 99)
            if (!part.contentEquals(out.toByteArray().copyOfRange(mid.toInt(), mid.toInt() + 100))) { filesOk = false; log("file $name: range differs") }
        }
        results["filesDownloadAndRange"] = filesOk
        // The web client stored when the photo was taken; the phone reads it from the manifest.
        inFolder["Wakacje \u017B.jpg"]?.manifestRef?.let { results["takenAtFromWeb"] = reader.manifest(it).second.takenAt == 1715940000000L }
        val photo = inFolder["Wakacje \u017B.jpg"]
        val t = f["thumbSha"]?.jsonPrimitive?.contentOrNull
        if (t != null) {
            val pv = reader.preview(photo!!.manifestRef!!, 't')
            results["thumbnailOfWebUpload"] = pv != null && sha256Hex(pv.data) == t && pv.mime == "image/webp"
            results["noThumbnailOnVideo"] = reader.preview(inFolder["film.webm"]!!.manifestRef!!, 't') == null
        }
        // 2c. An AI description added later to the web client's photo (its message edited, the thumbnail kept).
        if (photo?.manifestRef != null) {
            val loc = FileFormat.decodeManifestRef(photo.manifestRef!!)
            val rec = Describe.Record("Testowy obraz z pasami", listOf("test", "pasy"), text = "DDN", model = "fake", at = 1)
            val hookUrl = Vault.webhooks(sync.vault).first { it.id == loc.webhookId }.url
            val w = ExtraWriter(apiOrigin = discordOrigin.takeUnless { it.isEmpty() || it == "none" })
            val added = w.addToMessage(sync.discord, hookUrl, loc.messageId, Describe.name(loc.fileKey), Describe.seal(loc.fileKey, rec))
            val again = w.addToMessage(sync.discord, hookUrl, loc.messageId, Describe.name(loc.fileKey), Describe.seal(loc.fileKey, rec))
            val fresh = FileReader(sync.discord, { id -> Vault.webhooks(sync.vault).first { it.id == id }.url })
            results["descriptionAddedToMessage"] = added && !again && fresh.description(photo.manifestRef!!) == rec
            if (t != null) results["thumbnailKeptAfterEdit"] = fresh.preview(photo.manifestRef!!, 't')?.let { sha256Hex(it.data) == t } == true &&
                rpc("thumbOf", JsonPrimitive(photo.id)).jsonPrimitive.content == t
        }

        val media = sync.replica.media(listOf(".jpg", ".webm"), 100)
        results["galleryListsMedia"] = media.map { it.name }.toSet() == setOf("Wakacje \u017B.jpg", "film.webm")
        val albums = sync.replica.albums(listOf(".jpg", ".webm"))
        results["albumsByFolder"] = albums.size == 1 && albums[0].id == f.str("folder") && albums[0].count == 2 && albums[0].cover.name in setOf("Wakacje \u017B.jpg", "film.webm")

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
        // 3b. The phone uploads: a file of several fragments with a thumbnail into its folder (the TS device
        // downloads it below and checks the hash and the thumbnail); a cancelled upload leaves no message.
        val origin = discordOrigin.takeUnless { it.isEmpty() || it == "none" }
        val dw = DiscordWriter(apiOrigin = origin, perMin = if (origin != null) 6000.0 else 30.0, burst = if (origin != null) 100.0 else 4.0)
        val fw = FileWriter(dw, api, { sync.writableWebhooks() }, { op -> sync.commit(op) }, chunkSize = 64 * 1024)
        val phoneFolder = sync.folder("Z telefonu \u017C")
        val data = randomBytes(200_003)
        val thumb = FileWrite.Picture('t', "image/webp", 320, 240, randomBytes(3000))
        val up = fw.upload({ data.inputStream() }, data.size.toLong(), "IMG_0001 \u017B.jpg", phoneFolder, listOf(thumb))
        log("upload: $up")
        results["phoneUploadApplied"] = up.outcome == "applied" && up.chunks == 4 && up.sha256 == sha256Hex(data)
        results["phoneSeesOwnUpload"] = sync.replica.children(phoneFolder).any { it.name == "IMG_0001 \u017B.jpg" && it.size == data.size.toLong() && it.sha256 == up.sha256 }
        val before = rpc("messages").jsonPrimitive.int
        var n = 0
        val cancelled = runCatching { fw.upload({ data.inputStream() }, data.size.toLong(), "przerwane.bin", phoneFolder, cancelled = { n++ >= 2 }) }.exceptionOrNull()
        results["cancelledUploadCleaned"] = cancelled is FileWriter.Cancelled && (before < 0 || rpc("messages").jsonPrimitive.int == before)
        val ph = rpc("phoneUpload", buildJsonObject { put("folder", phoneFolder); put("name", "IMG_0001 \u017B.jpg"); put("sha", up.sha256); put("thumbSha", sha256Hex(thumb.data)) }).jsonObject
        results["webDownloadsPhoneUpload"] = ph.getValue("sha").jsonPrimitive.boolean
        results["webSeesPhoneThumbnail"] = ph.getValue("thumb").jsonPrimitive.boolean
        results["cancelledNotInTree"] = sync.replica.children(phoneFolder).none { it.name == "przerwane.bin" }
        // Optional speed run (harness --big-mb N): N MiB in 10 MiB fragments, the phone's default parallelism.
        rpc("bigMb").jsonPrimitive.int.takeIf { it > 0 }?.let { mb ->
            val big = randomBytes(mb * 1024 * 1024)
            val fw10 = FileWriter(dw, api, { sync.writableWebhooks() }, { op -> sync.commit(op) }, parallel = 3)
            val t0 = System.currentTimeMillis()
            val r = fw10.upload({ big.inputStream() }, big.size.toLong(), "duzy-z-telefonu.bin", phoneFolder)
            val ms = System.currentTimeMillis() - t0
            log("big upload: $mb MiB, ${r.chunks} fragments, $ms ms, ${"%.1f".format(mb * 1.048576 * 1000 / ms)} MB/s, posts ${dw.stats.posts}, 429 ${dw.stats.rateLimited}, retries ${dw.stats.retries}")
            val ph2 = rpc("phoneUpload", buildJsonObject { put("folder", phoneFolder); put("name", "duzy-z-telefonu.bin"); put("sha", r.sha256); put("thumbSha", "") }).jsonObject
            results["bigUploadReadByWeb"] = ph2.getValue("sha").jsonPrimitive.boolean
            rpc("speed", buildJsonObject { put("mb", mb); put("ms", ms); put("chunks", r.chunks); put("r429", dw.stats.rateLimited.get()) })
        }

        // 3c. The trash (PR 5): the phone trashes its upload and a folder, lists the trash (with the server time
        // of the trash), restores the folder, deletes the file for good; the TS device sees the same tree (4).
        // The folder "Zdjęcia 4" the TS device trashed is in the list too. Q4: a phone (not the main device)
        // does not empty the trash before 7 days without a purge; nothing is 30 days old here anyway.
        val upNode = sync.replica.children(phoneFolder).first { it.name == "IMG_0001 \u017B.jpg" }
        val tmpFolder = sync.folder("Kosz test")
        results["trashApplied"] = sync.trash(listOf(upNode.id, tmpFolder)).str("outcome") == "applied"
        val tr = sync.replica.trash()
        results["trashListed"] = tr.any { it.id == upNode.id && (it.trashedAt ?: 0) > 0 } && tr.any { it.id == tmpFolder } && tr.any { it.name == "Zdjęcia 4" } &&
            sync.replica.children(phoneFolder).none { it.id == upNode.id }
        results["restoreApplied"] = sync.restore(listOf(tmpFolder)).str("outcome") == "applied" && sync.replica.children("root").any { it.id == tmpFolder }
        results["purgeApplied"] = sync.purge(listOf(upNode.id)).str("outcome") == "applied" && sync.replica.node(upNode.id) == null && sync.replica.trash().none { it.id == upNode.id }
        results["lastPurgeSeen"] = (sync.lastPurgeAt ?: 0) > 0
        val gc = api.gcStatus()
        val nowS = gc.now
        results["nothingExpiredYet"] = sync.replica.expiredTrash(nowS).isEmpty() && sync.replica.expiredTrash(nowS + TrashPolicy.RETENTION_MS + 1).any { it == "fold-0000000004" }
        results["q4PhoneWaits"] = TrashPolicy.decide(sync.replica.expiredTrash(nowS + TrashPolicy.RETENTION_MS + 1), nowS + TrashPolicy.RETENTION_MS + 1, false, true, false, nowS, gc.firstEntryAt) is TrashPolicy.Decision.Clean &&
            TrashPolicy.decide(listOf("x"), nowS, false, true, false, nowS - 1000, gc.firstEntryAt) == TrashPolicy.Decision.Skip("primary_cleans") &&
            TrashPolicy.decide(listOf("x"), nowS, false, true, true, null, 0) == TrashPolicy.Decision.Skip("metered")

        // 3d. The Gallery (rules 4): the phone makes an album in the Gallery and uploads a photo into it (rules 4,
        // with `space`), its Drive work stays rules 3; the TS device sees the photo in the Gallery, not in Files.
        results["galleryAvailable"] = sync.galleryAvailable()
        val album = sync.folder("Wakacje Galeria", GALLERY_ID)
        val gdata = randomBytes(40_001)
        val gup = fw.upload({ gdata.inputStream() }, gdata.size.toLong(), "IMG_G1.jpg", album, takenAt = 1_600_000_000_000)
        results["galleryUploadApplied"] = gup.outcome == "applied" && sync.replica.spaceOf(gup.nodeId) == "gallery"
        results["phoneGalleryLists"] = sync.replica.media(listOf(".jpg"), 100, null, "gallery").any { it.id == gup.nodeId } &&
            sync.replica.media(listOf(".jpg"), 100, null, "drive").none { it.id == gup.nodeId } &&
            sync.replica.albums(listOf(".jpg"), "gallery").any { it.id == album && it.count == 1 }
        results["driveOpsStayRules3"] = sync.replica.rulesVersionFor(buildJsonObject { put("type", "rename"); put("nodeId", phoneFolder); put("name", "x") }) == 3 &&
            sync.replica.rulesVersionFor(buildJsonObject { put("type", "move"); put("nodeId", phoneFolder); put("parentId", GALLERY_ID) }) == 4
        val gs = rpc("gallery", buildJsonObject { put("name", "IMG_G1.jpg"); put("album", "Wakacje Galeria") }).jsonObject
        results["webSeesPhoneGallery"] = gs.getValue("inGallery").jsonPrimitive.boolean && gs.getValue("notUnderFiles").jsonPrimitive.boolean && gs.getValue("rules4").jsonPrimitive.int >= 2

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

        // A new device of an account whose snapshot channel was removed on Discord: the whole log instead.
        val ptrHook = Vault.pointer(sync.vault)?.first
        if (ptrHook != null && rpc("hooksOff", JsonArray(listOf(JsonPrimitive(ptrHook)))).jsonPrimitive.int >= 0) {
            try {
                val fresh = AccountSync(acct, api, Discord(apiOrigin = discordOrigin.takeUnless { it.isEmpty() || it == "none" }), newReplica())
                val jj = fresh.join()
                log("join without the snapshot channel: $jj")
                val now = rpc("expect").jsonObject
                results["joinWithoutSnapshotChannel"] = jj.snapshotSkipped != null && jj.baseHeadSeq == 0L &&
                    fresh.replica.stateSha256() == now.str("sha") && fresh.replica.headSeq == now.getValue("head").jsonPrimitive.long
            } finally {
                rpc("hooksOn")
            }
        }

        rpc("done", JsonObject(results.mapValues { JsonPrimitive(it.value) }))
        log("interop: $results")
        return results
    }
}
