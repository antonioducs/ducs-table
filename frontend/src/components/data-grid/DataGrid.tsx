import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  ClientSideRowModelModule,
  InfiniteRowModelModule,
  ModuleRegistry,
  type CellDoubleClickedEvent,
  type ColDef,
  type ColumnMovedEvent,
  type ColumnResizedEvent,
  type ColumnState,
  type ColumnVisibleEvent,
  type FilterChangedEvent,
  type GridApi,
  type GridReadyEvent,
  type GridState,
  type IDatasource,
  type SortChangedEvent,
} from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
import "./data-grid.css";
import { Columns3, Copy, Expand, LoaderCircle, RotateCcw, Search, WandSparkles } from "lucide-react";
import { bridge, getErrorMessage } from "@/lib/bridge";
import { clearColumnState, loadColumnState, saveColumnState } from "@/lib/column-state";
import { adaptFilterModel, adaptGetRowsParams, adaptSortModel, restoreFilterModel } from "@/lib/grid-adapter";
import type { ColumnInfo, DataRow, GridResourceRef, RowFilter, RowSort, SourceInfo } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

ModuleRegistry.registerModules([ClientSideRowModelModule, InfiniteRowModelModule]);

export type GridViewState = {
  sorts: RowSort[];
  filters: RowFilter[];
  visibleColumns: string[];
};

export type DataGridProps = {
  projectId?: string;
  source: SourceInfo;
  resource?: GridResourceRef;
  pagingStable?: boolean;
  onReconnect?: () => void;
  initialViewState?: GridViewState;
  onViewStateChange?: (state: GridViewState) => void;
};

type CellViewer = {
  rowIndex: number;
  column: string;
};

const PREVIEW_ROW_LIMIT = 200;
const LOCAL_CACHE_BLOCK_SIZE = 250;
const REMOTE_CACHE_BLOCK_SIZE = 100;
const DISPLAY_VALUE_LIMIT = 180;
const RESTORED_VIEW_LOADING_DELAY_MS = 300;
const LOCAL_ROW_BLOCK_CACHE_SIZE = 48;

type CachedRowBlock = { rows: DataRow[]; totalRows: number };
const localRowBlockCache = new Map<string, CachedRowBlock>();

function category(column: ColumnInfo): "text" | "number" | "date" | "boolean" {
  const type = column.type.toUpperCase();
  if (type.includes("BOOL")) return "boolean";
  if (/(INT|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL)/.test(type)) return "number";
  if (/(DATE|TIME)/.test(type)) return "date";
  return "text";
}

function jsonValue(value: unknown, pretty = false): string | undefined {
  try {
    return JSON.stringify(
      value,
      (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item,
      pretty ? 2 : undefined,
    );
  } catch {
    return undefined;
  }
}

function fullValueText(value: unknown): string {
  if (value === null) return "NULL";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    return jsonValue(value, true) ?? String(value);
  }
  return String(value);
}

function readable(value: unknown, valueCategory: ReturnType<typeof category>): string {
  if (value === null) return "NULL";
  if (value === undefined) return "";

  let text: string;
  if (valueCategory === "number" && typeof value === "number" && Number.isFinite(value)) {
    text = new Intl.NumberFormat(undefined, { maximumFractionDigits: 12 }).format(value);
  } else if (valueCategory === "date" && value instanceof Date) {
    text = value.toLocaleString();
  } else if (valueCategory === "date") {
    text = String(value).replace("T", " ");
  } else if (typeof value === "object") {
    text = jsonValue(value) ?? String(value);
  } else {
    text = String(value);
  }

  const singleLine = text.replace(/\r?\n/g, " ↵ ");
  return singleLine.length > DISPLAY_VALUE_LIMIT
    ? `${singleLine.slice(0, DISPLAY_VALUE_LIMIT - 1)}…`
    : singleLine;
}

