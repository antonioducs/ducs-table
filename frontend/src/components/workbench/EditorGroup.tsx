import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FileCode2, FolderOpen } from "lucide-react";
import type { AppTab } from "@/stores/app-store";
import type { ProjectTabGroup, SplitDirection } from "@/types";
import { Button } from "@/components/ui/button";
import { TabsBar, TAB_DRAG_TYPE } from "@/components/layout/TabsBar";
import { cn } from "@/lib/utils";

export interface EditorGroupProps {
  group: ProjectTabGroup;
  tabs: AppTab[];
  focused: boolean;
  /** Content of the group's active tab; undefined for an empty group. */
  children?: ReactNode;
  projectName?: string;
  onFocus: () => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  onNewQuery: () => void;
  onSplit: (direction: SplitDirection, tabId: string) => void;
  onDropTab: (tabId: string, index: number) => void;
  /** Dropping on an edge splits the group in that direction. */
  onDropSplit: (tabId: string, direction: SplitDirection) => void;
  onOpenFiles?: () => void;
  contentHost?: HTMLDivElement;
  hasPersistentContent?: boolean;
}

type EdgeZone = SplitDirection | undefined;

export function EditorGroup({
  group,
  tabs,
  focused,
  children,
  projectName,
  onFocus,
  onSelectTab,
  onCloseTab,
  onCloseOthers,
  onNewQuery,
  onSplit,
  onDropTab,
  onDropSplit,
  onOpenFiles,
  contentHost,
  hasPersistentContent = false,
}: EditorGroupProps) {
  const [edge, setEdge] = useState<EdgeZone>();
  const contentSurfaceRef = useRef<HTMLDivElement>(null);
  const onDropTabRef = useRef(onDropTab);
  const onDropSplitRef = useRef(onDropSplit);
  const tabCountRef = useRef(tabs.length);
  onDropTabRef.current = onDropTab;
  onDropSplitRef.current = onDropSplit;
  tabCountRef.current = tabs.length;

  const edgeFor = (event: DragEvent, surface: HTMLDivElement): EdgeZone => {
    const bounds = surface.getBoundingClientRect();
    const right = (event.clientX - bounds.left) / bounds.width > 0.72;
    const bottom = (event.clientY - bounds.top) / bounds.height > 0.72;
    if (right) return "horizontal";
    if (bottom) return "vertical";
    return undefined;
  };

  useLayoutEffect(() => {
    const surface = contentSurfaceRef.current;
    if (!surface) return;
    if (contentHost) surface.appendChild(contentHost);

    const isTabDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes(TAB_DRAG_TYPE);
    const accept = (event: DragEvent) => {
      if (!isTabDrag(event)) return false;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      return true;
    };
    const enter = (event: DragEvent) => {
      if (accept(event)) setEdge(edgeFor(event, surface));
    };
    const over = (event: DragEvent) => {
      if (accept(event)) setEdge(edgeFor(event, surface));
    };
    const leave = (event: DragEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && surface.contains(next)) return;
      setEdge(undefined);
    };
    const drop = (event: DragEvent) => {
      if (!accept(event)) return;
      const tabId = event.dataTransfer?.getData(TAB_DRAG_TYPE) ?? "";
      const zone = edgeFor(event, surface);
      setEdge(undefined);
      if (!tabId) return;
      if (zone) onDropSplitRef.current(tabId, zone);
      else onDropTabRef.current(tabId, tabCountRef.current);
    };

    surface.addEventListener("dragenter", enter);
    surface.addEventListener("dragover", over);
    surface.addEventListener("dragleave", leave);
    surface.addEventListener("drop", drop);
    return () => {
      surface.removeEventListener("dragenter", enter);
      surface.removeEventListener("dragover", over);
      surface.removeEventListener("dragleave", leave);
      surface.removeEventListener("drop", drop);
      if (contentHost?.parentNode === surface) surface.removeChild(contentHost);
    };
  }, [contentHost]);

  return (
    <section
      aria-label={`Editor group ${group.id}`}
      data-group-id={group.id}
      data-focused={focused || undefined}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col bg-background",
        focused && "ring-1 ring-inset ring-primary/25",
      )}
      onFocusCapture={onFocus}
    >
      <TabsBar
        tabs={tabs}
        activeTabId={group.activeTabId}
        groupId={group.id}
        focused={focused}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onCloseOthers={onCloseOthers}
        onNewQuery={onNewQuery}
        onSplit={onSplit}
        onDropTab={onDropTab}
        onFocus={onFocus}
      />
      <div
        ref={contentSurfaceRef}
        data-tab-content-surface={group.id}
        className="relative min-h-0 flex-1"
        onMouseDown={onFocus}
      >
        {contentHost ? null : children}
        {!children && !hasPersistentContent && (
          <div className="absolute inset-0 grid place-items-center bg-background text-center">
            <div>
              <p className="text-[12px] text-foreground">This split is empty</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Open a table from {projectName ?? "the sidebar"}, drag a tab here, or start a query.
              </p>
              <div className="mt-3 flex items-center justify-center gap-2">
                <Button variant="secondary" size="sm" onClick={onNewQuery}><FileCode2 /> New query</Button>
                {onOpenFiles && <Button variant="ghost" size="sm" onClick={onOpenFiles}><FolderOpen /> Open files</Button>}
              </div>
            </div>
          </div>
        )}
        {edge && (
          <div
            aria-hidden="true"
            data-drop-edge={edge}
            className={cn(
              "pointer-events-none absolute z-20 bg-primary/20 ring-1 ring-primary/50",
              edge === "horizontal" ? "inset-y-0 right-0 w-1/2" : "inset-x-0 bottom-0 h-1/2",
            )}
          />
        )}
      </div>
    </section>
  );
}
