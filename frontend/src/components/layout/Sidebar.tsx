import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Bookmark, Copy, Database, DatabaseZap, FileCode2, MoreHorizontal, Play, RefreshCw, Search, Table2, Trash2, X } from "lucide-react";
import type { SavedQuery, SourceInfo, SourceStatus } from "@/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ConnectionTree, type ConnectionTreeProps } from "@/components/connections/ConnectionTree";

export interface SidebarProps {
  projectName?: string;
  sources: readonly SourceInfo[];
  savedQueries: readonly SavedQuery[];
  activeSourceId?: string;
  onSelectSource: (id: string) => void;
  onInsertTable: (source: SourceInfo) => void;
  onCopyTable?: (source: SourceInfo) => void;
  onRenameSource?: (source: SourceInfo, displayName: string) => Promise<void>;
  onSelectSavedQuery: (query: SavedQuery) => void;
  onRenameSavedQuery?: (query: SavedQuery, name: string) => Promise<void>;
  onDeleteSavedQuery: (query: SavedQuery) => void;
  onRemoveSource: (source: SourceInfo) => void;
  onQuickRemoveSource?: (source: SourceInfo) => Promise<void>;
  onRefreshSnapshot?: (source: SourceInfo) => void;
  connectionTree?: ConnectionTreeProps;
}

const statusDetails: Record<SourceStatus, { label: string; variant: "default" | "muted" | "warning" | "destructive" }> = {
  preview: { label: "Preview", variant: "muted" },
  preparing: { label: "Preparing", variant: "warning" },
  ready: { label: "Ready", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "muted" },
};

function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}

interface SidebarSectionProps {
  title: string;
  icon: ReactNode;
  empty: string;
  contentClassName?: string;
  children: ReactNode;
}

function SidebarSection({ title, icon, empty, contentClassName, children }: SidebarSectionProps) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  const count = Array.isArray(children) ? children.length : undefined;
  return (
    <section className="min-w-0 border-b border-border/70 py-2" aria-label={title}>
      <h2 className="ducs-eyebrow sticky top-0 z-10 flex h-7 items-center gap-1.5 bg-gradient-to-b from-[rgb(11_16_14_/_92%)] to-[rgb(11_16_14_/_55%)] px-3 text-muted-foreground/85 backdrop-blur-sm">
        <span className="text-primary/70 [&_svg]:size-3">{icon}</span>
        {title}
        {count ? <span className="ducs-num ml-auto rounded-full bg-white/[0.05] px-1.5 py-px text-[9px] font-semibold tracking-normal text-muted-foreground/80">{count}</span> : null}
      </h2>
      {hasChildren
        ? <div className={cn("ducs-stagger min-w-0 pt-0.5", contentClassName)}>{children}</div>
        : <p className="mx-2 mt-1 rounded-md border border-dashed border-border/80 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground/70">{empty}</p>}
    </section>
  );
}

interface SourceRowProps {
  source: SourceInfo;
  active: boolean;
  onSelectSource: SidebarProps["onSelectSource"];
  onInsertTable: SidebarProps["onInsertTable"];
  onCopyTable?: SidebarProps["onCopyTable"];
  onRenameSource?: SidebarProps["onRenameSource"];
  onRemoveSource: SidebarProps["onRemoveSource"];
  onQuickRemoveSource?: SidebarProps["onQuickRemoveSource"];
  onRefreshSnapshot?: SidebarProps["onRefreshSnapshot"];
}

const swipeDeleteWidth = 88;
const swipeDeleteThreshold = 64;
const removeSlideDuration = 220;
const removeCollapseDuration = 180;

type RemovalPhase = "idle" | "sliding" | "collapsing";

function waitForMotion(duration: number): Promise<void> {
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
  return new Promise((resolve) => globalThis.setTimeout(resolve, duration));
}

