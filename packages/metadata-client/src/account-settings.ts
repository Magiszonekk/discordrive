// Settings of an account shared by its devices, in every mode: one small JSON sealed with the account key
// (subkey "settings", AAD with the account and the revision, like the webhook vault) and stored on the
// instance with a compare-and-swap on the revision (GET/PUT /v1/settings). The instance sees an opaque
// blob. Fields are optional and unknown ones are kept by every client that edits it.
//   ai: { url, key, model }   the AI endpoint for descriptions (the key is a secret: never logged)

import { sealJson, unsealJson, type AccountKey } from "./account-key.js";
import { fromBase64, toBase64 } from "@ddv4/processing";

export const SETTINGS_FORMAT = "ddn-account-settings";
export const SETTINGS_VERSION = 1;

export interface AiSettings {
  url: string;
  key: string;
  model: string;
}

export interface AccountSettings {
  format: typeof SETTINGS_FORMAT;
  version: number;
  ai?: AiSettings;
  [k: string]: unknown;
}

export interface SettingsApi {
  /** revision 0 + blob null = none yet. */
  getSettings(): Promise<{ revision: number; blob: string | null }>;
  /** null = stored; else the current one that won. */
  putSettings(expectedRevision: number, revision: number, blob: string): Promise<{ revision: number; blob: string | null } | null>;
}

const aad = (accountId: string, revision: number) => `ddn-settings-v1|${accountId}|${revision}`;

export const emptySettings = (): AccountSettings => ({ format: SETTINGS_FORMAT, version: SETTINGS_VERSION });

export class SettingsRollbackError extends Error {
  constructor(seen: number, got: number) {
    super(`account settings went back from revision ${seen} to ${got}: refusing (server rollback?)`);
    this.name = "SettingsRollbackError";
  }
}

export class AccountSettingsStore {
  private cache: { revision: number; content: AccountSettings } | null = null;
  constructor(
    private readonly api: SettingsApi,
    private readonly key: AccountKey,
    private readonly accountId: string,
    /** Highest revision seen (persist it): an older one from the server is refused. */
    public seenRevision = 0,
  ) {}

  private async open(revision: number, blob: string | null): Promise<AccountSettings> {
    if (revision < this.seenRevision) throw new SettingsRollbackError(this.seenRevision, revision);
    const v = blob ? await unsealJson<AccountSettings>(await this.key.subkey("settings"), fromBase64(blob), aad(this.accountId, revision), "account settings") : emptySettings();
    if (v.format !== SETTINGS_FORMAT || v.version !== SETTINGS_VERSION) throw new Error("unsupported account settings format");
    this.seenRevision = revision;
    this.cache = { revision, content: v };
    return v;
  }

  async load(): Promise<AccountSettings> {
    const r = await this.api.getSettings();
    return this.open(r.revision, r.blob);
  }

  /** Apply `change` to the newest settings and store them; on a concurrent edit re-read and apply again. */
  async update(change: (s: AccountSettings) => AccountSettings, maxAttempts = 5): Promise<AccountSettings> {
    if (!this.cache) await this.load();
    let cur = this.cache!;
    for (let i = 0; i < maxAttempts; i++) {
      const next = change(structuredClone(cur.content));
      const rev = cur.revision + 1;
      const blob = toBase64(await sealJson(await this.key.subkey("settings"), next, aad(this.accountId, rev)));
      const won = await this.api.putSettings(cur.revision, rev, blob);
      if (!won) {
        this.seenRevision = rev;
        this.cache = { revision: rev, content: next };
        return next;
      }
      cur = { revision: won.revision, content: await this.open(won.revision, won.blob) };
    }
    throw new Error("account settings: too many concurrent edits");
  }
}
