import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { gqlRequest } from "../../lib/graphql.js";
import { useAuthStore } from "../../stores/auth.js";
import { unwrapFolderKey, decryptFolderBody } from "../../lib/crypto.js";
import { ITEM_DRAG_TYPE, decodeDragPayload } from "../../lib/dragTypes.js";

const FOLDER_PATH_QUERY = `
  query FolderPath($folderId: ID!) {
    folderPath(folderId: $folderId) {
      id encryptedBody wrappedFolderKey
    }
  }
`;

interface FolderCrumb {
  id: string;
  name: string;
}

interface Props {
  folderId: string | null;
  onMoveFile?: (fileId: string, targetFolderId: string | null) => void;
  onMoveFolder?: (folderId: string, targetFolderId: string | null) => void;
}

export function FolderBreadcrumb({ folderId, onMoveFile, onMoveFolder }: Props) {
  const filesKey = useAuthStore((s) => s.filesKey);
  const [dragOverId, setDragOverId] = useState<string | "root" | null>(null);

  const { data: crumbs = [] } = useQuery<FolderCrumb[]>({
    queryKey: ["folderPath", folderId],
    enabled: Boolean(folderId && filesKey),
    queryFn: async () => {
      const result = await gqlRequest<{
        folderPath: { id: string; encryptedBody: string; wrappedFolderKey: string }[];
      }>(FOLDER_PATH_QUERY, { folderId });

      return Promise.all(
        result.folderPath.map(async (f) => {
          let name = f.id;
          try {
            const key = await unwrapFolderKey(f.wrappedFolderKey, filesKey!);
            const body = await decryptFolderBody(f.encryptedBody, key);
            name = body.name;
          } catch { /* fallback to id */ }
          return { id: f.id, name };
        }),
      );
    },
  });

  const canDrop = Boolean(onMoveFile || onMoveFolder);

  const dropProps = (targetId: string | "root") => ({
    onDragOver: (e: React.DragEvent) => {
      if (!canDrop || !e.dataTransfer.types.includes(ITEM_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverId(targetId);
    },
    onDragLeave: () => setDragOverId(null),
    onDrop: (e: React.DragEvent) => {
      setDragOverId(null);
      if (!canDrop) return;
      const payload = decodeDragPayload(e);
      if (!payload) return;
      const dest = targetId === "root" ? null : targetId;
      // Don't move an item into itself or into its current location
      if (payload.id === dest) return;
      if (dest === (folderId ?? null)) return;
      if (payload.type === "file") onMoveFile?.(payload.id, dest);
      else onMoveFolder?.(payload.id, dest);
    },
  });

  const crumbStyle = (id: string | "root") =>
    dragOverId === id
      ? "rounded px-1.5 py-0.5 bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/60"
      : "rounded px-1.5 py-0.5 transition-colors";

  const parentId = crumbs.length >= 2 ? crumbs[crumbs.length - 2]!.id : null;
  const currentName = crumbs[crumbs.length - 1]?.name ?? "…";

  return (
    <>
      {/* Mobile: back arrow */}
      <div className="flex items-center gap-2 text-sm md:hidden">
        {folderId ? (
          <Link
            to={parentId ? `/folder/${parentId}` : "/"}
            className="inline-flex items-center gap-1 text-zinc-400 transition-colors hover:text-white"
          >
            <ChevronLeft size={16} />
            <span>{crumbs.length >= 2 ? (crumbs[crumbs.length - 2]?.name ?? "Files") : "Files"}</span>
          </Link>
        ) : (
          <span className="text-sm text-white">Files</span>
        )}
      </div>

      {/* Desktop: full path with drop targets */}
      <div className="hidden items-center gap-1 text-sm md:flex">
        <span {...dropProps("root")} className={crumbStyle("root")}>
          <Link
            to="/"
            className={folderId ? "text-zinc-400 hover:text-white" : "font-medium text-white"}
            // prevent link navigation when dragging
            onClick={(e) => dragOverId === "root" && e.preventDefault()}
          >
            Files
          </Link>
        </span>

        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <span key={crumb.id} className="inline-flex items-center gap-1">
              <ChevronRight size={14} className="text-zinc-600" />
              <span {...dropProps(crumb.id)} className={crumbStyle(crumb.id)}>
                {isLast ? (
                  <span className="max-w-[20ch] truncate font-medium text-white">{currentName}</span>
                ) : (
                  <Link
                    to={`/folder/${crumb.id}`}
                    className="max-w-[16ch] truncate text-zinc-400 hover:text-white"
                    onClick={(e) => dragOverId === crumb.id && e.preventDefault()}
                  >
                    {crumb.name}
                  </Link>
                )}
              </span>
            </span>
          );
        })}
      </div>
    </>
  );
}
