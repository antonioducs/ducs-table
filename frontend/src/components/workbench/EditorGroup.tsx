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
        "relative flex h-full min-h-0 min-w-0 flex-col bg-background transition-shadow duration-300 ease-soft",
        focused && "ring-1 ring-inset ring-primary/20",
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
          <div className="absolute inset-0 grid place-items-center overflow-hidden bg-background text-center">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 opacity-30 [mask-image:radial-gradient(circle_at_50%_50%,black,transparent_70%)]"
              style={{
                backgroundImage:
                  "linear-gradient(rgba(160,255,205,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(160,255,205,.05) 1px, transparent 1px)",
                backgroundSize: "40px 40px",
              }}
            />
            <div className="ducs-rise relative">
              <span className="mx-auto grid size-11 place-items-center rounded-xl border border-border bg-card/70 text-primary/80 shadow-[inset_0_1px_0_rgba(215,255,235,.05)]">
                <FileCode2 className="size-4.5" aria-hidden="true" />
              </span>
              <p className="ducs-display mt-3 text-[14px] text-foreground">This split is empty</p>
              <p className="mx-auto mt-1 max-w-64 text-[11px] leading-4 text-muted-foreground">
                Open a table from {projectName ?? "the sidebar"}, drag a tab here, or start a query.
              </p>
              <div className="mt-4 flex items-center justify-center gap-2">
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
              "pointer-events-none absolute z-20 animate-ducs-fade bg-gradient-to-br from-primary/25 to-primary/10 ring-1 ring-inset ring-primary/60 backdrop-blur-[1px]",
              edge === "horizontal" ? "inset-y-0 right-0 w-1/2" : "inset-x-0 bottom-0 h-1/2",
            )}
          />
        )}
      </div>
    </section>
  );
}
