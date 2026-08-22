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
  it("stores order, visibility and widths per source", () => {
    const storage = memoryStorage();
    saveColumnState("source-a", [
      { colId: "name", hide: false, width: 220 },
      { colId: "email", hide: true, width: 180 },
    ], storage);
    expect(loadColumnState("source-a", ["name", "email"], storage)).toEqual([
      { colId: "name", hide: false, width: 220 },
      { colId: "email", hide: true, width: 180 },
    ]);
    expect(loadColumnState("source-b", ["name"], storage)).toBeUndefined();
  });

  it("drops stale columns and recovers from malformed JSON", () => {
    const storage = memoryStorage();
    storage.setItem(columnStateKey("source-a"), JSON.stringify([{ colId: "old", width: 100 }, { colId: "name", width: 200 }]));
    expect(loadColumnState("source-a", ["name"], storage)).toEqual([{ colId: "name", width: 200 }]);
    storage.setItem(columnStateKey("source-a"), "{");
    expect(loadColumnState("source-a", ["name"], storage)).toBeUndefined();
    clearColumnState("source-a", storage);
    expect(storage.values.has(columnStateKey("source-a"))).toBe(false);
  });
});

