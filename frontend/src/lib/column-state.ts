import type { ColumnState } from "ag-grid-community";

const PREFIX = "ducs-table:columns:v1:";

export interface PersistedColumnState {
  colId: string;
  hide?: boolean;
  width?: number;
  sort?: "asc" | "desc" | null;
  sortIndex?: number | null;
}

function isColumnState(value: unknown): value is PersistedColumnState {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.colId === "string" &&
    (item.hide === undefined || typeof item.hide === "boolean") &&
    (item.width === undefined || (typeof item.width === "number" && item.width >= 48 && item.width <= 4000)) &&
    (item.sort === undefined || item.sort === null || item.sort === "asc" || item.sort === "desc")
  );
}

export function columnStateKey(sourceId: string): string {
  return `${PREFIX}${sourceId}`;
}

export function saveColumnState(
  sourceId: string,
  state: ColumnState[],
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  const compact: PersistedColumnState[] = state.map(({ colId, hide, width, sort, sortIndex }) => ({
    colId,
    hide: hide ?? undefined,
    width: width ?? undefined,
    sort: sort ?? undefined,
    sortIndex: sortIndex ?? undefined,
  }));
  storage.setItem(columnStateKey(sourceId), JSON.stringify(compact));
}

export function loadColumnState(
  sourceId: string,
  validColumns: readonly string[],
  storage: Pick<Storage, "getItem"> = localStorage,
): ColumnState[] | undefined {
  const raw = storage.getItem(columnStateKey(sourceId));
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const allowed = new Set(validColumns);
    const state = parsed.filter(isColumnState).filter((item) => allowed.has(item.colId));
    return state.length ? state : undefined;
  } catch {
    return undefined;
  }
}

export function clearColumnState(
  sourceId: string,
  storage: Pick<Storage, "removeItem"> = localStorage,
): void {
  storage.removeItem(columnStateKey(sourceId));
}
