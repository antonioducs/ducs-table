import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColDef } from "ag-grid-community";
import type { DataRow, SourceInfo } from "@/types";

vi.mock("ag-grid-community", () => ({
  ClientSideRowModelModule: { moduleName: "ClientSideRowModelModule" },
  InfiniteRowModelModule: { moduleName: "InfiniteRowModelModule" },
  ModuleRegistry: { registerModules: vi.fn() },
}));

vi.mock("ag-grid-react", () => ({
  AgGridReact: ({
    rowData,
    rowModelType,
    columnDefs,
  }: {
    rowData?: DataRow[];
    rowModelType?: string;
    columnDefs?: ColDef<DataRow>[];
  }) => (
    <div
      role="grid"
      data-row-count={rowData?.length ?? 0}
      data-row-model={rowModelType}
      data-sort-disabled={String(columnDefs?.every((column) => column.sortable === false))}
      data-filter-disabled={String(columnDefs?.every((column) => column.filter === false))}
    />
  ),
}));

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
  };
}

describe("DataGrid", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    localStorage.clear();
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
    expect(screen.getByRole("menuitem", { name: "Show all" })).toBeInTheDocument();
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
});