function validColumns(columns: readonly ColumnInfo[]): ColumnInfo[] {
  const seen = new Set<string>();
  return columns.filter((column) => {
    if (!column || typeof column.name !== "string" || !column.name || seen.has(column.name)) return false;
    seen.add(column.name);
    return true;
  });
}

function safeLoadState(projectId: string, sourceId: string, columns: readonly ColumnInfo[]): ColumnState[] {
  const columnIds = columns.map((column) => column.name);
  let persisted: ColumnState[] = [];
  try {
    persisted = loadColumnState(projectId, sourceId, columnIds) ?? [];
  } catch {
    // The webview can deny session storage; the in-memory layout still remains usable.
  }
  const included = new Set(persisted.map((column) => column.colId));
  return [
    ...persisted,
    ...columnIds.filter((columnId) => !included.has(columnId)).map((colId) => ({ colId, hide: false })),
  ];
}

function safeSaveState(projectId: string, sourceId: string, state: ColumnState[]): void {
  try {
    saveColumnState(projectId, sourceId, state);
  } catch {
    // Keep layout changes in memory when persistence is unavailable.
  }
}

function safeClearState(projectId: string, sourceId: string): void {
  try {
    clearColumnState(projectId, sourceId);
  } catch {
    // Keep reset functional even when persistence is unavailable.
  }
}

function viewFromColumnState(
  state: readonly ColumnState[],
  columns: readonly ColumnInfo[],
  filters: RowFilter[] = [],
): GridViewState {
  const sorts = adaptSortModel(state
    .filter((column) => column.sort === "asc" || column.sort === "desc")
    .sort((left, right) => (left.sortIndex ?? 0) - (right.sortIndex ?? 0))
    .map((column) => ({ colId: column.colId, sort: column.sort! })), columns);
  return {
    sorts,
    filters,
    visibleColumns: state.filter((column) => column.hide !== true).map((column) => column.colId),
  };
}

