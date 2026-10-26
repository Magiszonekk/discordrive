package com.discordrive.gallery

import io.github.magiszonekk.discordrive.core.AccountState
import io.github.magiszonekk.discordrive.core.InstanceApi

/** Leaving the account on this phone: its own device entry revoked on the instance (key and sessions). */
object DdnLeave {
    /** Throws when the instance cannot be reached or refuses (the caller forgets the account anyway). */
    fun revokeSelf(acct: AccountState, api: InstanceApi = InstanceApi(acct.serverUrl, acct.accountId, acct.deviceId, acct.device, acct.instanceId)) {
        api.revokeDevice(acct.deviceId)
    }
}
