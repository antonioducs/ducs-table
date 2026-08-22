import { describe, expect, it } from "vitest";
import { clearColumnState, columnStateKey, loadColumnState, saveColumnState } from "./column-state";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

describe("column state persistence", () => {
  it("stores order, visibility and widths per project and source", () => {
    const storage = memoryStorage();
    saveColumnState("project-a", "source-a", [
      { colId: "name", hide: false, width: 220 },
      { colId: "email", hide: true, width: 180 },
    ], storage);
    expect(loadColumnState("project-a", "source-a", ["name", "email"], storage)).toEqual([
      { colId: "name", hide: false, width: 220 },
      { colId: "email", hide: true, width: 180 },
    ]);
    expect(loadColumnState("project-b", "source-a", ["name"], storage)).toBeUndefined();
  });

  it("drops stale columns and recovers from malformed JSON", () => {
    const storage = memoryStorage();
    storage.setItem(columnStateKey("project-a", "source-a"), JSON.stringify([{ colId: "old", width: 100 }, { colId: "name", width: 200 }]));
    expect(loadColumnState("project-a", "source-a", ["name"], storage)).toEqual([{ colId: "name", width: 200 }]);
    storage.setItem(columnStateKey("project-a", "source-a"), "{");
    expect(loadColumnState("project-a", "source-a", ["name"], storage)).toBeUndefined();
    clearColumnState("project-a", "source-a", storage);
    expect(storage.values.has(columnStateKey("project-a", "source-a"))).toBe(false);
  });
});
