import { ChevronLeft } from "lucide-react";
import { Link } from "react-router";

interface Props {
  folderId: string | null;
}

export function FolderBreadcrumb({ folderId }: Props) {
  return (
    <>
      <div className="flex items-center gap-2 text-sm md:hidden">
        {folderId ? (
          <Link
            to="/"
            className="inline-flex items-center gap-1 text-zinc-400 transition-colors hover:text-white"
          >
            <ChevronLeft size={16} />
            <span>Files</span>
          </Link>
        ) : (
          <span className="text-sm text-white">Files</span>
        )}
      </div>

      <div className="hidden items-center gap-2 text-sm md:flex">
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
    </>
  );
}
