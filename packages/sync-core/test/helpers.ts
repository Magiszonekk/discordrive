// Test helpers: build logs by hand with explicit baseSeq, so each conflict
// rule can be exercised in both orders.

import {
  applyEntry,
  checkInvariants,
  initIndex,
  MemoryIndexStore,
  RULES_VERSION,
  ROOT_ID,
  RECOVERED_ID,
  uploadsTouched,
  type ApplyResult,
  type ContentRef,
  type DeviceInfo,
  type IndexStore,
  type LogEntry,
  type NodeRecord,
  type Operation,
  type SingleOp,
} from "../src/index.js";
import { expect } from "vitest";

export const A: DeviceInfo = { id: "dev-A", name: "laptop" };
export const B: DeviceInfo = { id: "dev-B", name: "telefon" };
export const C: DeviceInfo = { id: "dev-C", name: "pc" };

export const T0 = Date.UTC(2026, 8, 29, 12, 0, 0);

export interface AddOpts {
  /** Default: the author has seen everything so far. */
  baseSeq?: number;
  createdAt?: number;
  opId?: string;
  leaseGuard?: string[];
  rulesVersion?: number;
  tzOffsetMin?: number;
  /** Plaintext hash for the content created by file()/edit() (Q7). */
  hash?: string;
}

/** A log plus a replica that applies it as it grows. */
export class Scenario {
  readonly entries: LogEntry[] = [];
  readonly store: IndexStore = initIndex(new MemoryIndexStore());
  readonly results: ApplyResult[] = [];
  private n = 0;
  private up = 0;

  get seq(): number {
    return this.entries.length;
  }

  add(dev: DeviceInfo, op: Operation, o: AddOpts = {}): ApplyResult {
    this.n++;
    const e: LogEntry = {
      opId: o.opId ?? `op-${String(this.n).padStart(6, "0")}`,
      rulesVersion: o.rulesVersion ?? RULES_VERSION,
      baseSeq: o.baseSeq ?? this.seq,
      device: dev,
      createdAt: o.createdAt ?? T0 + this.n * 60_000,
      leaseGuard: o.leaseGuard ?? uploadsTouched(op),
      ...(o.tzOffsetMin !== undefined ? { tzOffsetMin: o.tzOffsetMin } : {}),
      op,
      seq: this.seq + 1,
      serverTime: T0 + this.n * 1000,
    };
    this.entries.push(e);
    const r = applyEntry(this.store, e);
    this.results.push(r);
    return r;
  }

  /** upload_begin + group[upload_commit, create]. Returns the create result. */
  file(dev: DeviceInfo, nodeId: string, parentId: string, name: string, o: AddOpts = {}): ApplyResult {
    const c = this.newContent(o.hash);
    this.add(dev, { type: "upload_begin", uploadId: c.uploadId }, { baseSeq: o.baseSeq ?? this.seq });
    return this.add(
      dev,
      {
        type: "group",
        ops: [
          { type: "upload_commit", uploadId: c.uploadId },
          { type: "create", kind: "file", nodeId, parentId, name, content: c },
        ],
      },
      o,
    );
  }

  folder(dev: DeviceInfo, nodeId: string, parentId: string, name: string, o: AddOpts = {}): ApplyResult {
    return this.add(dev, { type: "create", kind: "folder", nodeId, parentId, name }, o);
  }

  /** New content version for nodeId based on baseVersionId. */
  edit(dev: DeviceInfo, nodeId: string, baseVersionId: string | null, o: AddOpts & { nameHint?: string } = {}): ApplyResult {
    const c = this.newContent(o.hash);
    this.add(dev, { type: "upload_begin", uploadId: c.uploadId }, { baseSeq: o.baseSeq ?? this.seq });
    return this.add(
      dev,
      {
        type: "group",
        ops: [
          { type: "upload_commit", uploadId: c.uploadId },
          { type: "new_content_version", nodeId, baseVersionId, content: c, nameHint: o.nameHint ?? "plik.txt" },
        ],
      },
      o,
    );
  }

  op(dev: DeviceInfo, op: SingleOp, o: AddOpts = {}): ApplyResult {
    return this.add(dev, op, o);
  }

  newContent(hash?: string): ContentRef {
    this.up++;
    const n = String(this.up).padStart(6, "0");
    return {
      versionId: `ver-${n}`,
      uploadId: `upl-${n}`,
      sizeBytes: 100 * this.up,
      manifestRef: `mf-${n}`,
      chunkCount: 1,
      ...(hash !== undefined ? { plaintextSha256: hash } : {}),
    };
  }

  /** Nodes whose own trashed flag is set or whose ancestor is trashed. */
  inTrash(id: string): boolean {
    for (let n = this.store.getNode(id); n; n = n.parentId === null ? undefined : this.store.getNode(n.parentId)) {
      if (n.trashed) return true;
    }
    return false;
  }

  /** Canonical node list (for "nothing changed" checks). */
  dump(): string {
    return JSON.stringify([...this.store.allNodes()].sort((x, y) => (x.id < y.id ? -1 : 1)));
  }

  node(id: string): NodeRecord {
    const n = this.store.getNode(id);
    if (!n) throw new Error(`no node ${id}`);
    return n;
  }

  maybe(id: string): NodeRecord | undefined {
    return this.store.getNode(id);
  }

  /** Non-trashed children of a folder by name. */
  names(parentId: string = ROOT_ID): string[] {
    return [...this.store.childIds(parentId)]
      .map((id) => this.store.getNode(id)!)
      .filter((n) => !n.trashed)
      .map((n) => n.name)
      .sort();
  }

  recovered(): NodeRecord[] {
    return [...this.store.childIds(RECOVERED_ID)].map((id) => this.store.getNode(id)!);
  }

  version(id: string): string {
    return this.node(id).content!.versionId;
  }

  expectValid(): void {
    expect(checkInvariants(this.store)).toEqual([]);
  }
}

export const codes = (r: ApplyResult) => r.notices.map((n) => n.code);

/** Notice codes the UI shows by default (silent ones hidden, Q2). */
export const visibleCodes = (r: ApplyResult) => r.notices.filter((n) => !n.silent).map((n) => n.code);

export const H1 = "1".repeat(64);
export const H2 = "2".repeat(64);
