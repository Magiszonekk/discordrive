// Index invariants. Used by the randomized test and usable by
// clients as a self-check after loading a snapshot.

import { nameKey, validateName } from "./names.js";
import type { IndexStore } from "./store.js";
import { GALLERY_ID, RECOVERED_ID, ROOT_ID, SYSTEM_IDS, type NodeRecord } from "./types.js";

export interface InvariantViolation {
  code:
    | "missing_system_node"
    | "orphan"
    | "cycle"
    | "unreachable"
    | "duplicate_name"
    | "bad_name"
    | "parent_not_folder"
    | "folder_with_content"
    | "file_without_content"
    | "content_upload_missing"
    | "content_upload_not_bound"
    | "upload_bound_mismatch"
    | "upload_shared";
  nodeId?: string;
  detail?: string;
}

/**
 * Checks:
 *  - system roots exist and are roots,
 *  - every non-root node has an existing parent that is a folder (no orphans),
 *  - no cycles, every node reaches a system root (reachability from the root),
 *  - names unique per folder (case-folded) among non-trashed children,
 *  - every file points at a bound upload that points back at it
 *    ("no file points at a deleted fragment": released/aborted uploads are
 *    the only ones whose fragments may be deleted),
 *  - no upload is referenced by two versions.
 */
export function checkInvariants(store: IndexStore): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const nodes = new Map<string, NodeRecord>();
  for (const n of store.allNodes()) nodes.set(n.id, n);

  // The Gallery's root (rules 4) is optional, but a root folder never trashed when present.
  for (const id of [ROOT_ID, RECOVERED_ID, ...(nodes.has(GALLERY_ID) ? [GALLERY_ID] : [])]) {
    const n = nodes.get(id);
    if (!n || n.parentId !== null || n.kind !== "folder" || n.trashed) {
      out.push({ code: "missing_system_node", nodeId: id });
    }
  }

  const seenKeys = new Map<string, string>();
  const uploadUse = new Map<string, string>();
  for (const n of nodes.values()) {
    if (n.parentId === null) {
      if (!SYSTEM_IDS.has(n.id) && n.id !== GALLERY_ID) out.push({ code: "orphan", nodeId: n.id, detail: "non-system root" });
    } else {
      const p = nodes.get(n.parentId);
      if (!p) out.push({ code: "orphan", nodeId: n.id, detail: n.parentId });
      else if (p.kind !== "folder") out.push({ code: "parent_not_folder", nodeId: n.id });
      if (n.trashed === null) {
        const k = `${n.parentId}\u0000${nameKey(n.name)}`;
        const other = seenKeys.get(k);
        if (other !== undefined) out.push({ code: "duplicate_name", nodeId: n.id, detail: `${other} / ${n.name}` });
        else seenKeys.set(k, n.id);
      }
      if (validateName(n.name) !== null) out.push({ code: "bad_name", nodeId: n.id, detail: n.name });
    }

    if (n.kind === "folder" && n.content) out.push({ code: "folder_with_content", nodeId: n.id });
    if (n.kind === "file") {
      if (!n.content) out.push({ code: "file_without_content", nodeId: n.id });
      else {
        const u = store.getUpload(n.content.uploadId);
        if (!u) out.push({ code: "content_upload_missing", nodeId: n.id });
        else if (u.status !== "bound") out.push({ code: "content_upload_not_bound", nodeId: n.id, detail: u.status });
        else if (u.boundTo?.nodeId !== n.id || u.boundTo.versionId !== n.content.versionId) {
          out.push({ code: "upload_bound_mismatch", nodeId: n.id });
        }
        const prev = uploadUse.get(n.content.uploadId);
        if (prev !== undefined) out.push({ code: "upload_shared", nodeId: n.id, detail: prev });
        uploadUse.set(n.content.uploadId, n.id);
      }
    }
  }

  // Bound uploads must be used by exactly the node they name.
  for (const u of store.allUploads()) {
    if (u.status !== "bound") continue;
    const n = u.boundTo ? nodes.get(u.boundTo.nodeId) : undefined;
    if (!n || n.content?.uploadId !== u.id) out.push({ code: "upload_bound_mismatch", detail: u.id });
  }

  // Cycles / reachability: walk up from every node with memoization.
  const ok = new Set<string>([ROOT_ID, RECOVERED_ID, ...(nodes.has(GALLERY_ID) ? [GALLERY_ID] : [])]);
  for (const start of nodes.keys()) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur: string | null = start;
    let bad: InvariantViolation | null = null;
    while (cur !== null && !ok.has(cur)) {
      if (onPath.has(cur)) {
        bad = { code: "cycle", nodeId: start };
        break;
      }
      onPath.add(cur);
      path.push(cur);
      const rec = nodes.get(cur);
      if (!rec) {
        bad = { code: "unreachable", nodeId: start };
        break;
      }
      cur = rec.parentId;
      if (cur === null) {
        bad = { code: "unreachable", nodeId: start };
        break;
      }
    }
    if (bad) out.push(bad);
    else for (const p of path) ok.add(p);
  }
  return out;
}
