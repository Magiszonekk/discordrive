export type PreviewKind = "image" | "video" | "audio" | "none";
export type ShareState =
  | "loading"
  | "invalid_link"
  | "secret_missing"
  | "revoked"
  | "expired"
  | "max_views_reached"
  | "preview_available"
  | "download_only";

export function classifyPreviewKind(mimeType: string | null | undefined): PreviewKind {
  if (!mimeType) return "none";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "none";
}

export function deriveShareState(input: {
  allowPreview: boolean;
  previewKind: PreviewKind;
  accessError?: "invalid_link" | "secret_missing" | "revoked" | "expired" | "max_views_reached" | null;
}): ShareState {
  if (input.accessError) return input.accessError;
  if (input.allowPreview && input.previewKind !== "none") return "preview_available";
  return "download_only";
}