function SourceRow({ source, active, onSelectSource, onInsertTable, onCopyTable, onRenameSource, onRemoveSource, onQuickRemoveSource, onRefreshSnapshot }: SourceRowProps) {
  const status = statusDetails[source.status];
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(source.displayName);
  const [renaming, setRenaming] = useState(false);
  const [invalidName, setInvalidName] = useState(false);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const [quickRemoving, setQuickRemoving] = useState(false);
  const [removalPhase, setRemovalPhase] = useState<RemovalPhase>("idle");
  const swipeRef = useRef<{ pointerId: number; startX: number; startY: number; offset: number; active: boolean } | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const canRename = Boolean(onRenameSource && source.status === "ready");
  const canQuickRemove = Boolean(onQuickRemoveSource && source.status === "ready" && !editing);
  const swipeActionVisible = swipeOffset > 0 || removalPhase !== "idle";

  useEffect(() => {
    if (!editing) setDraftName(source.displayName);
  }, [editing, source.displayName]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const beginRename = () => {
    if (!canRename) return;
    setDraftName(source.displayName);
    setInvalidName(false);
    setEditing(true);
  };

  const cancelRename = () => {
    setDraftName(source.displayName);
    setInvalidName(false);
    setEditing(false);
  };

  const commitRename = async () => {
    const displayName = draftName.trim();
    if (!displayName) {
      setInvalidName(true);
      inputRef.current?.focus();
      return;
    }
    if (!onRenameSource || displayName === source.displayName) {
      setEditing(false);
      return;
    }
    setRenaming(true);
    setInvalidName(false);
    try {
      await onRenameSource(source, displayName);
      setEditing(false);
    } catch {
      requestAnimationFrame(() => inputRef.current?.select());
    } finally {
      setRenaming(false);
    }
  };

  const quickRemove = async () => {
    if (!onQuickRemoveSource || quickRemoving) return;
    setQuickRemoving(true);
    setSwiping(false);
    setRemovalPhase("sliding");
    await waitForMotion(removeSlideDuration);
    setRemovalPhase("collapsing");
    await waitForMotion(removeCollapseDuration);
    try {
      await onQuickRemoveSource(source);
    } catch {
      setSwipeOffset(0);
      setRemovalPhase("idle");
      setQuickRemoving(false);
    }
  };

  const resetSwipe = () => {
    swipeRef.current = undefined;
    setSwiping(false);
    setSwipeOffset(0);
  };

  const onSwipeStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!canQuickRemove || event.button !== 0) return;
    swipeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, offset: 0, active: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onSwipeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = swipeRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const horizontal = gesture.startX - event.clientX;
    const vertical = Math.abs(gesture.startY - event.clientY);
    if (!gesture.active) {
      if (Math.abs(horizontal) < 6) return;
      if (vertical > Math.abs(horizontal)) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        swipeRef.current = undefined;
        return;
      }
      gesture.active = true;
      setSwiping(true);
    }
    event.preventDefault();
    suppressClickRef.current = true;
    gesture.offset = Math.max(0, Math.min(swipeDeleteWidth, horizontal));
    setSwipeOffset(gesture.offset);
  };

  const onSwipeEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = swipeRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    swipeRef.current = undefined;
    setSwiping(false);
    if (!gesture.active) return;
    suppressClickRef.current = true;
    if (gesture.offset >= swipeDeleteThreshold) void quickRemove();
    else setSwipeOffset(0);
  };

  return (
    <div
      className={cn(
        "grid min-w-0 grid-rows-[1fr] overflow-hidden transition-[grid-template-rows,margin] duration-[180ms] ease-out motion-reduce:transition-none",
        removalPhase === "collapsing" ? "my-0 grid-rows-[0fr]" : "my-0.5",
      )}
      data-removal-phase={removalPhase}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="relative isolate mx-1 min-w-0 overflow-hidden rounded-md" data-swipe-offset={swipeOffset}>
          <div
            className={cn(
              "absolute inset-y-0 right-0 z-0 flex w-[88px] items-stretch justify-end bg-destructive/15 transition-opacity duration-100 motion-reduce:transition-none",
              swipeActionVisible ? "opacity-100" : "pointer-events-none opacity-0",
            )}
            data-swipe-action-visible={swipeActionVisible}
          >
            <button
              type="button"
              tabIndex={swipeOffset > 0 ? 0 : -1}
              aria-label={`Quick delete ${source.displayName}`}
              className={cn("flex w-[88px] items-center justify-center bg-destructive text-white transition-opacity motion-reduce:transition-none", quickRemoving && "opacity-70")}
              disabled={quickRemoving}
              onClick={() => void quickRemove()}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </button>
          </div>
          <div
            className={cn(
              "group relative z-10 flex w-full min-w-0 items-center overflow-hidden rounded-lg border border-transparent bg-[rgb(10_15_13)] will-change-transform",
              !swiping && "transition-[transform,opacity,background-color,border-color,box-shadow] duration-[220ms] ease-soft motion-reduce:transition-none",
              quickRemoving && "pointer-events-none",
              active
                ? "border-primary/25 bg-gradient-to-r from-primary/[0.16] to-primary/[0.04] shadow-[inset_0_1px_0_rgba(215,255,235,.06),0_6px_18px_-12px_rgba(52,224,127,.8)]"
                : "hover:border-border hover:bg-accent/80",
            )}
            style={{
              opacity: removalPhase === "idle" ? 1 : 0,
              transform: removalPhase === "idle" ? `translateX(-${swipeOffset}px)` : "translateX(-100%)",
            }}
          >
            {active && (
              <span
                aria-hidden="true"
                className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-gradient-to-b from-brand-200 to-primary shadow-[0_0_10px_rgba(52,224,127,.8)]"
              />
            )}
            {editing ? (
              <div className="min-w-0 flex-1 overflow-hidden px-2 py-1.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Table2 className={cn("size-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
                  <Input
                    ref={inputRef}
                    value={draftName}
                    maxLength={200}
                    disabled={renaming}
                    aria-label={`Rename ${source.displayName}`}
                    aria-invalid={invalidName}
                    className={cn("h-5 min-w-0 flex-1 px-1.5 text-[11px]", invalidName && "border-destructive")}
                    onChange={(event) => { setDraftName(event.target.value); setInvalidName(false); }}
                    onBlur={() => { if (!renaming) cancelRename(); }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") { event.preventDefault(); void commitRename(); }
                      if (event.key === "Escape") { event.preventDefault(); cancelRename(); }
                    }}
                  />
                  <Badge variant={status.variant} className="h-4 shrink-0 px-1.5 text-[8px] uppercase leading-none">{renaming ? "Saving" : status.label}</Badge>
                </span>
                <code className="mt-0.5 block truncate pl-5 text-[9.5px] text-muted-foreground/75 transition-colors group-hover:text-muted-foreground" title={source.tableName}>{source.tableName}</code>
              </div>
            ) : (
              <button
                type="button"
                onClick={(event) => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }
                  onSelectSource(source.id);
                }}
                onDoubleClick={beginRename}
                onPointerDown={onSwipeStart}
                onPointerMove={onSwipeMove}
                onPointerUp={onSwipeEnd}
                onPointerCancel={resetSwipe}
                className={cn("min-w-0 flex-1 touch-pan-y overflow-hidden px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", canQuickRemove && "cursor-grab active:cursor-grabbing")}
                aria-current={active ? "page" : undefined}
                title={[
                  canRename ? "Double-click to rename" : "",
                  canQuickRemove ? "Drag left to delete without confirmation" : "",
                ].filter(Boolean).join(" · ") || undefined}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <Table2
                    className={cn(
                      "size-3.5 shrink-0 transition-[color,transform] duration-200 ease-soft group-hover:scale-110",
                      active ? "text-primary" : "text-muted-foreground group-hover:text-brand-300",
                    )}
                    aria-hidden="true"
                  />
                  <span className={cn("min-w-0 flex-1 truncate text-[11.5px] transition-colors", active ? "font-medium text-foreground" : "text-foreground/90")} title={source.displayName}>{source.displayName}</span>
                  {source.snapshot && <Badge variant="muted" className="h-4 shrink-0 px-1.5 text-[8px] uppercase leading-none" title={`${source.snapshot.catalog}.${source.snapshot.schema}.${source.snapshot.relation} · refreshed ${new Date(source.snapshot.refreshedAt).toLocaleString()}`}>Snapshot</Badge>}
                  <Badge variant={status.variant} className="h-4 shrink-0 px-1.5 text-[8px] uppercase leading-none">{status.label}</Badge>
                </span>
                <code className="mt-0.5 block truncate pl-5 text-[9.5px] text-muted-foreground/75 transition-colors group-hover:text-muted-foreground" title={source.tableName}>{source.tableName}</code>
              </button>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-6 rounded-md opacity-0 transition-opacity duration-150 hover:bg-accent group-hover:opacity-80 group-focus-within:opacity-100"
                  aria-label={`Copy table name ${source.tableName}`}
                  onClick={() => onCopyTable?.(source)}
                  disabled={!onCopyTable}
                ><Copy aria-hidden="true" /></Button>
              </TooltipTrigger>
              <TooltipContent>Copy SQL table name</TooltipContent>
            </Tooltip>

            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" className="mr-1 size-6 rounded-md opacity-0 transition-opacity duration-150 hover:bg-accent group-hover:opacity-80 group-focus-within:opacity-100" aria-label={`Actions for ${source.displayName}`}>
                      <MoreHorizontal aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>Source actions</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="start" side="right">
                <DropdownMenuItem onSelect={() => onInsertTable(source)}><Play aria-hidden="true" /> Insert in SQL</DropdownMenuItem>
                <DropdownMenuItem disabled={!onCopyTable} onSelect={() => onCopyTable?.(source)}><Copy aria-hidden="true" /> Copy table name</DropdownMenuItem>
                {!source.isEphemeral && (
                  <>
                    {source.snapshot && <DropdownMenuItem disabled={!source.snapshot.connectionId} onSelect={() => onRefreshSnapshot?.(source)}><RefreshCw aria-hidden="true" /> Refresh snapshot</DropdownMenuItem>}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onRemoveSource(source)}><Trash2 aria-hidden="true" /> Remove table</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SavedQueryRowProps {
  query: SavedQuery;
  onSelect: SidebarProps["onSelectSavedQuery"];
  onRename?: SidebarProps["onRenameSavedQuery"];
  onDelete: SidebarProps["onDeleteSavedQuery"];
}

function SavedQueryRow({ query, onSelect, onRename, onDelete }: SavedQueryRowProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(query.name);
  const [renaming, setRenaming] = useState(false);
  const [invalidName, setInvalidName] = useState(false);

  useEffect(() => {
    if (!editing) setDraftName(query.name);
  }, [editing, query.name]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const cancelRename = () => {
    setDraftName(query.name);
    setInvalidName(false);
    setEditing(false);
  };

  const commitRename = async () => {
    const name = draftName.trim();
    if (!name) {
      setInvalidName(true);
      inputRef.current?.focus();
      return;
    }
    if (!onRename || name === query.name) {
      setEditing(false);
      return;
    }
    setRenaming(true);
    setInvalidName(false);
    try {
      await onRename(query, name);
      setEditing(false);
    } catch {
      requestAnimationFrame(() => inputRef.current?.select());
    } finally {
      setRenaming(false);
    }
  };

  return (
    <div className="group mx-1 my-0.5 flex min-w-0 items-center rounded-lg border border-transparent transition-[background-color,border-color] duration-200 ease-soft hover:border-border hover:bg-accent/80">
      {editing ? (
        <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 px-2">
          <Bookmark className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={inputRef}
            value={draftName}
            maxLength={200}
            disabled={renaming}
            aria-label={`Rename saved query ${query.name}`}
            aria-invalid={invalidName}
            className={cn("h-6 min-w-0 flex-1 px-1.5 text-[11px]", invalidName && "border-destructive")}
            onChange={(event) => { setDraftName(event.target.value); setInvalidName(false); }}
            onBlur={() => { if (!renaming) cancelRename(); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void commitRename(); }
              if (event.key === "Escape") { event.preventDefault(); cancelRename(); }
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onSelect(query)}
          onDoubleClick={() => {
            if (!onRename) return;
            setDraftName(query.name);
            setInvalidName(false);
            setEditing(true);
          }}
          className="flex h-8 min-w-0 flex-1 items-center gap-1.5 px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          title={onRename ? "Double-click to rename" : undefined}
        >
          <Bookmark className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate text-[11px] text-foreground">{query.name}</span>
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="mr-1 size-6 rounded-md opacity-0 transition-opacity duration-150 hover:bg-accent group-hover:opacity-80 group-focus-within:opacity-100" aria-label={`Actions for saved query ${query.name}`}>
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          <DropdownMenuItem onSelect={() => onSelect(query)}><FileCode2 aria-hidden="true" /> Open in SQL editor</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onDelete(query)}><Trash2 aria-hidden="true" /> Delete saved query</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  const [filter, setFilter] = useState("");
  const tables = props.sources.filter((source) => !source.isEphemeral);
  const normalizedFilter = normalizeSearchText(filter.trim());
  const sourceMatchesFilter = (source: SourceInfo) => !normalizedFilter || [source.displayName, source.tableName, source.sourcePath ?? ""]
    .some((value) => normalizeSearchText(value).includes(normalizedFilter));
  const filteredTables = tables.filter(sourceMatchesFilter);
  const rowCallbacks = {
    onSelectSource: props.onSelectSource,
    onInsertTable: props.onInsertTable,
    onCopyTable: props.onCopyTable,
    onRenameSource: props.onRenameSource,
    onRemoveSource: props.onRemoveSource,
    onQuickRemoveSource: props.onQuickRemoveSource,
    onRefreshSnapshot: props.onRefreshSnapshot,
  };

  return (
    <aside className="ducs-glass-panel flex h-full min-h-0 flex-col border-r border-border bg-card" aria-label="Data sources and saved SQL">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="ducs-live-dot shrink-0" aria-hidden="true" />
        <span className="ducs-display min-w-0 flex-1 truncate text-[12.5px] text-foreground" title={props.projectName}>{props.projectName ?? "Workspace"}</span>
        <Badge variant="muted" className="ducs-num shrink-0">{tables.length} tables</Badge>
      </div>
      <div className="shrink-0 border-b border-border p-2">
        <div className="group relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70 transition-colors duration-150 group-focus-within:text-primary" aria-hidden="true" />
          <Input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search files"
            aria-label="Search files"
            className="h-7.5 pl-8 pr-7 text-[11px]"
          />
          {filter && (
            <Button variant="ghost" size="icon-sm" className="absolute right-1 top-1/2 size-5 -translate-y-1/2" onClick={() => setFilter("")} aria-label="Clear file search">
              <X aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
      <TooltipProvider delayDuration={400}>
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <div className="w-full min-w-0 overflow-x-hidden">
            <SidebarSection
              title="Tables"
              icon={<Database className="size-3" aria-hidden="true" />}
              empty={normalizedFilter ? "No tables match your search" : `Open a data file in ${props.projectName ?? "this project"} to begin`}
              contentClassName="max-h-[45vh] overflow-x-hidden overflow-y-auto pb-1"
            >
              {filteredTables.map((source) => <SourceRow key={source.id} source={source} active={source.id === props.activeSourceId} {...rowCallbacks} />)}
            </SidebarSection>
            <SidebarSection title="Connections" icon={<DatabaseZap className="size-3" aria-hidden="true" />} empty={`Attach a database to ${props.projectName ?? "this project"}`}>
              {props.connectionTree ? <ConnectionTree {...props.connectionTree} /> : null}
            </SidebarSection>
            <SidebarSection title="Saved SQL" icon={<FileCode2 className="size-3" aria-hidden="true" />} empty="Saved queries appear here">
              {props.savedQueries.map((query) => (
                <SavedQueryRow key={query.id} query={query} onSelect={props.onSelectSavedQuery} onRename={props.onRenameSavedQuery} onDelete={props.onDeleteSavedQuery} />
              ))}
            </SidebarSection>
          </div>
        </ScrollArea>
      </TooltipProvider>
    </aside>
  );
}
