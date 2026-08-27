import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bootstrap, ProjectSession } from "@/types";
import { TAB_DRAG_TYPE } from "@/components/layout/TabsBar";

const bridgeHarness = vi.hoisted(() => {
  let resultSequence = 0;
  const runQuery = vi.fn(async () => {
    resultSequence += 1;
    return {
      projectId: "p1",
      source: {
        projectId: "p1", id: `result-${resultSequence}`, displayName: "Query result", sqlName: `result_${resultSequence}`, sourceType: "query",
        rowCount: resultSequence, isEphemeral: true, columns: [], originalSQL: "SELECT 1",
      },
      rowCount: resultSequence,
      durationMs: 3,
    };
  });
  const closeResult = vi.fn(async () => undefined);
  const removeDataset = vi.fn(async () => undefined);
  const saveResultAsTable = vi.fn(async (request: { projectId: string; resultId: string; displayName: string }) => ({
    projectId: request.projectId,
    id: request.resultId,
    displayName: request.displayName,
    sqlName: "pinned_result",
    sourceType: "query",
    rowCount: 1,
    isEphemeral: false,
    columns: [],
    originalSQL: "SELECT 1",
  }));
  const saveQuery = vi.fn(async (request: { projectId: string; id?: string; name: string; sql: string }) => ({
    projectId: request.projectId,
    id: request.id ?? "saved-query",
    name: request.name,
    sql: request.sql,
  }));
  return {
    handlers: {} as Record<string, (payload: unknown) => void>,
    runQuery,
    closeResult,
    removeDataset,
    saveResultAsTable,
    saveQuery,
    reset: () => {
      resultSequence = 0;
      runQuery.mockClear();
      closeResult.mockClear();
      removeDataset.mockClear();
      saveResultAsTable.mockClear();
      saveQuery.mockClear();
    },
  };
});

const gridRenderHarness = vi.hoisted(() => ({
  mounts: vi.fn(),
  unmounts: vi.fn(),
  reset() {
    this.mounts.mockClear();
    this.unmounts.mockClear();
  },
}));

const editorRenderHarness = vi.hoisted(() => ({
  mounts: vi.fn(),
  unmounts: vi.fn(),
  reset() {
    this.mounts.mockClear();
    this.unmounts.mockClear();
  },
}));

vi.mock("@/components/data-grid/DataGrid", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");
  function MockDataGrid({ source, initialViewState, onViewStateChange }: { source: { displayName: string }; initialViewState?: { filters: unknown[] }; onViewStateChange?: (view: { sorts: never[]; filters: { column: string; type: "text"; operator: "equals"; value: string }[]; visibleColumns: string[] }) => void }) {
    useEffect(() => {
      gridRenderHarness.mounts();
      return () => gridRenderHarness.unmounts();
    }, []);
    return (
      <div data-testid="grid" data-initial-filter-count={initialViewState?.filters.length ?? 0}>
        {source.displayName} grid
        <button type="button" aria-label="Set test grid filter" onClick={() => onViewStateChange?.({ sorts: [], filters: [{ column: "name", type: "text", operator: "equals", value: "Ada" }], visibleColumns: ["name"] })}>Set filter</button>
      </div>
    );
  }
  return {
    __esModule: true,
    default: MockDataGrid,
  };
});

vi.mock("@uiw/react-codemirror", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");
  function MockCodeMirror({ value, onChange, ...props }: { value: string; onChange: (value: string) => void; [key: string]: unknown }) {
    useEffect(() => {
      editorRenderHarness.mounts();
      return () => editorRenderHarness.unmounts();
    }, []);
    return <textarea aria-label={String(props["aria-label"] ?? "SQL query")} value={value} onChange={(event) => onChange(event.target.value)} />;
  }
  return {
    default: MockCodeMirror,
  };
});

const session: ProjectSession = {
  version: 2,
  documents: [{ id: "doc-1", title: "Query 1", sql: "SELECT 1" }],
  tabs: [
    { id: "tab-orders", kind: "local", title: "Orders", sourceId: "orders" },
    { id: "tab-query", kind: "sql", title: "Query 1", documentId: "doc-1" },
  ],
  groups: [
    { id: "group-data", tabIds: ["tab-orders"], activeTabId: "tab-orders" },
    { id: "group-sql", tabIds: ["tab-query"], activeTabId: "tab-query" },
  ],
  layout: {
    kind: "split",
    direction: "vertical",
    size: 100,
    children: [
      { kind: "group", groupId: "group-data", size: 71 },
      { kind: "group", groupId: "group-sql", size: 29 },
    ],
  },
  activeGroupId: "group-sql",
  history: [],
  resultSequence: 0,
};

