import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColDef, GridReadyEvent, GridState, IDatasource, IGetRowsParams } from "ag-grid-community";
import type { DataRow, SourceInfo } from "@/types";

const gridHarness = vi.hoisted(() => {
  let datasource: IDatasource | undefined;
  return {
    getDatasource: () => datasource,
    setDatasource: (next: IDatasource) => { datasource = next; },
    reset: () => { datasource = undefined; },
  };
});

const bridgeHarness = vi.hoisted(() => ({
  getRows: vi.fn(),
}));

vi.mock("ag-grid-community", () => ({
  ClientSideRowModelModule: { moduleName: "ClientSideRowModelModule" },
  InfiniteRowModelModule: { moduleName: "InfiniteRowModelModule" },
  ModuleRegistry: { registerModules: vi.fn() },
}));

vi.mock("ag-grid-react", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");
  return {
    AgGridReact: ({
      rowData,
      rowModelType,
      columnDefs,
      cacheBlockSize,
      loading,
      onGridReady,
      initialState,
    }: {
      rowData?: DataRow[];
      rowModelType?: string;
      columnDefs?: ColDef<DataRow>[];
      cacheBlockSize?: number;
      loading?: boolean;
      onGridReady?: (event: GridReadyEvent<DataRow>) => void;
      initialState?: GridState;
    }) => {
      useEffect(() => {
        if (rowModelType !== "infinite") return;
        const state = (columnDefs ?? []).map((column) => ({ colId: column.colId }));
        onGridReady?.({
          api: {
            setGridAriaProperty: vi.fn(),
            applyColumnState: vi.fn(),
            getColumnState: () => state,
            getFilterModel: () => initialState?.filter?.filterModel ?? {},
            setGridOption: (key: string, value: IDatasource) => {
              if (key === "datasource") gridHarness.setDatasource(value);
            },
          },
        } as unknown as GridReadyEvent<DataRow>);
      }, [columnDefs, initialState, onGridReady, rowModelType]);

      return (
        <div
          role="grid"
          data-row-count={rowData?.length ?? 0}
          data-row-model={rowModelType}
          data-column-count={columnDefs?.length ?? 0}
          data-sort-disabled={String(columnDefs?.every((column) => column.sortable === false))}
          data-filter-disabled={String(columnDefs?.every((column) => column.filter === false))}
          data-cache-block-size={cacheBlockSize}
          data-loading={String(loading)}
          data-filter-state={JSON.stringify(initialState?.filter?.filterModel ?? {})}
        />
      );
    },
  };
});

vi.mock("@/lib/bridge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/bridge")>("@/lib/bridge");
  return {
    ...actual,
    bridge: { ...actual.bridge, GetRows: bridgeHarness.getRows },
  };
});

import { DataGrid } from "./DataGrid";

function source(overrides: Partial<SourceInfo> = {}): SourceInfo {
  return {
    id: "source-1",
    displayName: "People",
    tableName: "people",
    kind: "csv",
    rowCount: 1,
    status: "preview",
    isEphemeral: false,
    columns: [
      { name: "name", type: "VARCHAR", nullable: false, ordinal: 0 },
      { name: "age", type: "INTEGER", nullable: true, ordinal: 1 },
    ],
    previewRows: [{ name: "Ada", age: 36 }],
    ...overrides,
    projectId: overrides.projectId ?? "project-1",
  };
}