function sameView(left: GridViewState, right: GridViewState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeRows(value: unknown): DataRow[] {
  return Array.isArray(value)
    ? value.filter((row): row is DataRow => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    : [];
}

function rowBlockCacheKey(
  projectId: string,
  sourceVersion: string,
  startRow: number,
  endRow: number,
  sorts: readonly RowSort[],
  filters: readonly RowFilter[],
  visibleColumns: readonly string[],
): string {
  return JSON.stringify([projectId, sourceVersion, startRow, endRow, sorts, filters, visibleColumns]);
}

function cacheRowBlock(key: string, block: CachedRowBlock): void {
  localRowBlockCache.delete(key);
  localRowBlockCache.set(key, block);
  while (localRowBlockCache.size > LOCAL_ROW_BLOCK_CACHE_SIZE) {
    const oldest = localRowBlockCache.keys().next().value;
    if (typeof oldest !== "string") break;
    localRowBlockCache.delete(oldest);
  }
}

async function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy") ?? false;
  textarea.remove();
  if (!copied) throw new Error("Clipboard unavailable");
}

function filterFor(column: ColumnInfo): string {
  switch (category(column)) {
    case "number":
      return "agNumberColumnFilter";
    case "date":
      return "agDateColumnFilter";
    default:
      return "agTextColumnFilter";
  }
}

function DataGridInner({ source, projectId = source.projectId, resource = { kind: "source", sourceId: source.id }, pagingStable = true, onReconnect, initialViewState, onViewStateChange }: DataGridProps) {
  const gridResource = useMemo<GridResourceRef>(() => resource.kind === "external"
    ? { kind: "external", relationId: resource.relationId }
    : { kind: "source", sourceId: resource.sourceId ?? source.id }, [resource.kind, resource.relationId, resource.sourceId, source.id]);
  const external = gridResource.kind === "external";
  const cacheBlockSize = external ? REMOTE_CACHE_BLOCK_SIZE : LOCAL_CACHE_BLOCK_SIZE;
  const columns = useMemo(() => validColumns(source.columns), [source.columns]);
  const restoredView = useRef(initialViewState).current;
  const sourceKey = `${source.id}:${source.status}:${columns.map((column) => `${column.name}:${column.type}`).join("|")}`;
  const sourceVersion = `${sourceKey}:${source.rowCount ?? "unknown"}:${source.updatedAt ?? ""}`;
  const initialColumnState = useMemo(() => safeLoadState(projectId, source.id, columns), [columns, projectId, source.id]);
  const initialView = useMemo(() => viewFromColumnState(initialColumnState, columns, restoredView?.filters), [columns, initialColumnState, restoredView]);
  const initialGridState = useMemo<GridState | undefined>(() => restoredView ? {
    filter: { filterModel: restoreFilterModel(restoredView.filters, columns) },
  } : undefined, [columns, restoredView]);
  const previewRows = useMemo(() => safeRows(source.previewRows).slice(0, PREVIEW_ROW_LIMIT), [source.previewRows]);

  const apiRef = useRef<GridApi<DataRow> | null>(null);
  const columnStateRef = useRef<ColumnState[]>(initialColumnState);
  const viewRef = useRef<GridViewState>(initialView);
  const callbackRef = useRef(onViewStateChange);
  const cellRequestRef = useRef(0);
  callbackRef.current = onViewStateChange;

  const [columnSearch, setColumnSearch] = useState("");
  const [columnState, setColumnState] = useState<ColumnState[]>(initialColumnState);
  const [viewState, setViewState] = useState<GridViewState>(initialView);
  const shouldLoadRows = source.status === "ready" && source.rowCount !== 0;
  const [resolvedRowCount, setResolvedRowCount] = useState<number | null>(source.rowCount);
  const [rowsLoading, setRowsLoading] = useState(shouldLoadRows);
  const [restoringView, setRestoringView] = useState(Boolean(restoredView));
  const [firstBlockLoaded, setFirstBlockLoaded] = useState(false);
  const [loadingRange, setLoadingRange] = useState({ start: 0, end: cacheBlockSize });
  const [loadingStartedAt, setLoadingStartedAt] = useState(() => Date.now());
  const [loadingNow, setLoadingNow] = useState(() => Date.now());
  const [loadError, setLoadError] = useState<string>();
  const [viewer, setViewer] = useState<CellViewer>();
  const [fullValue, setFullValue] = useState("");
  const [cellLoading, setCellLoading] = useState(false);
  const [cellError, setCellError] = useState<string>();
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  const ready = source.status === "ready";
  const previewing = source.status === "preview" || source.status === "preparing";

  const publishViewState = useCallback((next: GridViewState) => {
    viewRef.current = next;
    setViewState((current) => sameView(current, next) ? current : next);
    callbackRef.current?.(next);
  }, []);

  useEffect(() => {
    setResolvedRowCount(source.rowCount);
  }, [source.rowCount]);

  useEffect(() => {
    setRowsLoading(shouldLoadRows);
    setFirstBlockLoaded(false);
    setLoadingRange({ start: 0, end: cacheBlockSize });
    const now = Date.now();
    setLoadingStartedAt(now);
    setLoadingNow(now);
  }, [cacheBlockSize, shouldLoadRows]);

  useEffect(() => {
    if (!rowsLoading) return;
    const update = () => setLoadingNow(Date.now());
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [rowsLoading]);

  useEffect(() => {
    if (!restoringView) return;
    const timer = window.setTimeout(() => setRestoringView(false), RESTORED_VIEW_LOADING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [restoringView]);

  useEffect(() => {
    callbackRef.current?.(viewRef.current);
  }, []);

  useEffect(() => () => {
    cellRequestRef.current += 1;
  }, []);

  const synchronizeFromApi = useCallback((api: GridApi<DataRow>, persist = false) => {
    try {
      const state = api.getColumnState();
      const filters = adaptFilterModel(api.getFilterModel(), columns);
      columnStateRef.current = state;
      setColumnState(state);
      if (persist) safeSaveState(projectId, source.id, state);
      publishViewState(viewFromColumnState(state, columns, filters));
      return true;
    } catch {
      return false;
    }
  }, [columns, projectId, publishViewState, source.id]);

  const updateWithoutGrid = useCallback((next: ColumnState[], filters = viewRef.current.filters) => {
    columnStateRef.current = next;
    setColumnState(next);
    safeSaveState(projectId, source.id, next);
    publishViewState(viewFromColumnState(next, columns, filters));
  }, [columns, projectId, publishViewState, source.id]);

  const columnDefs = useMemo<ColDef<DataRow>[]>(() => columns.map((column) => {
    const valueCategory = category(column);
    return {
      colId: column.name,
      field: column.name,
      headerName: column.name,
      headerTooltip: `${column.name} · ${column.type}`,
      cellDataType: false,
      minWidth: 80,
      initialWidth: Math.min(280, Math.max(110, column.name.length * 8 + 38)),
      maxWidth: 640,
      sortable: ready,
      filter: ready ? filterFor(column) : false,
      filterParams: ready ? { debounceMs: 300, maxNumConditions: 2, buttons: ["reset"] } : undefined,
      floatingFilter: ready,
      resizable: true,
      editable: false,
      suppressHeaderMenuButton: !ready,
      valueFormatter: ({ value }) => readable(value, valueCategory),
      tooltipValueGetter: ({ value }) => fullValueText(value),
      cellClass: `ducs-data-grid__cell ducs-data-grid__cell--${valueCategory}`,
    };
  }), [columns, ready]);

  const datasource = useMemo<IDatasource | undefined>(() => {
    if (!ready) return undefined;
    let active = true;
    let pendingRequests = 0;
    return {
      ...(!external && typeof source.rowCount === "number" && source.rowCount >= 0 ? { rowCount: source.rowCount } : {}),
      getRows(params) {
        setLoadError(undefined);
        const startRow = Number.isFinite(params.startRow) ? Math.max(0, Math.floor(params.startRow)) : 0;
        const endRow = Number.isFinite(params.endRow)
          ? Math.max(startRow, Math.floor(params.endRow))
          : startRow + cacheBlockSize;
        setLoadingRange({ start: startRow, end: endRow });
        if (startRow === 0) setFirstBlockLoaded(false);
        const limit = endRow - startRow;
        let sorts: RowSort[] = [];
        let filters: RowFilter[] = [];
        try {
          ({ sorts, filters } = adaptGetRowsParams(params, columns));
        } catch {
          // Ignore malformed AG Grid models at the bridge boundary.
        }
        const visibleColumns = viewRef.current.visibleColumns;
        publishViewState({ sorts, filters, visibleColumns });
        const cacheKey = rowBlockCacheKey(projectId, sourceVersion, startRow, endRow, sorts, filters, visibleColumns);
        const cached = external ? undefined : localRowBlockCache.get(cacheKey);
        if (cached) {
          setResolvedRowCount(cached.totalRows);
          params.successCallback(cached.rows, cached.totalRows);
          if (startRow === 0) {
            setFirstBlockLoaded(true);
            setRestoringView(false);
          }
          setRowsLoading(false);
          return;
        }

        if (pendingRequests === 0) {
          const now = Date.now();
          setLoadingStartedAt(now);
          setLoadingNow(now);
        }
        pendingRequests += 1;
        setRowsLoading(true);

        void bridge.GetRows({
          projectId,
          resource: gridResource,
          offset: startRow,
          limit,
          sorts,
          filters,
          visibleColumns,
        }).then((response) => {
          if (!active) return;
          const rows = safeRows(response?.rows);
          const responseTotal = response?.totalRows;
          const totalRows = typeof responseTotal === "number" && Number.isFinite(responseTotal) && responseTotal >= 0
            ? Math.floor(responseTotal)
            : !external && typeof source.rowCount === "number" && source.rowCount >= 0
              ? Math.floor(source.rowCount)
              : response?.hasMore === false || rows.length < limit ? startRow + rows.length : -1;
          if (totalRows >= 0) setResolvedRowCount(totalRows);
          if (!external && totalRows >= 0) cacheRowBlock(cacheKey, { rows, totalRows });
          params.successCallback(rows, totalRows);
          if (startRow === 0) {
            setFirstBlockLoaded(true);
            setRestoringView(false);
          }
        }).catch((error: unknown) => {
          if (!active) return;
          if (startRow === 0) setRestoringView(false);
          setLoadError(getErrorMessage(error));
          params.failCallback();
        }).finally(() => {
          if (!active) return;
          pendingRequests = Math.max(0, pendingRequests - 1);
          setRowsLoading(pendingRequests > 0);
        });
      },
      destroy() {
        active = false;
      },
    };
  }, [cacheBlockSize, columns, external, gridResource, projectId, publishViewState, ready, source.rowCount, sourceVersion]);

  const onGridReady = useCallback((event: GridReadyEvent<DataRow>) => {
    apiRef.current = event.api;
    try {
      event.api.setGridAriaProperty("label", `${source.displayName} data grid`);
      event.api.applyColumnState({ state: columnStateRef.current, applyOrder: true });
      if (ready && datasource) event.api.setGridOption("datasource", datasource);
      synchronizeFromApi(event.api);
    } catch {
      apiRef.current = null;
    }
  }, [datasource, ready, source.displayName, synchronizeFromApi]);

  const persistColumns = useCallback((event: ColumnMovedEvent<DataRow> | ColumnResizedEvent<DataRow> | ColumnVisibleEvent<DataRow>) => {
    if ("finished" in event && event.finished === false) return;
    synchronizeFromApi(event.api, true);
    if (ready && event.type === "columnVisible") {
      try {
        event.api.purgeInfiniteCache();
      } catch {
        // Ignore events racing with grid teardown.
      }
    }
  }, [ready, synchronizeFromApi]);

  const onSortChanged = useCallback((event: SortChangedEvent<DataRow>) => {
    synchronizeFromApi(event.api, true);
  }, [synchronizeFromApi]);

  const onFilterChanged = useCallback((event: FilterChangedEvent<DataRow>) => {
    synchronizeFromApi(event.api);
  }, [synchronizeFromApi]);

  const setVisibility = useCallback((updates: ReadonlyMap<string, boolean>) => {
    const api = apiRef.current;
    if (api) {
      try {
        api.applyColumnState({
          state: Array.from(updates, ([colId, visible]) => ({ colId, hide: !visible })),
        });
        synchronizeFromApi(api, true);
        if (ready) api.purgeInfiniteCache();
        return;
      } catch {
        apiRef.current = null;
      }
    }
    updateWithoutGrid(columnStateRef.current.map((column) => updates.has(column.colId)
      ? { ...column, hide: !updates.get(column.colId) }
      : column));
  }, [ready, synchronizeFromApi, updateWithoutGrid]);

  const showColumn = useCallback((name: string, visible: boolean) => {
    setVisibility(new Map([[name, visible]]));
  }, [setVisibility]);

  const showAll = useCallback(() => {
    setVisibility(new Map(columns.map((column) => [column.name, true])));
  }, [columns, setVisibility]);

  const hideAll = useCallback(() => {
    setVisibility(new Map(columns.map((column) => [column.name, false])));
  }, [columns, setVisibility]);

  const autoSize = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    try {
      api.autoSizeAllColumns(false);
      synchronizeFromApi(api, true);
    } catch {
      apiRef.current = null;
    }
  }, [synchronizeFromApi]);

  const reset = useCallback(() => {
    const api = apiRef.current;
    if (api) {
      try {
        api.resetColumnState();
        synchronizeFromApi(api);
        safeClearState(projectId, source.id);
        if (ready) api.purgeInfiniteCache();
        return;
      } catch {
        apiRef.current = null;
      }
    }
    const next = columns.map((column) => ({ colId: column.name, hide: false }));
    columnStateRef.current = next;
    setColumnState(next);
    safeClearState(projectId, source.id);
    publishViewState(viewFromColumnState(next, columns, viewRef.current.filters));
  }, [columns, projectId, publishViewState, ready, source.id, synchronizeFromApi]);

  const openCell = useCallback((event: CellDoubleClickedEvent<DataRow>) => {
    const rowIndex = event.node.rowIndex;
    const column = event.column.getColId();
    if (rowIndex === null || rowIndex < 0 || !columns.some((item) => item.name === column)) return;

    const next: CellViewer = { rowIndex, column };
    const previewValue = fullValueText(event.value);
    setViewer(next);
    setFullValue(previewValue);
    setCellError(undefined);
    setCopyStatus("idle");
    setCellLoading(false);
    if (!ready) return;

    const requestId = ++cellRequestRef.current;
    setCellLoading(true);
    void bridge.GetCellValue({
      projectId,
      resource: gridResource,
      rowIndex,
      column,
      sorts: viewRef.current.sorts,
      filters: viewRef.current.filters,
    }).then((response) => {
      if (cellRequestRef.current !== requestId) return;
      setFullValue(fullValueText(response.value));
    }).catch((error: unknown) => {
      if (cellRequestRef.current !== requestId) return;
      setCellError(getErrorMessage(error));
    }).finally(() => {
      if (cellRequestRef.current === requestId) setCellLoading(false);
    });
  }, [columns, gridResource, projectId, ready]);

  const copyValue = useCallback(async () => {
    try {
      await copyToClipboard(fullValue);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }, [fullValue]);

  const closeViewer = useCallback(() => {
    cellRequestRef.current += 1;
    setViewer(undefined);
    setCellLoading(false);
    setCellError(undefined);
    setCopyStatus("idle");
  }, []);

  const hidden = useMemo(
    () => new Map(columnState.map((column) => [column.colId, column.hide === true])),
    [columnState],
  );
  const order = useMemo(
    () => new Map(columnState.map((column, index) => [column.colId, index])),
    [columnState],
  );
  const orderedColumns = useMemo(
    () => [...columns].sort((left, right) => (order.get(left.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.name) ?? Number.MAX_SAFE_INTEGER)),
    [columns, order],
  );
  const matchingColumns = orderedColumns.filter((column) => column.name.toLocaleLowerCase().includes(columnSearch.trim().toLocaleLowerCase()));
  const visibleCount = columns.filter((column) => !hidden.get(column.name)).length;
  // A filtered result can legitimately contain zero rows. Keep the grid
  // mounted in that case so its headers and filter controls remain usable.
  const zeroRows = (ready && source.rowCount === 0) || (previewing && previewRows.length === 0);
  const gridMounted = columns.length > 0 && visibleCount > 0 && !zeroRows;
  const loadingElapsedSeconds = Math.max(0, Math.floor((loadingNow - loadingStartedAt) / 1000));
  const loadingFirstBlock = loadingRange.start === 0 && !firstBlockLoaded;
  const loadingLabel = loadingFirstBlock
    ? `Loading first ${loadingRange.end - loadingRange.start} rows${external ? " from the remote database" : ""}…`
    : `Loading rows ${(loadingRange.start + 1).toLocaleString()}–${loadingRange.end.toLocaleString()}${external ? " from the remote database" : ""}…`;

  useEffect(() => {
    if (!gridMounted) apiRef.current = null;
  }, [gridMounted]);

  if (source.status === "failed") {
    return (
      <div className="ducs-data-grid">
        <GridMessage title="Import failed" detail={source.error?.message ?? "The source could not be prepared."} destructive />
      </div>
    );
  }
  if (source.status === "cancelled") {
    return (
      <div className="ducs-data-grid">
        <GridMessage title="Import cancelled" detail="You can close this tab or retry the source." />
      </div>
    );
  }

  return (
    <section className="ducs-data-grid" aria-label={`${source.displayName} data`}>
      {columns.length > 0 ? (
        <div className="ducs-data-grid__toolbar flex h-9 shrink-0 items-center gap-1.5 border-b border-border bg-card px-2" role="toolbar" aria-label="Data grid controls">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <Columns3 aria-hidden="true" />
                Columns
                <span className="text-muted-foreground">{visibleCount}/{columns.length}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64" onCloseAutoFocus={(event) => event.preventDefault()}>
              <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
              <div className="px-1 pb-1" onKeyDown={(event) => event.stopPropagation()}>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" aria-hidden="true" />
                  <Input
                    aria-label="Search columns"
                    value={columnSearch}
                    onChange={(event) => setColumnSearch(event.target.value)}
                    className="pl-7"
                    placeholder="Search columns…"
                  />
                </div>
              </div>
              <div className="max-h-64 overflow-y-auto" role="group" aria-label="Column visibility">
                {matchingColumns.map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.name}
                    checked={!hidden.get(column.name)}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(checked) => showColumn(column.name, checked === true)}
                  >
                    <span className="min-w-0 flex-1 truncate">{column.name}</span>
                    <span className="font-mono text-[9px] text-muted-foreground">{column.type}</span>
                  </DropdownMenuCheckboxItem>
                ))}
                {matchingColumns.length === 0 ? (
                  <p className="px-2 py-4 text-center text-[11px] text-muted-foreground">No matching columns</p>
                ) : null}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={(event) => { event.preventDefault(); showAll(); }} disabled={visibleCount === columns.length}>Show all</DropdownMenuItem>
              <DropdownMenuItem onSelect={(event) => { event.preventDefault(); hideAll(); }} disabled={visibleCount === 0}>Hide all</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="sm" onClick={autoSize} disabled={!gridMounted || !apiRef.current}>
            <WandSparkles aria-hidden="true" /> Auto-size
          </Button>
          <Button variant="ghost" size="sm" onClick={reset}>
            <RotateCcw aria-hidden="true" /> Reset layout
          </Button>
          <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
            {viewState.filters.length > 0 ? (
              <span className="ducs-num rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 font-medium text-brand-300">{viewState.filters.length} filter{viewState.filters.length === 1 ? "" : "s"}</span>
            ) : null}
            <span className="ducs-num rounded-full border border-border bg-white/[0.03] px-2 py-0.5">{resolvedRowCount === null ? (external ? "Total unknown" : "Rows calculating…") : `${resolvedRowCount.toLocaleString()} rows`}</span>
          </div>
        </div>
      ) : null}

      {previewing ? (
        <div className="ducs-data-grid__preparing" role="status">
          <span>Preparing for fast queries…</span> <span>Previewing the first {previewRows.length} rows</span>
        </div>
      ) : null}
      {ready && !zeroRows && rowsLoading && !restoringView && !loadError ? (
        <div role="status" aria-live="polite" className="ducs-trace flex items-center gap-2 border-b border-primary/20 bg-primary/[0.06] px-3 py-1.5 text-[10px] text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin text-primary" />
          <span>{loadingLabel}</span>
          {loadingElapsedSeconds > 0 ? <span className="ducs-num ml-auto">{loadingElapsedSeconds}s elapsed</span> : null}
          {external && loadingFirstBlock && loadingElapsedSeconds >= 5 ? <span>Only this page is being fetched.</span> : null}
        </div>
      ) : null}
      {external && !pagingStable ? <div role="status" className="border-b border-warning/25 bg-warning/10 px-3 py-1.5 text-[10px] text-warning">No stable key was detected. Rows may shift between pages while the remote source changes.</div> : null}
      {loadError ? (
        <div role="alert" className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          <span className="min-w-0 flex-1">{loadError}</span>
          <Button variant="secondary" size="sm" onClick={() => {
            setLoadError(undefined);
            setRowsLoading(true);
            if (loadingRange.start === 0) setFirstBlockLoaded(false);
            const now = Date.now();
            setLoadingStartedAt(now);
            setLoadingNow(now);
            apiRef.current?.purgeInfiniteCache();
          }}><RotateCcw /> Retry rows</Button>
          {external && onReconnect ? <Button variant="secondary" size="sm" onClick={onReconnect}>Reconnect</Button> : null}
        </div>
      ) : null}

      <div className="ducs-data-grid__content">
        {columns.length === 0 ? (
          <GridMessage title="No columns found" detail="This source did not expose a tabular schema." />
        ) : visibleCount === 0 ? (
          <GridMessage title="No visible columns" detail="Use Columns → Show all to restore the table." />
        ) : zeroRows ? (
          <GridMessage title="No rows" detail="There are no rows to display." />
        ) : (
          <div className="ducs-data-grid__grid ag-theme-quartz-dark" data-testid="data-grid-surface">
            <AgGridReact<DataRow>
              key={`${sourceKey}:${ready ? "infinite" : "preview"}`}
              columnDefs={columnDefs}
              initialState={initialGridState}
              defaultColDef={{ editable: false, resizable: true, suppressMovable: false }}
              rowModelType={ready ? "infinite" : "clientSide"}
              rowData={previewing ? previewRows : undefined}
              cacheBlockSize={cacheBlockSize}
              maxBlocksInCache={6}
              blockLoadDebounceMillis={150}
              maxConcurrentDatasourceRequests={external ? 1 : 2}
              infiniteInitialRowCount={1}
              loading={ready && rowsLoading && !restoringView && !firstBlockLoaded && !loadError}
              overlayLoadingTemplate={`<span>Loading first ${cacheBlockSize} rows${external ? " from the remote database" : ""}…</span>`}
              rowHeight={32}
              headerHeight={36}
              floatingFiltersHeight={32}
              enableCellTextSelection
              enableBrowserTooltips
              tooltipShowDelay={350}
              ensureDomOrder
              suppressFieldDotNotation
              suppressCellFocus={false}
              suppressRowClickSelection
              animateRows={false}
              onGridReady={onGridReady}
              onColumnMoved={persistColumns}
              onColumnResized={persistColumns}
              onColumnVisible={persistColumns}
              onSortChanged={onSortChanged}
              onFilterChanged={onFilterChanged}
              onCellDoubleClicked={openCell}
              overlayNoRowsTemplate="<span>No rows match this view</span>"
            />
          </div>
        )}
      </div>

      <Dialog open={Boolean(viewer)} onOpenChange={(open) => { if (!open) closeViewer(); }}>
        <DialogContent className="ducs-data-grid__viewer max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Expand className="size-4 text-primary" aria-hidden="true" /> {viewer?.column}
            </DialogTitle>
            <DialogDescription>Row {(viewer?.rowIndex ?? 0) + 1} · full cell value</DialogDescription>
          </DialogHeader>
          {cellLoading ? <div className="ducs-data-grid__viewer-status" role="status">Loading full value…</div> : null}
          {cellError ? <div className="ducs-data-grid__viewer-error" role="alert">{cellError}</div> : null}
          <pre className="ducs-data-grid__full-value ducs-selectable-text" tabIndex={0}>{fullValue}</pre>
          <div className="ducs-data-grid__viewer-actions">
            <span role="status" aria-live="polite">
              {copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : ""}
            </span>
            <Button variant="secondary" onClick={() => void copyValue()} disabled={cellLoading}>
              <Copy aria-hidden="true" /> Copy value
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function GridMessage({ title, detail, destructive = false }: { title: string; detail: string; destructive?: boolean }) {
  return (
    <div className="ducs-data-grid__empty" role={destructive ? "alert" : "status"}>
      <strong className={destructive ? "text-destructive" : undefined}>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

export function DataGrid(props: DataGridProps) {
  const schemaKey = props.source.columns.map((column) => `${column.name}:${column.type}`).join("|");
  return <DataGridInner key={`${props.projectId ?? props.source.projectId}:${props.resource?.kind ?? "source"}:${props.source.id}:${props.source.status}:${schemaKey}`} {...props} />;
}

export default DataGrid;
