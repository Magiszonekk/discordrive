// What is inside the Safe: a tree of the sync core (the same rules as the account: names, conflicts, trash,
// the Drive and the Gallery), kept whole in the Safe's sealed state instead of a log on the instance.
//
// A change is one operation applied to the tree as the next entry of the Safe's own log (seq = head + 1, the
// device's clock as the server time: the Safe has no arbiter), then the whole state stored with the slot's
// compare-and-swap. When another device wrote meanwhile, the operation is applied again on its state with the
// base the author saw (baseSeq), so the rules decide as they do for the account (rule 1: the newer name, rule
// 4: into a trashed folder → recovered, …). Nothing of this goes through the account's log.
//
// Size: the state is one sealed object of at most 1 MiB (padded): a few thousand nodes. A larger Safe will
// need the state in parts (as the account's snapshot bases).

import {
  initIndex,
  loadSnapshot,
  MemoryIndexStore,
  nameKey,
  RULES_VERSION,
  takeSnapshot,
  uploadsTouched,
  applyEntry,
  type ApplyResult,
  type DeviceInfo,
  type IndexSnapshot,
  type IndexStore,
  type LogEntry,
  type NodeId,
  type NodeRecord,
  type Operation,
} from "@ddv4/sync-core";
import { SafeStore, type UnlockedSafe } from "./safe.js";
import type { ByteSink, ByteSource, DownloadOptions, DriveClient, UploadOptions } from "./drive-client.js";

export interface SafeTreeState {
  v: 1;
  tree: IndexSnapshot;
}

export const emptySafeTree = (): SafeTreeState => ({ v: 1, tree: takeSnapshot(initIndex(new MemoryIndexStore())) });

const newId = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The tree of an open Safe (read-only view: a fresh store from its snapshot). */
export function safeTreeOf(u: UnlockedSafe<SafeTreeState>): IndexStore {
  if (u.state?.v !== 1) throw new Error("unsupported Safe state");
  return loadSnapshot(u.state.tree, new MemoryIndexStore());
}

/** Children of a folder of the Safe (not in the trash), folders first, by name. */
export function safeChildren(u: UnlockedSafe<SafeTreeState>, parentId: NodeId): NodeRecord[] {
  const t = safeTreeOf(u);
  return [...t.childIds(parentId)]
    .map((id) => t.getNode(id)!)
    .filter((n) => n && !n.trashed)
    .sort((a, b) => (a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : nameKey(a.name) < nameKey(b.name) ? -1 : nameKey(a.name) > nameKey(b.name) ? 1 : a.id < b.id ? -1 : 1));
}

export class SafeTree {
  constructor(
    private readonly store: SafeStore<SafeTreeState>,
    private readonly device: DeviceInfo,
    private readonly now: () => number = () => Date.now(),
    private readonly tzOffsetMin: (at: number) => number = (at) => -new Date(at).getTimezoneOffset(),
  ) {}

  /** A new Safe with an empty tree. */
  create(password: string, params?: Parameters<SafeStore<SafeTreeState>["create"]>[2]): Promise<UnlockedSafe<SafeTreeState>> {
    return this.store.create(password, emptySafeTree(), params);
  }

  /**
   * Apply one operation to the Safe's tree and store it. Returns the new open Safe and the rules' result
   * (outcome + notices) as applied to the state that was stored (after a concurrent edit: on the other's).
   */
  async commit(u: UnlockedSafe<SafeTreeState>, op: Operation): Promise<{ safe: UnlockedSafe<SafeTreeState>; result: ApplyResult }> {
    const baseSeq = u.state.tree.meta.headSeq;
    const opId = newId();
    const createdAt = this.now();
    let result: ApplyResult | null = null;
    const safe = await this.store.update(u, (s) => {
      if (s?.v !== 1) throw new Error("unsupported Safe state");
      const t = loadSnapshot(s.tree, new MemoryIndexStore());
      const seq = t.getMeta().headSeq + 1;
      const lg = uploadsTouched(op);
      const e: LogEntry = {
        opId,
        rulesVersion: RULES_VERSION,
        baseSeq: Math.min(baseSeq, seq - 1),
        device: { ...this.device },
        createdAt,
        tzOffsetMin: this.tzOffsetMin(createdAt),
        ...(lg.length ? { leaseGuard: lg } : {}),
        op,
        seq,
        serverTime: this.now(),
      };
      result = applyEntry(t, e);
      return { v: 1, tree: takeSnapshot(t) };
    });
    return { safe, result: result! };
  }

  /**
   * A file into the Safe: its pieces and manifest stored as any upload (the client's store: the account's
   * webhooks or the instance), its reference (with the file key) only in the Safe's state, in one Safe entry
   * (upload_begin + upload_commit + create). Nothing in the account's log.
   */
  async upload(u: UnlockedSafe<SafeTreeState>, client: DriveClient, src: ByteSource, name: string, parentId: NodeId = "root", opts: Omit<UploadOptions, "outsideLog" | "replace" | "resumeKey"> = {}): Promise<{ safe: UnlockedSafe<SafeTreeState>; nodeId: NodeId; result: ApplyResult }> {
    let out: { safe: UnlockedSafe<SafeTreeState>; result: ApplyResult } | null = null;
    const r = await client.upload(src, name, parentId, {
      ...opts,
      outsideLog: {
        commit: async (version, nodeId, nfc) => {
          out = await this.commit(u, {
            type: "group",
            ops: [
              { type: "upload_begin", uploadId: version.uploadId },
              { type: "upload_commit", uploadId: version.uploadId },
              { type: "create", kind: "file", nodeId, parentId, name: nfc, content: version },
            ],
          });
          if (out.result.outcome !== "applied") throw new Error(`Safe: the file was not added (${out.result.outcome})`);
        },
      },
    });
    return { safe: out!.safe, nodeId: r.nodeId, result: out!.result };
  }

  /** A file of the Safe, read with its reference from the Safe's state. */
  async download(u: UnlockedSafe<SafeTreeState>, client: DriveClient, nodeId: NodeId, sink: ByteSink, opts: Omit<DownloadOptions, "content"> = {}) {
    const n = safeTreeOf(u).getNode(nodeId);
    if (!n || n.kind !== "file" || !n.content) throw new Error("not a file of the Safe");
    return client.download(nodeId, sink, { ...opts, content: { version: n.content, name: n.name } });
  }

  mkdir(u: UnlockedSafe<SafeTreeState>, name: string, parentId: NodeId = "root") {
    return this.commit(u, { type: "create", kind: "folder", nodeId: newId(), parentId, name: name.normalize("NFC") });
  }
  rename(u: UnlockedSafe<SafeTreeState>, nodeId: NodeId, name: string) {
    return this.commit(u, { type: "rename", nodeId, name: name.normalize("NFC") });
  }
  move(u: UnlockedSafe<SafeTreeState>, nodeId: NodeId, parentId: NodeId) {
    return this.commit(u, { type: "move", nodeId, parentId });
  }
  trash(u: UnlockedSafe<SafeTreeState>, nodeId: NodeId) {
    return this.commit(u, { type: "trash", nodeId });
  }
  restore(u: UnlockedSafe<SafeTreeState>, nodeId: NodeId) {
    return this.commit(u, { type: "restore", nodeId });
  }
}
