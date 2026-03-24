import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { gqlRequest } from "../../lib/graphql.js";

interface Props {
  folderId: string | null;
}

const FOLDER_PATH_QUERY = `
  query FolderPath($parentId: ID) {
    folders(parentId: $parentId) {
      id name parentId
    }
  }
`;

interface FolderInfo {
  id: string;
  name: string;
  parentId: string | null;
}

function useFolderPath(folderId: string | null): FolderInfo[] {
  // Fetch all root folders to find names by walking up
  // We query all folders at the root level and at the current level
  const { data: rootData } = useQuery({
    queryKey: ["allFolders"],
    queryFn: async () => {
      // Fetch all folders the user owns to build paths
      // We query root folders and rely on the sidebar cache
      const result = await gqlRequest<{
        folders: FolderInfo[];
      }>(FOLDER_PATH_QUERY, { parentId: null });
      return result.folders;
    },
    staleTime: 30_000,
  });

  if (!folderId || !rootData) return [];

  // Check if the current folder is a root folder
  const rootFolder = rootData.find((f) => f.id === folderId);
  if (rootFolder) return [rootFolder];

  // For nested folders, we don't have the data yet — show just the ID
  // A full solution would require a backend `folderPath` query
  return [{ id: folderId, name: "...", parentId: null }];
}

export function FolderBreadcrumb({ folderId }: Props) {
  const path = useFolderPath(folderId);

  return (
    <div className="flex items-center gap-2 text-sm">
      <Link
        to="/"
        className={`flex items-center gap-1 ${folderId ? "text-zinc-400 hover:text-white" : "text-white"}`}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
        </svg>
        Files
      </Link>
      {path.map((folder) => (
        <span key={folder.id} className="flex items-center gap-2">
          <svg className="w-3 h-3 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-white">{folder.name}</span>
        </span>
      ))}
    </div>
  );
}