const bootstrap: Bootstrap = {
  projects: [{ id: "p1", name: "Analytics", description: "", lastOpenedAt: "", createdAt: "", updatedAt: "" }],
  activeProjectId: "p1",
  workspace: {
    project: { id: "p1", name: "Analytics", description: "", lastOpenedAt: "", createdAt: "", updatedAt: "" },
    sources: [{
      projectId: "p1", id: "orders", displayName: "Orders", tableName: "orders", kind: "csv",
      rowCount: 3, status: "ready", isEphemeral: false, columns: [],
    }],
    savedQueries: [],
    connections: [],
    externalRelations: [],
    session,
  },
  jobs: [],
  ready: true,
};

vi.mock("@/lib/bridge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/bridge")>("@/lib/bridge");
  return {
    ...actual,
    bridge: {
      Bootstrap: vi.fn(async () => bootstrap),
      ListGlobalConnections: vi.fn(async () => []),
      SaveProjectSession: vi.fn(async () => undefined),
      RunQuery: bridgeHarness.runQuery,
      CloseResult: bridgeHarness.closeResult,
      RemoveDataset: bridgeHarness.removeDataset,
      SaveResultAsTable: bridgeHarness.saveResultAsTable,
      SaveQuery: bridgeHarness.saveQuery,
      on: vi.fn((name: string, callback: (payload: unknown) => void) => {
        bridgeHarness.handlers[name] = callback;
        return () => { delete bridgeHarness.handlers[name]; };
      }),
    },
  };
});

import App from "./App";
import { useAppStore } from "@/stores/app-store";

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
  bridgeHarness.reset();
  gridRenderHarness.reset();
  editorRenderHarness.reset();
  bootstrap.workspace!.savedQueries = [];
  for (const name of Object.keys(bridgeHarness.handlers)) delete bridgeHarness.handlers[name];
});

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

function fireTabDragOver(target: Element, clientX: number, clientY: number) {
  const event = new Event("dragover", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY },
    dataTransfer: {
      value: {
        types: [TAB_DRAG_TYPE],
        files: { length: 0 },
        getData: () => "tab-query",
        dropEffect: "none",
      },
    },
  });
  fireEvent(target, event);
}

