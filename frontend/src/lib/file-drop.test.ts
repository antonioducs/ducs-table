import { describe, expect, it } from "vitest";
import { TAB_DRAG_TYPE } from "@/components/layout/TabsBar";
import { isFileDrag } from "./file-drop";

function transfer(types: string[], fileCount = 0): Pick<DataTransfer, "files" | "types"> {
  return { types, files: { length: fileCount } as FileList };
}

describe("file drag detection", () => {
  it("accepts native file drags", () => {
    expect(isFileDrag(transfer(["Files"]))).toBe(true);
    expect(isFileDrag(transfer([], 1))).toBe(true);
  });

  it("rejects workbench tab and text drags", () => {
    expect(isFileDrag(transfer([TAB_DRAG_TYPE]))).toBe(false);
    expect(isFileDrag(transfer(["text/plain"]))).toBe(false);
    expect(isFileDrag(undefined)).toBe(false);
  });
});
