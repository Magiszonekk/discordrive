export const ITEM_DRAG_TYPE = "application/ddv4-item";

export interface DragPayload {
  type: "file" | "folder";
  id: string;
}

export function encodeDragPayload(payload: DragPayload): string {
  return JSON.stringify(payload);
}

export function decodeDragPayload(e: DragEvent | React.DragEvent): DragPayload | null {
  try {
    return JSON.parse(e.dataTransfer!.getData(ITEM_DRAG_TYPE)) as DragPayload;
  } catch {
    return null;
  }
}
