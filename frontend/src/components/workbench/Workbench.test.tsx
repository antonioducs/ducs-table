import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectLayoutNode, ProjectTabGroup } from "@/types";
import type { AppTab } from "@/stores/app-store";
import { EditorGroup } from "./EditorGroup";
import { WorkbenchLayout } from "./WorkbenchLayout";
import { TAB_DRAG_TYPE } from "@/components/layout/TabsBar";

afterEach(cleanup);

const tabs: AppTab[] = [
  { id: "tab-orders", kind: "local", title: "Orders", sourceId: "orders" },
  { id: "tab-query", kind: "sql", title: "Query 1", documentId: "doc-1" },
];

const group: ProjectTabGroup = { id: "group-a", tabIds: ["tab-orders", "tab-query"], activeTabId: "tab-query" };

function groupProps(overrides: Partial<React.ComponentProps<typeof EditorGroup>> = {}) {
  return {
    group,
    tabs,
    focused: true,
    onFocus: vi.fn(),
    onSelectTab: vi.fn(),
    onCloseTab: vi.fn(),
    onCloseOthers: vi.fn(),
    onNewQuery: vi.fn(),
    onSplit: vi.fn(),
    onDropTab: vi.fn(),
    onDropSplit: vi.fn(),
    ...overrides,
  };
}

function withPointer(event: Event, clientX: number, clientY: number): Event {
  Object.defineProperty(event, "clientX", { value: clientX });
  Object.defineProperty(event, "clientY", { value: clientY });
  return event;
}

function dragEventData(tabId: string) {
  return {
    dataTransfer: {
      types: [TAB_DRAG_TYPE],
      getData: () => tabId,
      setData: vi.fn(),
      effectAllowed: "move",
    },
  };
}

describe("workbench editor group", () => {
  it("renders the active tab content and its own tab strip", () => {
    render(<EditorGroup {...groupProps()}><div>Query editor</div></EditorGroup>);
    expect(screen.getByRole("tab", { name: "Orders" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Query 1" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Query editor")).toBeInTheDocument();
  });

  it("offers an empty state that can start a query", async () => {
    const onNewQuery = vi.fn();
    render(<EditorGroup {...groupProps({ group: { id: "group-a", tabIds: [] }, tabs: [], onNewQuery })} />);
    expect(screen.getByText("This split is empty")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New query" }));
    expect(onNewQuery).toHaveBeenCalledOnce();
  });

  it("splits from the tab context menu", async () => {
    const onSplit = vi.fn();
    render(<EditorGroup {...groupProps({ onSplit })}><div /></EditorGroup>);
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Orders" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Split right/i }));
    expect(onSplit).toHaveBeenCalledWith("horizontal", "tab-orders");
  });

  it("moves a dropped tab into the strip and splits on the edge", () => {
    const onDropTab = vi.fn();
    const onDropSplit = vi.fn();
    render(<EditorGroup {...groupProps({ onDropTab, onDropSplit })}><div>content</div></EditorGroup>);

    const strip = screen.getByRole("tablist");
    fireEvent.dragOver(strip, dragEventData("tab-external"));
    fireEvent.drop(strip, dragEventData("tab-external"));
    expect(onDropTab).toHaveBeenCalledWith("tab-external", expect.any(Number));

    const surface = screen.getByText("content").parentElement!;
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 200, width: 400, height: 200, toJSON: () => ({}),
    });
    // jsdom drops pointer coordinates from DragEvent, so they are set explicitly.
    fireEvent(surface, withPointer(createEvent.dragOver(surface, dragEventData("tab-external")), 380, 20));
    expect(surface.querySelector('[data-drop-edge="horizontal"]')).toBeInTheDocument();
    fireEvent(surface, withPointer(createEvent.drop(surface, dragEventData("tab-external")), 380, 20));
    expect(onDropSplit).toHaveBeenCalledWith("tab-external", "horizontal");
  });

  it("does not let an internal tab drop bubble into the global file importer", () => {
    const globalDrop = vi.fn();
    render(<div onDrop={globalDrop}><EditorGroup {...groupProps()}><div>content</div></EditorGroup></div>);

    const strip = screen.getByRole("tablist");
    fireEvent.drop(strip, dragEventData("tab-orders"));

    expect(globalDrop).not.toHaveBeenCalled();
  });
});

describe("workbench layout tree", () => {
  it("renders one panel per group leaf", () => {
    const layout: ProjectLayoutNode = {
      kind: "split",
      direction: "vertical",
      size: 100,
      children: [
        { kind: "group", groupId: "group-a", size: 60 },
        { kind: "group", groupId: "group-b", size: 40 },
      ],
    };
    render(<WorkbenchLayout layout={layout} onResize={vi.fn()} renderGroup={(groupId) => <div>{groupId}</div>} />);
    expect(screen.getByText("group-a")).toBeInTheDocument();
    expect(screen.getByText("group-b")).toBeInTheDocument();
  });
});