describe("DataGrid", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    sessionStorage.clear();
    gridHarness.reset();
    bridgeHarness.getRows.mockReset();
  });

  it("searches and toggles columns from the Columns menu", async () => {
    const user = userEvent.setup();
    const onViewStateChange = vi.fn();
    render(<DataGrid source={source()} onViewStateChange={onViewStateChange} />);

    await user.click(screen.getByRole("button", { name: /Columns/i }));
    const search = await screen.findByRole("textbox", { name: "Search columns" });
    await user.type(search, "age");

    expect(screen.getByRole("menuitemcheckbox", { name: /age/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: /name varchar/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("menuitemcheckbox", { name: /age/i }));
    await waitFor(() => {
      expect(onViewStateChange).toHaveBeenLastCalledWith({
        sorts: [],
        filters: [],
        visibleColumns: ["name"],
      });
    });

    await user.click(screen.getByRole("menuitem", { name: "Hide all" }));
    await waitFor(() => {
      expect(onViewStateChange).toHaveBeenLastCalledWith({
        sorts: [],
        filters: [],
        visibleColumns: [],
      });
    });
    expect(screen.getByRole("menuitem", { name: "Show all" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Hide all" })).toHaveAttribute("aria-disabled", "true");

    await user.click(screen.getByRole("menuitem", { name: "Show all" }));
    await waitFor(() => {
      expect(onViewStateChange).toHaveBeenLastCalledWith({
        sorts: [],
        filters: [],
        visibleColumns: ["name", "age"],
      });
    });
    expect(screen.getByRole("menuitemcheckbox", { name: /age/i })).toBeChecked();
  });

  it("renders the no-columns state and publishes an empty view", async () => {
    const onViewStateChange = vi.fn();
    render(
      <DataGrid
        source={source({ status: "ready", columns: [], previewRows: undefined, rowCount: 0 })}
        onViewStateChange={onViewStateChange}
      />,
    );

    expect(screen.getByText("No columns found")).toBeInTheDocument();
    await waitFor(() => {
      expect(onViewStateChange).toHaveBeenCalledWith({ sorts: [], filters: [], visibleColumns: [] });
    });
  });

  it("shows a ready zero-row source without an infinite loading state", () => {
    render(<DataGrid source={source({ status: "ready", previewRows: undefined, rowCount: 0 })} />);

    expect(screen.getByText("0 rows")).toBeInTheDocument();
    expect(screen.getByText("No rows")).toBeInTheDocument();
    expect(screen.queryByText(/Loading first/)).not.toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });

  it("keeps columns mounted when a filter returns no rows", async () => {
    bridgeHarness.getRows.mockResolvedValue({
      resource: { kind: "source", sourceId: "source-1" },
      sourceId: "source-1",
      columns: source().columns,
      rows: [],
      offset: 0,
      limit: 250,
      totalRows: 0,
      hasMore: false,
      pagingStable: true,
    });
    render(<DataGrid source={source({ status: "ready", previewRows: undefined, rowCount: 4 })} />);
    await waitFor(() => expect(gridHarness.getDatasource()).toBeDefined());

    const successCallback = vi.fn();
    await act(async () => {
      gridHarness.getDatasource()!.getRows({
        startRow: 0,
        endRow: 250,
        sortModel: [],
        filterModel: { name: { filterType: "text", type: "equals", filter: "Nobody" } },
        context: undefined,
        successCallback,
        failCallback: vi.fn(),
      });
    });

    await waitFor(() => expect(successCallback).toHaveBeenCalledWith([], 0));
    expect(screen.getByRole("grid")).toHaveAttribute("data-column-count", "2");
    expect(screen.getByText("0 rows")).toBeInTheDocument();
    expect(screen.queryByText("No rows")).not.toBeInTheDocument();
  });

  it("restores filters without showing the initial loading overlay", () => {
    render(
      <DataGrid
        source={source({ status: "ready", previewRows: undefined, rowCount: 4 })}
        initialViewState={{
          sorts: [],
          filters: [{ column: "name", type: "text", operator: "equals", value: "Ada" }],
          visibleColumns: ["name", "age"],
        }}
      />,
    );

    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("data-loading", "false");
    expect(JSON.parse(grid.getAttribute("data-filter-state") ?? "{}")).toEqual({
      name: { filterType: "text", type: "equals", filter: "Ada" },
    });
  });

  it("reuses a loaded local block when the same filtered grid remounts", async () => {
    const cachedSource = source({ id: "cached-source", status: "ready", previewRows: undefined, rowCount: 4 });
    const initialViewState = {
      sorts: [],
      filters: [{ column: "name", type: "text" as const, operator: "equals" as const, value: "Ada" }],
      visibleColumns: ["name", "age"],
    };
    bridgeHarness.getRows.mockResolvedValue({
      resource: { kind: "source", sourceId: cachedSource.id },
      sourceId: cachedSource.id,
      columns: cachedSource.columns,
      rows: [{ name: "Ada", age: 36 }],
      offset: 0,
      limit: 250,
      totalRows: 1,
      hasMore: false,
      pagingStable: true,
    });
    const request = (successCallback: ReturnType<typeof vi.fn>): IGetRowsParams => ({
      startRow: 0,
      endRow: 250,
      sortModel: [],
      filterModel: { name: { filterType: "text", type: "equals", filter: "Ada" } },
      context: undefined,
      successCallback,
      failCallback: vi.fn(),
    });

    const first = render(<DataGrid source={cachedSource} initialViewState={initialViewState} />);
    await waitFor(() => expect(gridHarness.getDatasource()).toBeDefined());
    const firstSuccess = vi.fn();
    await act(async () => gridHarness.getDatasource()!.getRows(request(firstSuccess)));
    await waitFor(() => expect(firstSuccess).toHaveBeenCalledWith([{ name: "Ada", age: 36 }], 1));
    first.unmount();

    gridHarness.reset();
    render(<DataGrid source={cachedSource} initialViewState={initialViewState} />);
    await waitFor(() => expect(gridHarness.getDatasource()).toBeDefined());
    const restoredSuccess = vi.fn();
    act(() => gridHarness.getDatasource()!.getRows(request(restoredSuccess)));

    expect(restoredSuccess).toHaveBeenCalledWith([{ name: "Ada", age: 36 }], 1);
    expect(bridgeHarness.getRows).toHaveBeenCalledOnce();
  });

  it("caps preparing previews at 200 rows with sorting and filters disabled", () => {
    const previewRows = Array.from({ length: 240 }, (_, index) => ({ name: `Person ${index}`, age: index }));
    render(<DataGrid source={source({ status: "preparing", previewRows, rowCount: null })} />);

    expect(screen.getByText(/Preparing for fast queries…/)).toBeInTheDocument();
    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("data-row-count", "200");
    expect(grid).toHaveAttribute("data-row-model", "clientSide");
    expect(grid).toHaveAttribute("data-sort-disabled", "true");
    expect(grid).toHaveAttribute("data-filter-disabled", "true");
  });

  it("shows unknown totals and unstable paging for live relations", () => {
    render(<DataGrid source={source({ id:"relation",status:"ready",previewRows:undefined,rowCount:null })} resource={{kind:"external",relationId:"relation"}} pagingStable={false} />);
    expect(screen.getByText("Total unknown")).toBeInTheDocument();
    expect(screen.getByText(/No stable key was detected/)).toBeInTheDocument();
    expect(screen.getByText(/Loading first 100 rows from the remote database/)).toBeInTheDocument();
    expect(screen.getByRole("grid")).toHaveAttribute("data-row-model","infinite");
    expect(screen.getByRole("grid")).toHaveAttribute("data-cache-block-size","100");
    expect(screen.getByRole("grid")).toHaveAttribute("data-loading","true");
  });
});
