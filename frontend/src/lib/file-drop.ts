/** True only for an operating-system file drag, never for workbench tabs. */
export function isFileDrag(dataTransfer: Pick<DataTransfer, "files" | "types"> | null | undefined): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files.length > 0) return true;
  return Array.from(dataTransfer.types).includes("Files");
}
