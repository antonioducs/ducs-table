import type { ReactNode } from "react";
import { Bookmark, Copy, Database, DatabaseZap, FileCode2, MoreHorizontal, Play, RefreshCw, Table2, Trash2 } from "lucide-react";
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
  onSelectSavedQuery: (query: SavedQuery) => void;
  onDeleteSavedQuery: (query: SavedQuery) => void;
  onRemoveSource: (source: SourceInfo) => void;
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

interface SidebarSectionProps {
  title: string;
  icon: ReactNode;
  empty: string;
  children: ReactNode;
}

function SidebarSection({ title, icon, empty, children }: SidebarSectionProps) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section className="border-b border-border py-2" aria-label={title}>
      <h2 className="flex h-7 items-center gap-1.5 px-3 text-[9px] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
        {icon}{title}
      </h2>
      {hasChildren ? children : <p className="px-3 py-2 text-[10px] leading-4 text-muted-foreground/70">{empty}</p>}
    </section>
  );
}

interface SourceRowProps {
  source: SourceInfo;
  active: boolean;
  onSelectSource: SidebarProps["onSelectSource"];
  onInsertTable: SidebarProps["onInsertTable"];
  onCopyTable?: SidebarProps["onCopyTable"];
  onRemoveSource: SidebarProps["onRemoveSource"];
  onRefreshSnapshot?: SidebarProps["onRefreshSnapshot"];
}

function SourceRow({ source, active, onSelectSource, onInsertTable, onCopyTable, onRemoveSource, onRefreshSnapshot }: SourceRowProps) {
  const status = statusDetails[source.status];
  return (
    <div className={cn("group mx-1 flex min-w-0 items-center rounded-md border border-transparent", active ? "border-primary/20 bg-primary/10" : "hover:bg-accent")}>
      <button
        type="button"
        onClick={() => onSelectSource(source.id)}
        className="min-w-0 flex-1 px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-current={active ? "page" : undefined}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Table2 className={cn("size-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-[11px] text-foreground" title={source.displayName}>{source.displayName}</span>
          {source.snapshot && <Badge variant="muted" className="h-4 shrink-0 px-1.5 text-[8px] uppercase leading-none" title={`${source.snapshot.catalog}.${source.snapshot.schema}.${source.snapshot.relation} · refreshed ${new Date(source.snapshot.refreshedAt).toLocaleString()}`}>Snapshot</Badge>}
          <Badge variant={status.variant} className="h-4 shrink-0 px-1.5 text-[8px] uppercase leading-none">{status.label}</Badge>
        </span>
        <code className="mt-0.5 block truncate pl-5 text-[9px] text-muted-foreground" title={source.tableName}>{source.tableName}</code>
      </button>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100"
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
              <Button variant="ghost" size="icon-sm" className="mr-1 size-6 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100" aria-label={`Actions for ${source.displayName}`}>
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
  );
}

export function Sidebar(props: SidebarProps) {
  const tables = props.sources.filter((source) => !source.isEphemeral);
  const results = props.sources.filter((source) => source.isEphemeral);
  const rowCallbacks = {
    onSelectSource: props.onSelectSource,
    onInsertTable: props.onInsertTable,
    onCopyTable: props.onCopyTable,
    onRemoveSource: props.onRemoveSource,
    onRefreshSnapshot: props.onRefreshSnapshot,
  };

  return (
    <aside className="ducs-glass-panel flex h-full min-h-0 flex-col border-r border-border bg-card" aria-label="Data sources and saved SQL">
      <div className="flex h-9 shrink-0 items-center border-b border-border px-3">
        <span className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground" title={props.projectName}>{props.projectName ?? "Workspace"}</span>
        <Badge variant="muted" className="ml-auto">{tables.length} tables</Badge>
      </div>
      <TooltipProvider delayDuration={400}>
        <ScrollArea className="min-h-0 flex-1">
          <SidebarSection title="Tables" icon={<Database className="size-3" aria-hidden="true" />} empty={`Open a data file in ${props.projectName ?? "this project"} to begin`}>
            {tables.map((source) => <SourceRow key={source.id} source={source} active={source.id === props.activeSourceId} {...rowCallbacks} />)}
          </SidebarSection>
          <SidebarSection title="Connections" icon={<DatabaseZap className="size-3" aria-hidden="true" />} empty={`Attach a database to ${props.projectName ?? "this project"}`}>
            {props.connectionTree ? <ConnectionTree {...props.connectionTree} /> : null}
          </SidebarSection>
          <SidebarSection title="Results" icon={<Table2 className="size-3" aria-hidden="true" />} empty="Run SQL to create a result">
            {results.map((source) => <SourceRow key={source.id} source={source} active={source.id === props.activeSourceId} {...rowCallbacks} />)}
          </SidebarSection>
          <SidebarSection title="Saved SQL" icon={<FileCode2 className="size-3" aria-hidden="true" />} empty="Saved queries appear here">
            {props.savedQueries.map((query) => (
              <div key={query.id} className="group mx-1 flex min-w-0 items-center rounded-md hover:bg-accent">
                <button
                  type="button"
                  onClick={() => props.onSelectSavedQuery(query)}
                  className="flex h-8 min-w-0 flex-1 items-center gap-1.5 px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <Bookmark className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate text-[11px] text-foreground">{query.name}</span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" className="mr-1 size-6 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100" aria-label={`Actions for saved query ${query.name}`}>
                      <MoreHorizontal aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="right">
                    <DropdownMenuItem onSelect={() => props.onSelectSavedQuery(query)}><FileCode2 aria-hidden="true" /> Open in SQL editor</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => props.onDeleteSavedQuery(query)}><Trash2 aria-hidden="true" /> Delete saved query</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          </SidebarSection>
        </ScrollArea>
      </TooltipProvider>
    </aside>
  );
}
