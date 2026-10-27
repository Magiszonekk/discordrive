package com.discordrive.gallery

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import io.github.magiszonekk.discordrive.core.AccountKey
import io.github.magiszonekk.discordrive.core.IndexReplica
import io.github.magiszonekk.discordrive.core.InstanceApi
import io.github.magiszonekk.discordrive.core.SafeStore
import io.github.magiszonekk.discordrive.core.SafeTree
import io.github.magiszonekk.discordrive.core.Vault
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The Safe in the app (the core is io.github.magiszonekk.discordrive.core.SafeTree, the same Safe as the web app's):
 * opened with its password, then — if the user turns it on — with the phone's fingerprint or screen-lock PIN (the
 * Safe's master sealed by an Android Keystore key that needs the user every time). The open Safe (its master and its
 * names) lives only in this process's memory: dropped on Close, after [IDLE_MS] without a use, and when the account
 * leaves the phone. Files opened from the Safe are written to a cache folder only for the viewer and wiped on close.
 */
object DdnSafe {
    const val IDLE_MS = 5 * 60_000L
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var open: SafeStore.Unlocked? = null
    private var tree: SafeTree? = null
    private var store: SafeStore? = null
    private val closeLater = Runnable { close() }
    /** Called on the main thread when the Safe closes by itself (the screen shows the closed state). */
    @Volatile var onClosed: (() -> Unit)? = null

    val isOpen: Boolean get() = open != null

    @Volatile private var appCtx: Context? = null

    private fun parts(c: Context): Pair<SafeStore, SafeTree> {
        appCtx = c.applicationContext
        val s = DdnSession.get(c) ?: throw IllegalStateException("no account on this phone")
        store?.let { st -> tree?.let { t -> return st to t } }
        val acct = s.acct
        val api = InstanceApi(acct.serverUrl, acct.accountId, acct.deviceId, acct.device, acct.instanceId)
        val st = SafeStore(api, AccountKey.fromB64(acct.accountKey), acct.accountId, seenRevision(c))
        val t = SafeTree(
            st, s.safeReplica, acct.deviceId, acct.deviceName, api, viaInstance = acct.serverBlobs,
            readManifest = { ref -> s.files.manifest(ref).second },
            deleteMessage = { hook, msg -> s.writer.delete(Vault.webhooks(s.sync.vault).first { it.id == hook }, msg) },
        )
        store = st; tree = t
        return st to t
    }

    private fun prefs(c: Context) = c.getSharedPreferences("ddn-safe", Context.MODE_PRIVATE)
    private fun seenRevision(c: Context) = prefs(c).getLong("seen", 0)
    private fun keep(c: Context, u: SafeStore.Unlocked): SafeStore.Unlocked {
        open = u
        prefs(c).edit().putLong("seen", maxOf(seenRevision(c), u.revision)).apply()
        touch()
        return u
    }

    /** Any use keeps it open [IDLE_MS] longer. */
    fun touch() {
        main.removeCallbacks(closeLater)
        if (open != null) main.postDelayed(closeLater, IDLE_MS)
    }

    // ── off the main thread ──

    fun exists(c: Context): Boolean = parts(c).first.exists()

    fun create(c: Context, password: String): SafeStore.Unlocked = keep(c, parts(c).second.create(password))

    fun unlock(c: Context, password: String): SafeStore.Unlocked = keep(c, parts(c).first.unlock(password)).also { cleanupLater(c) }

    fun unlockWithMaster(c: Context, master: ByteArray): SafeStore.Unlocked = keep(c, parts(c).first.unlockWithMaster(master)).also { cleanupLater(c) }

    private fun cleanupLater(c: Context) {
        Thread { runCatching { val u = open ?: return@Thread; open = parts(c).second.cleanup(u).safe } }.start()
    }

    private fun cur(): SafeStore.Unlocked = open ?: throw IllegalStateException("safe_closed")

    fun children(c: Context, parentId: String): List<IndexReplica.Child> { touch(); return parts(c).second.children(cur(), parentId) }

    private fun change(c: Context, f: (SafeTree, SafeStore.Unlocked) -> SafeTree.Change): SafeTree.Change {
        touch()
        val r = f(parts(c).second, cur())
        open = r.safe
        prefs(c).edit().putLong("seen", maxOf(seenRevision(c), r.safe.revision)).apply()
        return r
    }

    fun mkdir(c: Context, name: String, parentId: String) = change(c) { t, u -> t.mkdir(u, name, parentId) }
    fun rename(c: Context, id: String, name: String) = change(c) { t, u -> t.rename(u, id, name) }
    fun delete(c: Context, ids: List<String>) = change(c) { t, u -> t.delete(u, ids) }

    fun upload(c: Context, open: () -> java.io.InputStream, size: Long, name: String, parentId: String, takenAt: Long?, progress: (Long, Long) -> Unit = { _, _ -> }): SafeTree.Change {
        val s = DdnSession.get(c)!!
        return change(c) { t, u -> t.upload(u, s.uploader(), open, size, name, parentId, takenAt, progress = { a, b -> touch(); progress(a, b) }) }
    }

    /** A file of the Safe into the viewer's cache folder (wiped on close). */
    fun fetch(c: Context, f: IndexReplica.Child, progress: (Long, Long) -> Unit = { _, _ -> }): File {
        touch()
        val dir = File(c.cacheDir, "safe-open").apply { mkdirs() }
        val out = File(dir, f.name.replace('/', '_'))
        out.outputStream().use { DdnSession.get(c)!!.files.download(f.manifestRef!!, f.size!!, f.sha256, it) { a, b -> touch(); progress(a, b) } }
        return out
    }

