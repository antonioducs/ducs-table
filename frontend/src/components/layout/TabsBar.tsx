import { useState } from "react";
import {
  Columns2,
  DatabaseZap,
  FileCode2,
  Plus,
  Rows2,
  Table2,
  TerminalSquare,
  WifiOff,
  X,
} from "lucide-react";
import type { AppTab } from "@/stores/app-store";
import type { SplitDirection } from "@/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const TAB_DRAG_TYPE = "application/x-ducs-tab";

export interface TabsBarProps {
  tabs: readonly AppTab[];
  activeTabId?: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Group owning this strip; omitted in single-strip usages such as tests. */
  groupId?: string;
  focused?: boolean;
  onNewQuery?: () => void;
  onSplit?: (direction: SplitDirection, tabId: string) => void;
  onCloseOthers?: (tabId: string) => void;
  onDropTab?: (tabId: string, index: number) => void;
  onFocus?: () => void;
}

function tabIcon(tab: AppTab) {
  if (tab.kind === "sql") return FileCode2;
  if (tab.kind === "placeholder") return WifiOff;
  if (tab.kind === "external") return DatabaseZap;
  return tab.isResult ? TerminalSquare : Table2;
}

export function TabsBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  groupId,
  focused = false,
  onNewQuery,
  onSplit,
  onCloseOthers,
  onDropTab,
  onFocus,
}: TabsBarProps) {
  const [dropIndex, setDropIndex] = useState<number>();
  const [menuTabId, setMenuTabId] = useState<string>();
  const hasMenu = Boolean(onSplit || onCloseOthers);

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (event.key === "Delete") {
      event.preventDefault();
      onClose(tabs[index].id);
      return;
    }
    if (nextIndex === undefined) return;
    event.preventDefault();
    onSelect(tabs[nextIndex].id);
    const buttons = event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[nextIndex]?.focus();
  }

  const acceptsDrop = Boolean(onDropTab);
  const dropTargetIndex = (event: React.DragEvent, index: number) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX - bounds.left > bounds.width / 2 ? index + 1 : index;
  };

  return (
    <TooltipProvider delayDuration={450}>
      <div
        role="tablist"
        aria-label={groupId ? `Open tabs in group ${groupId}` : "Open sources"}
        data-focused={focused || undefined}
        className={cn(
          "ducs-glass-bar flex h-10 shrink-0 items-stretch overflow-x-auto border-b border-border bg-muted",
          focused && "bg-white/[0.03]",
        )}
        onMouseDown={onFocus}
        onDragOver={acceptsDrop ? (event) => {
          if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
          event.preventDefault();
          event.stopPropagation();
          if (dropIndex === undefined) setDropIndex(tabs.length);
        } : undefined}
        onDragLeave={acceptsDrop ? () => setDropIndex(undefined) : undefined}
        onDrop={acceptsDrop ? (event) => {
          if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
          event.preventDefault();
          event.stopPropagation();
          const tabId = event.dataTransfer.getData(TAB_DRAG_TYPE);
          const index = dropIndex ?? tabs.length;
          setDropIndex(undefined);
          if (!tabId) return;
          onDropTab?.(tabId, index);
        } : undefined}
      >
        {onNewQuery && (
          <div className="sticky left-0 z-10 flex h-full shrink-0 items-center border-r border-border bg-muted/95 px-2.5 backdrop-blur-xl">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-8 shrink-0 border border-primary/35 bg-primary/15 text-primary shadow-[inset_0_1px_0_rgba(255,255,255,.08),0_4px_14px_rgba(115,100,223,.16)] hover:border-primary/55 hover:bg-primary/25 hover:text-primary"
                  onClick={onNewQuery}
                  aria-label="New query tab"
                >
                  <Plus className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>New query (⌘T)</TooltipContent>
            </Tooltip>
          </div>
        )}
        {tabs.length === 0 && <span className="flex items-center px-3 text-[10px] text-muted-foreground">No open tabs</span>}
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          const Icon = tabIcon(tab);
          return (
            <div
              key={tab.id}
              draggable={acceptsDrop}
              onDragStart={acceptsDrop ? (event) => {
                event.stopPropagation();
                event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
                event.dataTransfer.effectAllowed = "move";
              } : undefined}
              onDragEnd={acceptsDrop ? (event) => {
                event.stopPropagation();
                setDropIndex(undefined);
              } : undefined}
              onDragOver={acceptsDrop ? (event) => {
                if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
                event.preventDefault();
                event.stopPropagation();
                setDropIndex(dropTargetIndex(event, index));
              } : undefined}
              className={cn(
                "group relative flex min-w-32 max-w-60 shrink-0 items-center border-r border-border",
                active ? "bg-white/[0.045] text-foreground" : "bg-transparent text-muted-foreground hover:bg-white/[0.035] hover:text-foreground",
                dropIndex === index && "border-l-2 border-l-primary",
                dropIndex === index + 1 && "border-r-2 border-r-primary",
              )}
            >
              {active && <span className={cn("absolute inset-x-0 top-0 h-0.5", focused ? "bg-primary" : "bg-primary/40")} aria-hidden="true" />}
              <button
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onSelect(tab.id)}
                onContextMenu={(event) => {
                  if (!hasMenu) return;
                  event.preventDefault();
                  setMenuTabId(tab.id);
                }}
                onKeyDown={(event) => handleKeyDown(event, index)}
                onAuxClick={(event) => { if (event.button === 1) onClose(tab.id); }}
                className="flex h-full min-w-0 flex-1 items-center gap-2 py-0 pl-3 pr-1.5 text-left text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <Icon className={cn("size-3.5 shrink-0", active && "text-primary")} aria-hidden="true" />
                <span className="truncate text-left" title={tab.title}>{tab.title}</span>
              </button>
              {hasMenu && (
                // The trigger is an inert overlay so the context menu can be
                // anchored to the tab without hijacking left-click or dragging.
                <DropdownMenu open={menuTabId === tab.id} onOpenChange={(open) => setMenuTabId(open ? tab.id : undefined)}>
                  <DropdownMenuTrigger asChild>
                    <span className="pointer-events-none absolute inset-0" aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuLabel className="truncate">{tab.title}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {onSplit && <DropdownMenuItem onSelect={() => onSplit("horizontal", tab.id)}><Columns2 aria-hidden="true" /> Split right</DropdownMenuItem>}
                    {onSplit && <DropdownMenuItem onSelect={() => onSplit("vertical", tab.id)}><Rows2 aria-hidden="true" /> Split down</DropdownMenuItem>}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => onClose(tab.id)}><X aria-hidden="true" /> Close tab</DropdownMenuItem>
                    {onCloseOthers && <DropdownMenuItem disabled={tabs.length < 2} onSelect={() => onCloseOthers(tab.id)}>Close others</DropdownMenuItem>}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="mr-1.5 size-6 opacity-50 group-hover:opacity-100 group-focus-within:opacity-100"
                    onClick={() => onClose(tab.id)}
                    aria-label={`Close ${tab.title}`}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Close tab</TooltipContent>
              </Tooltip>
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
