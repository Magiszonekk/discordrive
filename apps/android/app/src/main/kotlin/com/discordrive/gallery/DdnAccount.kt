package com.discordrive.gallery

import android.content.Context
import io.github.magiszonekk.discordrive.core.AccountState
import io.github.magiszonekk.discordrive.core.json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * The discordrive account on this phone (account key, device key, IDs), kept in the Keystore-encrypted
 * store (SecureStore). One account per phone. The old gallery login stays separate until its screens move
 * to discordrive.
 */
object DdnAccount {
    private const val KEY = "ddn_account"
    private const val VAULT_REV = "ddn_vault_revision"

    fun load(context: Context): AccountState? =
        SecureStore(context).getString(KEY)?.let { runCatching { AccountState.fromJson(json.parseToJsonElement(it).jsonObject) }.getOrNull() }

    fun save(context: Context, a: AccountState) = SecureStore(context).putString(KEY, json.encodeToString(JsonObject.serializer(), a.toJson()))

    fun forget(context: Context) {
        SecureStore(context).remove(KEY)
        context.getSharedPreferences("ddn", Context.MODE_PRIVATE).edit().remove(VAULT_REV).apply()
    }

    /** Highest vault revision seen (a server handing an older one is refused). */
    fun vaultRevision(context: Context): Long = context.getSharedPreferences("ddn", Context.MODE_PRIVATE).getLong(VAULT_REV, 0)
    fun setVaultRevision(context: Context, r: Long) = context.getSharedPreferences("ddn", Context.MODE_PRIVATE).edit().putLong(VAULT_REV, r).apply()
}