    /**
     * Files and folders of the account into the Safe: each file read and sent again under a new key (the old key
     * was in the account's log), added to the Safe, then deleted for good from the account. One file at a time.
     */
    fun moveIn(c: Context, items: List<IndexReplica.Child>, safeParent: String = "root", progress: (String) -> Unit = {}): Int {
        val s = DdnSession.get(c)!!
        var files = 0
        fun one(it: IndexReplica.Child, into: String) {
            if (it.isFolder) {
                val id = mkdir(c, it.name, into).nodeId!!
                for (k in s.children(it.id)) one(k, id)
                return
            }
            progress(it.name)
            val tmp = File.createTempFile("safe-in", null, c.cacheDir)
            try {
                tmp.outputStream().use { o -> s.files.download(it.manifestRef!!, it.size!!, it.sha256, o) }
                val taken = runCatching { s.files.manifest(it.manifestRef!!).second.takenAt }.getOrNull()
                upload(c, { tmp.inputStream() }, tmp.length(), it.name, into, taken)
            } finally { tmp.delete() }
            s.moveToTrash(listOf(it.id)); s.purge(listOf(it.id))
            files++
        }
        for (it in items) one(it, safeParent)
        // The folders moved, emptied of their files: out of the account too.
        val folders = items.filter { it.isFolder }.map { it.id }
        if (folders.isNotEmpty()) { s.moveToTrash(folders); s.purge(folders) }
        return files
    }

    /** A file of the Safe out to a folder of the Drive (sent again: the Safe's key never reaches the log). */
    fun moveOut(c: Context, f: IndexReplica.Child, parentId: String = "root"): Boolean {
        val s = DdnSession.get(c)!!
        val tmp = fetch(c, f)
        try {
            s.uploader().upload({ tmp.inputStream() }, tmp.length(), f.name, parentId)
        } finally { tmp.delete() }
        delete(c, listOf(f.id))
        return true
    }

    /** Close: the master and the names leave memory, the files opened from it leave the cache. */
    fun close(c: Context? = null) {
        main.removeCallbacks(closeLater)
        val was = open != null
        open = null
        (c ?: appCtx)?.let { File(it.cacheDir, "safe-open").deleteRecursively() }
        if (was) onClosed?.invoke()
    }

    /** The account left the phone: close, forget the unlock key and the store. */
    fun forget(c: Context) {
        close(c)
        store = null; tree = null
        appCtx = null
        DeviceUnlock.disable(c)
        prefs(c).edit().clear().apply()
    }

    internal fun masterForDeviceUnlock(): ByteArray = cur().master

    /**
     * Unlock with the phone (fingerprint or the screen-lock PIN): the Safe's master sealed by an Android Keystore key
     * that needs the user for every use; a new fingerprint enrolled invalidates it (the password again then).
     */
    object DeviceUnlock {
        private const val ALIAS = "ddn-safe-unlock"
        private val authenticators: Int get() =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
            else BiometricManager.Authenticators.BIOMETRIC_STRONG

        fun available(c: Context): Boolean = BiometricManager.from(c).canAuthenticate(authenticators) == BiometricManager.BIOMETRIC_SUCCESS
        fun enabled(c: Context): Boolean = prefs(c).getString("sealed", null) != null

        private fun key(create: Boolean): SecretKey? {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
            if (!create) return null
            val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256)
                .setUserAuthenticationRequired(true).setInvalidatedByBiometricEnrollment(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
            return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec.build()) }.generateKey()
        }

        private fun prompt(a: AppCompatActivity, cipher: Cipher, title: Int, done: (Cipher?) -> Unit) {
            val info = BiometricPrompt.PromptInfo.Builder().setTitle(a.getString(title)).setAllowedAuthenticators(authenticators)
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) info.setNegativeButtonText(a.getString(R.string.safe_use_password))
            BiometricPrompt(a, ContextCompat.getMainExecutor(a), object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult) = done(r.cryptoObject?.cipher)
                override fun onAuthenticationError(code: Int, s: CharSequence) = done(null)
            }).authenticate(info.build(), BiometricPrompt.CryptoObject(cipher))
        }

        /** Turn on for the open Safe (asks the user once to seal its master). */
        fun enable(a: AppCompatActivity, done: (Boolean) -> Unit) {
            val master = runCatching { masterForDeviceUnlock() }.getOrNull() ?: return done(false)
            val cipher = runCatching { Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key(true)) } }.getOrElse { return done(false) }
            prompt(a, cipher, R.string.safe_device_enable) { c ->
                if (c == null) return@prompt done(false)
                val sealed = c.iv + c.doFinal(master)
                prefs(a).edit().putString("sealed", java.util.Base64.getEncoder().encodeToString(sealed)).apply()
                done(true)
            }
        }

        /** The master back (null: cancelled, or the key is gone — the password then). */
        fun unlock(a: AppCompatActivity, done: (ByteArray?) -> Unit) {
            val sealed = prefs(a).getString("sealed", null)?.let { java.util.Base64.getDecoder().decode(it) } ?: return done(null)
            val cipher = try {
                Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(false) ?: throw KeyPermanentlyInvalidatedException(), GCMParameterSpec(128, sealed.copyOfRange(0, 12))) }
            } catch (e: KeyPermanentlyInvalidatedException) {
                disable(a); return done(null)
            } catch (e: Exception) { return done(null) }
            prompt(a, cipher, R.string.safe_unlock) { c -> done(c?.let { runCatching { it.doFinal(sealed.copyOfRange(12, sealed.size)) }.getOrNull() }) }
        }

        fun disable(c: Context) {
            prefs(c).edit().remove("sealed").apply()
            runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS) }
        }
    }
}