describe("workbench shell", () => {
  it("renders a split session with a grid and an editor side by side", async () => {
    render(<App />);

    expect(await screen.findByTestId("grid")).toHaveTextContent("Orders grid");
    expect(screen.getByRole("textbox", { name: "SQL query Query 1" })).toHaveValue("SELECT 1");
    expect(screen.getAllByRole("tablist")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "Orders" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Query 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide sidebar" }).closest("[data-sidebar-resize-handle]")).toHaveClass("w-1");
  });

  it("moves a filtered grid between groups without remounting it", async () => {
    render(<App />);
    const grid = await screen.findByTestId("grid");
    expect(grid).toHaveAttribute("data-initial-filter-count", "0");
    expect(gridRenderHarness.mounts).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Set test grid filter" }));
    act(() => useAppStore.getState().moveTab("p1", "tab-orders", "group-sql"));

    await waitFor(() => expect(useAppStore.getState().projectWorkspaces.p1.session.groups.find((group) => group.id === "group-sql")?.activeTabId).toBe("tab-orders"));
    expect(await screen.findByTestId("grid")).toHaveTextContent("Orders grid");
    expect(gridRenderHarness.mounts).toHaveBeenCalledOnce();
    expect(gridRenderHarness.unmounts).not.toHaveBeenCalled();
  });

  it("moves a query editor between groups without remounting it", async () => {
    render(<App />);
    expect(await screen.findByRole("textbox", { name: "SQL query Query 1" })).toHaveValue("SELECT 1");
    expect(editorRenderHarness.mounts).toHaveBeenCalledOnce();

    act(() => useAppStore.getState().moveTab("p1", "tab-query", "group-data"));

    await waitFor(() => expect(useAppStore.getState().projectWorkspaces.p1.session.groups.find((group) => group.id === "group-data")?.activeTabId).toBe("tab-query"));
    expect(await screen.findByRole("textbox", { name: "SQL query Query 1" })).toHaveValue("SELECT 1");
    expect(editorRenderHarness.mounts).toHaveBeenCalledOnce();
    expect(editorRenderHarness.unmounts).not.toHaveBeenCalled();
  });

  it("collapses a split after its last tab closes without remounting the remaining grid", async () => {
    render(<App />);
    expect(await screen.findByTestId("grid")).toHaveTextContent("Orders grid");
    expect(gridRenderHarness.mounts).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole("button", { name: "Close Query 1" }));

    await waitFor(() => {
      const current = useAppStore.getState().projectWorkspaces.p1.session;
      expect(current.groups).toHaveLength(1);
      expect(current.layout.kind).toBe("group");
    });
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.getByTestId("grid")).toHaveTextContent("Orders grid");
    expect(gridRenderHarness.mounts).toHaveBeenCalledOnce();
    expect(gridRenderHarness.unmounts).not.toHaveBeenCalled();
  });

  it("shows the edge overlay when a tab is dragged over persistent grid content", async () => {
    render(<App />);
    const grid = await screen.findByTestId("grid");
    const surface = grid.closest('[data-group-id]')?.querySelector<HTMLElement>('[data-tab-content-surface]');
    expect(surface).toBeTruthy();
    vi.spyOn(surface!, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 200, width: 400, height: 200, toJSON: () => ({}),
    });

    fireTabDragOver(grid, 380, 20);

    expect(surface!.querySelector('[data-drop-edge="horizontal"]')).toBeInTheDocument();
  });

  it("prevents native file navigation when a nested surface swallows drop events", async () => {
    render(<App />);
    const surface = await screen.findByTestId("grid");
    surface.addEventListener("dragover", (event) => event.stopPropagation());
    surface.addEventListener("drop", (event) => event.stopPropagation());

    const fileDragEvent = (type: "dragover" | "drop") => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: { files: { length: 1 }, types: ["Files"] },
      });
      return event;
    };
    const dragOver = fileDragEvent("dragover");
    const drop = fileDragEvent("drop");

    fireEvent(surface, dragOver);
    fireEvent(surface, drop);

    expect(dragOver.defaultPrevented).toBe(true);
    expect(drop.defaultPrevented).toBe(true);
  });

  it("opens an extra query tab in the query group without losing the previous one", async () => {
    render(<App />);
    await screen.findByTestId("grid");

    const [, sqlStrip] = screen.getAllByRole("tablist");
    const newQuery = Array.from(sqlStrip.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === "New query tab");
    await userEvent.click(newQuery!);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Query 2" })).toBeInTheDocument();
    });
    expect(screen.getByRole("tab", { name: "Query 1" })).toBeInTheDocument();
    const groups = useAppStore.getState().projectWorkspaces.p1.session.groups;
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.id === "group-sql")?.tabIds).toHaveLength(2);
  });

  it("persists a saved-query rename from the sidebar", async () => {
    bootstrap.workspace!.savedQueries = [{ projectId: "p1", id: "saved-orders", name: "Saved orders", sql: "select * from orders" }];
    render(<App />);
    await screen.findByTestId("grid");

    const savedSQL = screen.getByRole("region", { name: "Saved SQL" });
    fireEvent.doubleClick(within(savedSQL).getByText("Saved orders").closest("button")!);
    const input = screen.getByRole("textbox", { name: "Rename saved query Saved orders" });
    fireEvent.change(input, { target: { value: "Orders by month" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(bridgeHarness.saveQuery).toHaveBeenCalledWith({
      projectId: "p1", id: "saved-orders", name: "Orders by month", sql: "select * from orders",
    }));
    await waitFor(() => expect(useAppStore.getState().projectWorkspaces.p1.savedQueriesById["saved-orders"].name).toBe("Orders by month"));
  });

  it("removes a table immediately after a committed left swipe without confirmation", async () => {
    render(<App />);
    await screen.findByTestId("grid");
    const tables = screen.getByRole("region", { name: "Tables" });
    const rowButton = within(tables).getByText("Orders").closest("button")!;

    firePointer(rowButton, "pointerdown", { pointerId: 1, clientX: 220, clientY: 20 });
    firePointer(rowButton, "pointermove", { pointerId: 1, clientX: 120, clientY: 20 });
    firePointer(rowButton, "pointerup", { pointerId: 1, clientX: 120, clientY: 20 });

    await waitFor(() => expect(bridgeHarness.removeDataset).toHaveBeenCalledWith({ projectId: "p1", id: "orders" }));
    await waitFor(() => expect(useAppStore.getState().projectWorkspaces.p1.sourcesById.orders).toBeUndefined());
    expect(screen.queryByText("Remove this dataset?")).not.toBeInTheDocument();
  });

  it("shows a query result below the editor without creating another tab", async () => {
    render(<App />);
    await screen.findByTestId("grid");

    await userEvent.click(screen.getByRole("button", { name: /Run ⌘↵/i }));

    expect(await screen.findByText("Result 1 grid")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "SQL query Query 1" })).toBeInTheDocument();
    expect(screen.getByLabelText("Output for Query 1")).toBeInTheDocument();
    const current = useAppStore.getState().projectWorkspaces.p1.session;
    expect(current.activeGroupId).toBe("group-sql");
    expect(current.groups.find((group) => group.id === "group-sql")?.activeTabId).toBe("tab-query");
    expect(current.tabs).toHaveLength(2);
    expect(screen.queryByRole("tab", { name: "Result 1" })).not.toBeInTheDocument();
  });

  it("does not let the global result-ready event force-open a result tab", async () => {
    render(<App />);
    await screen.findByTestId("grid");

    act(() => bridgeHarness.handlers["ducs:result-ready"]({
      projectId: "p1",
      source: {
        projectId: "p1", id: "background-result", displayName: "Background result", sqlName: "background_result",
        sourceType: "query", rowCount: 1, isEphemeral: true, columns: [],
      },
    }));

    await waitFor(() => expect(useAppStore.getState().projectWorkspaces.p1.sourcesById["background-result"]).toBeDefined());
    expect(useAppStore.getState().projectWorkspaces.p1.session.tabs).toHaveLength(2);
    expect(screen.queryByRole("tab", { name: "Background result" })).not.toBeInTheDocument();
  });

  it("replaces the attached output and discards the previous ephemeral result", async () => {
    render(<App />);
    await screen.findByTestId("grid");

    await userEvent.click(screen.getByRole("button", { name: /Run ⌘↵/i }));
    expect(await screen.findByText("Result 1 grid")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Run ⌘↵/i }));

    expect(await screen.findByText("Result 2 grid")).toBeInTheDocument();
    await waitFor(() => expect(bridgeHarness.closeResult).toHaveBeenCalledWith({ projectId: "p1", id: "result-1" }));
    await waitFor(() => expect(useAppStore.getState().projectWorkspaces.p1.sourcesById["result-1"]).toBeUndefined());
    expect(screen.queryByRole("tab", { name: /Result/ })).not.toBeInTheDocument();
  });

  it("keeps the last successful output visible when a rerun fails", async () => {
    render(<App />);
    await screen.findByTestId("grid");
    await userEvent.click(screen.getByRole("button", { name: /Run ⌘↵/i }));
    expect(await screen.findByText("Result 1 grid")).toBeInTheDocument();

    bridgeHarness.runQuery.mockRejectedValueOnce(new Error("Broken SQL"));
    await userEvent.click(screen.getByRole("button", { name: /Run ⌘↵/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Broken SQL");
    expect(screen.getByText("Result 1 grid")).toBeInTheDocument();
    expect(bridgeHarness.closeResult).not.toHaveBeenCalled();
  });

  it("discards ephemeral output when its query closes", async () => {
    render(<App />);
    await screen.findByTestId("grid");
    await userEvent.click(screen.getByRole("button", { name: /Run ⌘↵/i }));
    await screen.findByText("Result 1 grid");

    await userEvent.click(screen.getByRole("button", { name: "Close Query 1" }));

    await waitFor(() => expect(bridgeHarness.closeResult).toHaveBeenCalledWith({ projectId: "p1", id: "result-1" }));
    await waitFor(() => expect(useAppStore.getState().projectWorkspaces.p1.sourcesById["result-1"]).toBeUndefined());
  });

  it("promotes the attached output into the Tables list", async () => {
    render(<App />);
    await screen.findByTestId("grid");
    await userEvent.click(screen.getByRole("button", { name: /Run ⌘↵/i }));
    await screen.findByText("Result 1 grid");

    await userEvent.click(screen.getByRole("button", { name: "Save as table" }));
    await userEvent.type(screen.getByPlaceholderText("Name"), "Pinned result");
    await userEvent.click(screen.getByRole("button", { name: "Save table" }));

    await waitFor(() => expect(bridgeHarness.saveResultAsTable).toHaveBeenCalledWith({ projectId: "p1", resultId: "result-1", displayName: "Pinned result" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Tables" })).toHaveTextContent("Pinned result"));
    expect(screen.getByText("Saved table")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Results" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Run ⌘↵/i }));
    expect(await screen.findByText("Result 2 grid")).toBeInTheDocument();
    expect(bridgeHarness.closeResult).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Tables" })).toHaveTextContent("Pinned result");
  });

  it("splits a group from the tab context menu and keeps every tab reachable", async () => {
    render(<App />);
    await screen.findByTestId("grid");

    const orders = screen.getByRole("tab", { name: "Orders" });
    orders.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Split right/i }));

    await waitFor(() => {
      const state = useAppStore.getState().projectWorkspaces.p1.session;
      // A lone table tab is duplicated into the new group, mirroring VS Code.
      expect(state.groups).toHaveLength(3);
      expect(state.tabs).toHaveLength(3);
    });
    expect(screen.getAllByTestId("grid")).toHaveLength(2);
  });
});
