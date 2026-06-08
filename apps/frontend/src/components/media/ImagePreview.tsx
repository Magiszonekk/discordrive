import { useEffect } from "react";
import type { PreviewResult } from "../../lib/preview.js";

interface ImagePreviewProps {
  preview: PreviewResult;
  className?: string;
}

export function ImagePreview({ preview, className }: ImagePreviewProps) {
  useEffect(() => {
    return () => {
      URL.revokeObjectURL(preview.objectUrl);
    };
  }, [preview.objectUrl]);

  return (
    <img
      src={preview.objectUrl}
      alt={preview.fileName}
      className={className ?? "max-h-[70vh] w-full rounded-lg object-contain bg-black/30"}
    />
  );
}
