import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppTab } from "@/stores/app-store";
import type { SourceInfo } from "@/types";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TabsBar } from "./TabsBar";
import { TopBar } from "./TopBar";

afterEach(cleanup);

describe("layout controls", () => {
  it("exposes the compact top-level actions", () => {
    const onOpen = vi.fn();
    const onExport = vi.fn();
    const onToggleJobs = vi.fn();
    render(<TopBar onOpen={onOpen} onExport={onExport} onToggleJobs={onToggleJobs} activeJobs={2} canExport />);

    fireEvent.click(screen.getByRole("button", { name: "Open files" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("button", { name: "Jobs, 2 active" }));

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onExport).toHaveBeenCalledOnce();
    expect(onToggleJobs).toHaveBeenCalledOnce();
  });

  it("keeps tab selection and close actions separate", () => {
    const tabs: AppTab[] = [
      { id: "source:one", sourceId: "one", title: "Orders", kind: "local" },
      { id: "source:two", sourceId: "two", title: "Result 1", kind: "local", isResult: true },
    ];
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<TabsBar tabs={tabs} activeTabId={tabs[0].id} onSelect={onSelect} onClose={onClose} />);

    fireEvent.click(screen.getByRole("tab", { name: "Result 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Orders" }));

    expect(onSelect).toHaveBeenCalledWith("source:two");
    expect(onClose).toHaveBeenCalledWith("source:one");
  });

  it("preserves keyboard navigation between project-local tabs", () => {
    const tabs: AppTab[] = [
      { id: "source:one", sourceId: "one", title: "Orders", kind: "local" },
      { id: "source:two", sourceId: "two", title: "Result 1", kind: "local", isResult: true },
    ];
    const onSelect = vi.fn();
    render(<TabsBar tabs={tabs} activeTabId={tabs[0].id} onSelect={onSelect} onClose={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Orders" }), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledWith("source:two");
  });

  it("states the local-processing guarantees", () => {
    render(<StatusBar activeJobs={0} />);
    expect(screen.getByText("Processed locally")).toBeInTheDocument();
    expect(screen.getByText("DuckDB local")).toBeInTheDocument();
  });

  it("separates persistent tables from ephemeral results and delegates copy", () => {
    const table: SourceInfo = {
      projectId: "project-1",
      id: "table-1",
      displayName: "Orders",
      tableName: "orders",
      kind: "csv",
      rowCount: 2,
      status: "ready",
      isEphemeral: false,
      columns: [],
    };
    const result: SourceInfo = { ...table, id: "result-1", displayName: "Result 1", tableName: "result_1", isEphemeral: true };
    const onCopyTable = vi.fn();
    render(
      <Sidebar
        sources={[table, result]}
        savedQueries={[]}
        onSelectSource={vi.fn()}
        onInsertTable={vi.fn()}
        onCopyTable={onCopyTable}
        onSelectSavedQuery={vi.fn()}
        onDeleteSavedQuery={vi.fn()}
        onRemoveSource={vi.fn()}
      />,
    );

    expect(screen.getByText("Orders")).toBeInTheDocument();
    expect(screen.getByText("Result 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy table name orders" }));
    expect(onCopyTable).toHaveBeenCalledWith(table);
  });
});
