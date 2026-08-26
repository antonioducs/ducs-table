import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppTab } from "@/stores/app-store";
import type { SavedQuery, SourceInfo } from "@/types";
import { Sidebar } from "./Sidebar";
import { SidebarToggle } from "./SidebarToggle";
import { SidebarRail } from "./SidebarRail";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StatusBar } from "./StatusBar";
import { TabsBar } from "./TabsBar";
import { TopBar } from "./TopBar";

afterEach(cleanup);

function firePointer(target: Element, type: string, values: { pointerId: number; clientX: number; clientY: number; button?: number }) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId },
    clientX: { value: values.clientX },
    clientY: { value: values.clientY },
    button: { value: values.button ?? 0 },
  });
  fireEvent(target, event);
}

describe("layout controls", () => {
  it("exposes the compact top-level actions", () => {
    const onOpen = vi.fn();
    const onExport = vi.fn();
    const onToggleJobs = vi.fn();
    const onToggleAI = vi.fn();
    render(<TopBar onOpen={onOpen} onExport={onExport} onToggleJobs={onToggleJobs} onToggleAI={onToggleAI} activeJobs={2} canExport />);

    fireEvent.click(screen.getByRole("button", { name: "Open files" }));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("button", { name: "Jobs, 2 active" }));
    fireEvent.click(screen.getByRole("button", { name: "AI" }));

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onExport).toHaveBeenCalledOnce();
    expect(onToggleJobs).toHaveBeenCalledOnce();
    expect(onToggleAI).toHaveBeenCalledOnce();
  });

  it("uses an edge handle when open and a dedicated action rail when collapsed", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<TooltipProvider><SidebarToggle open onToggle={onToggle} /></TooltipProvider>);

    const hideButton = screen.getByRole("button", { name: "Hide sidebar" });
    expect(hideButton).toHaveClass("left-1/2", "-translate-x-1/2", "rounded-full");
    fireEvent.click(hideButton);
    expect(onToggle).toHaveBeenCalledOnce();

    const onNewQuery = vi.fn();
    const onOpenFiles = vi.fn();
    const onAddConnection = vi.fn();
    rerender(
      <TooltipProvider>
        <SidebarRail onExpand={onToggle} onNewQuery={onNewQuery} onOpenFiles={onOpenFiles} onAddConnection={onAddConnection} />
      </TooltipProvider>,
    );

    expect(screen.getByRole("complementary", { name: "Collapsed sidebar actions" })).toHaveClass("w-12");
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "New query" }));
    fireEvent.click(screen.getByRole("button", { name: "Open files" }));
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onNewQuery).toHaveBeenCalledOnce();
    expect(onOpenFiles).toHaveBeenCalledOnce();
    expect(onAddConnection).toHaveBeenCalledOnce();
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

  it("places the emphasized new-query action before the taller tabs", () => {
    const tabs: AppTab[] = [{ id: "source:one", sourceId: "one", title: "Orders", kind: "local" }];
    const onNewQuery = vi.fn();
    render(<TabsBar tabs={tabs} activeTabId={tabs[0].id} onSelect={vi.fn()} onClose={vi.fn()} onNewQuery={onNewQuery} />);

    const tablist = screen.getByRole("tablist");
    const newQuery = screen.getByRole("button", { name: "New query tab" });
    expect(tablist).toHaveClass("h-10");
    expect(tablist.firstElementChild).toContainElement(newQuery);
    expect(newQuery).toHaveClass("size-8", "bg-primary/15", "text-primary");

    fireEvent.click(newQuery);
    expect(onNewQuery).toHaveBeenCalledOnce();
  });

  it("states the local-processing guarantees", () => {
    render(<StatusBar activeJobs={0} />);
    expect(screen.getByText("Processed locally")).toBeInTheDocument();
    expect(screen.getByText("DuckDB local")).toBeInTheDocument();
  });

  it("shows persistent tables but keeps ephemeral query output attached to its query", () => {
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
    expect(screen.queryByText("Result 1")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Results" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy table name orders" }));
    expect(onCopyTable).toHaveBeenCalledWith(table);
  });

  it("quick-deletes a ready table only after a left swipe crosses the threshold", async () => {
    vi.useFakeTimers();
    const table: SourceInfo = {
      projectId: "project-1", id: "table-1", displayName: "Orders", tableName: "orders", kind: "csv",
      rowCount: 2, status: "ready", isEphemeral: false, columns: [],
    };
    const onQuickRemoveSource = vi.fn().mockResolvedValue(undefined);
    const onSelectSource = vi.fn();
    render(
      <Sidebar
        sources={[table]}
        savedQueries={[]}
        onSelectSource={onSelectSource}
        onInsertTable={vi.fn()}
        onSelectSavedQuery={vi.fn()}
        onDeleteSavedQuery={vi.fn()}
        onRemoveSource={vi.fn()}
        onQuickRemoveSource={onQuickRemoveSource}
      />,
    );
    const rowButton = screen.getByText("Orders").closest("button")!;
    const row = rowButton.closest("[data-swipe-offset]")!;
    const swipeAction = row.querySelector("[data-swipe-action-visible]")!;

    expect(swipeAction).toHaveAttribute("data-swipe-action-visible", "false");
    expect(swipeAction).toHaveClass("opacity-0");

    firePointer(rowButton, "pointerdown", { pointerId: 1, clientX: 200, clientY: 20 });
    firePointer(rowButton, "pointermove", { pointerId: 1, clientX: 165, clientY: 20 });
    expect(swipeAction).toHaveAttribute("data-swipe-action-visible", "true");
    expect(swipeAction).toHaveClass("opacity-100");
    firePointer(rowButton, "pointerup", { pointerId: 1, clientX: 165, clientY: 20 });
    expect(onQuickRemoveSource).not.toHaveBeenCalled();
    expect(row).toHaveAttribute("data-swipe-offset", "0");
    expect(swipeAction).toHaveAttribute("data-swipe-action-visible", "false");
    expect(swipeAction).toHaveClass("opacity-0");

    firePointer(rowButton, "pointerdown", { pointerId: 2, clientX: 200, clientY: 20 });
    firePointer(rowButton, "pointermove", { pointerId: 2, clientX: 110, clientY: 20 });
    firePointer(rowButton, "pointerup", { pointerId: 2, clientX: 110, clientY: 20 });

    expect(row.closest("[data-removal-phase]")).toHaveAttribute("data-removal-phase", "sliding");
    expect(onQuickRemoveSource).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(220); });
    expect(row.closest("[data-removal-phase]")).toHaveAttribute("data-removal-phase", "collapsing");
    expect(onQuickRemoveSource).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(180); });
    expect(onQuickRemoveSource).toHaveBeenCalledWith(table);
    expect(onSelectSource).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("filters sources and renames a ready table inline", async () => {
    const orders: SourceInfo = {
      projectId: "project-1",
      id: "orders",
      displayName: "Pedidos São Paulo",
      tableName: "orders_sp",
      sourcePath: "/imports/orders.csv",
      kind: "csv",
      rowCount: 2,
      status: "ready",
      isEphemeral: false,
      columns: [],
    };
    const customers: SourceInfo = { ...orders, id: "customers", displayName: "Customers", tableName: "customers", sourcePath: "/imports/customers.csv" };
    const onRenameSource = vi.fn().mockResolvedValue(undefined);
    render(
      <Sidebar
        sources={[orders, customers]}
        savedQueries={[]}
        onSelectSource={vi.fn()}
        onInsertTable={vi.fn()}
        onRenameSource={onRenameSource}
        onSelectSavedQuery={vi.fn()}
        onDeleteSavedQuery={vi.fn()}
        onRemoveSource={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search files" }), { target: { value: "sao paulo" } });
    expect(screen.getByText("Pedidos São Paulo")).toBeInTheDocument();
    expect(screen.queryByText("Customers")).not.toBeInTheDocument();

    fireEvent.doubleClick(screen.getByText("Pedidos São Paulo").closest("button")!);
    const renameInput = screen.getByRole("textbox", { name: "Rename Pedidos São Paulo" });
    fireEvent.change(renameInput, { target: { value: "Pedidos 2026" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });

    await waitFor(() => expect(onRenameSource).toHaveBeenCalledWith(orders, "Pedidos 2026"));
  });

  it("renames a saved query inline on double click and Enter", async () => {
    const query: SavedQuery = { projectId: "project-1", id: "query-1", name: "Query 1", sql: "select 1" };
    const onRenameSavedQuery = vi.fn().mockResolvedValue(undefined);
    render(
      <Sidebar
        sources={[]}
        savedQueries={[query]}
        onSelectSource={vi.fn()}
        onInsertTable={vi.fn()}
        onSelectSavedQuery={vi.fn()}
        onRenameSavedQuery={onRenameSavedQuery}
        onDeleteSavedQuery={vi.fn()}
        onRemoveSource={vi.fn()}
      />,
    );

    fireEvent.doubleClick(screen.getByText("Query 1").closest("button")!);
    const input = screen.getByRole("textbox", { name: "Rename saved query Query 1" });
    fireEvent.change(input, { target: { value: "Monthly revenue" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onRenameSavedQuery).toHaveBeenCalledWith(query, "Monthly revenue"));
  });
});
