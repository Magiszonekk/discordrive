import { Link } from "react-router";

interface Props {
  folderId: string | null;
}

export function FolderBreadcrumb({ folderId }: Props) {
  // Simple breadcrumb — just root or current folder
  return (
    <div className="flex items-center gap-2 text-sm">
      <Link
        to="/"
        className={`${folderId ? "text-zinc-400 hover:text-white" : "text-white"}`}
      >
        Files
      </Link>
      {folderId && (
        <>
          <span className="text-zinc-600">/</span>
          <span className="text-white">...</span>
        </>
      )}
    </div>
  );
}
