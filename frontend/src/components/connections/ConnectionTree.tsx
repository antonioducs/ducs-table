import { useState } from "react";
import { ChevronRight, CircleOff, Copy, Database, DatabaseZap, Edit3, MoreHorizontal, Plug, PlugZap, RefreshCw, Save, Table2, Trash2 } from "lucide-react";
import type { ConnectionInfo, ExternalRelationInfo } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type ConnectionTreeProps = {
  connections: readonly ConnectionInfo[];
  schemasByConnection: Record<string, string[]>;
  relationsBySchema: Record<string, ExternalRelationInfo[]>;
  loading: ReadonlySet<string>;
  errors: Record<string, string>;
  activeRelationId?: string;
  onExpandConnection: (connection: ConnectionInfo) => void;
  onExpandSchema: (connection: ConnectionInfo, schema: string) => void;
  onOpenRelation: (relation: ExternalRelationInfo) => void;
  onInsertRelation: (relation: ExternalRelationInfo) => void;
  onCopyRelation: (relation: ExternalRelationInfo) => void;
  onSnapshotRelation: (relation: ExternalRelationInfo) => void;
  onConnect: (connection: ConnectionInfo) => void;
  onDisconnect: (connection: ConnectionInfo) => void;
  onEdit: (connection: ConnectionInfo) => void;
  onRefresh: (connection: ConnectionInfo) => void;
  onDelete: (connection: ConnectionInfo) => void;
};

export function ConnectionTree(props: ConnectionTreeProps) {
  const [expandedConnections, setExpandedConnections] = useState<Set<string>>(new Set());
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());

  const toggleConnection = (connection: ConnectionInfo) => {
    const next = new Set(expandedConnections);
    if (next.has(connection.id)) next.delete(connection.id); else { next.add(connection.id); props.onExpandConnection(connection); }
    setExpandedConnections(next);
  };
  const toggleSchema = (connection: ConnectionInfo, schema: string) => {
    const key = `${connection.id}:${schema}`; const next = new Set(expandedSchemas);
    if (next.has(key)) next.delete(key); else { next.add(key); props.onExpandSchema(connection, schema); }
    setExpandedSchemas(next);
  };

  if (!props.connections.length) return <p className="px-3 py-2 text-[10px] leading-4 text-muted-foreground/70">Connect PostgreSQL or MongoDB to browse live data</p>;
  return <div className="pb-1">{props.connections.map((connection) => {
    const expanded = expandedConnections.has(connection.id);
    const schemas = props.schemasByConnection[connection.id];
    const loading = props.loading.has(connection.id);
    return <div key={connection.id}>
      <div className="group mx-1 flex items-center rounded-md hover:bg-accent">
        <Button variant="ghost" size="icon-sm" className="size-6" aria-label={`${expanded ? "Collapse" : "Expand"} ${connection.name}`} onClick={() => toggleConnection(connection)}>
          <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />
        </Button>
        <button type="button" onClick={() => toggleConnection(connection)} className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left">
          <DatabaseZap className={cn("size-3.5 shrink-0", connection.status === "connected" ? "text-primary" : "text-muted-foreground")} />
          <span className="min-w-0 flex-1 truncate text-[11px]">{connection.name}</span>
          {connection.kind === "mongo" && <Badge variant="warning" className="h-4 px-1 text-[8px]">Experimental</Badge>}
          <Badge variant={connection.status === "connected" ? "default" : connection.status === "error" ? "destructive" : connection.status === "connecting" ? "warning" : "muted"} className="h-4 px-1 text-[8px]">{connection.status}</Badge>
        </button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" className="mr-1 size-6 opacity-60 group-hover:opacity-100" aria-label={`Actions for ${connection.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="start" side="right">
          {connection.status === "connected" ? <DropdownMenuItem onSelect={() => props.onDisconnect(connection)}><PlugZap /> Disconnect</DropdownMenuItem> : <DropdownMenuItem onSelect={() => props.onConnect(connection)}><Plug /> Connect</DropdownMenuItem>}
          <DropdownMenuItem onSelect={() => props.onEdit(connection)}><Edit3 /> Edit</DropdownMenuItem>
          <DropdownMenuItem disabled={connection.status !== "connected"} onSelect={() => props.onRefresh(connection)}><RefreshCw /> Refresh catalog</DropdownMenuItem>
          <DropdownMenuSeparator /><DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => props.onDelete(connection)}><Trash2 /> Delete connection</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      </div>
      {expanded && <div className="ml-4 border-l border-border pl-1">
        {loading && <p className="px-2 py-1.5 text-[9px] text-muted-foreground">Loading catalog…</p>}
        {props.errors[connection.id] && <p className="px-2 py-1.5 text-[9px] text-destructive">{props.errors[connection.id]}</p>}
        {!loading && connection.status !== "connected" && <button className="flex items-center gap-1 px-2 py-1.5 text-[9px] text-primary" onClick={() => props.onConnect(connection)}><Plug className="size-3" /> Connect to browse</button>}
        {!loading && connection.status === "connected" && schemas?.length === 0 && <p className="px-2 py-1.5 text-[9px] text-muted-foreground">No schemas found</p>}
        {schemas?.map((schema) => {
          const key = `${connection.id}:${schema}`; const schemaExpanded = expandedSchemas.has(key); const relations = props.relationsBySchema[key];
          return <div key={schema}>
            <button type="button" onClick={() => toggleSchema(connection, schema)} className="flex h-7 w-full items-center gap-1 px-1.5 text-left text-[10px] hover:text-primary">
              <ChevronRight className={cn("size-3 transition-transform", schemaExpanded && "rotate-90")} /><Database className="size-3 text-muted-foreground" /><span className="truncate">{schema}</span>
            </button>
            {schemaExpanded && <div className="ml-4 border-l border-border/70 pl-1">
              {props.loading.has(key) && <p className="px-2 py-1 text-[9px] text-muted-foreground">Loading relations…</p>}
              {props.errors[key] && <p className="px-2 py-1 text-[9px] text-destructive">{props.errors[key]}</p>}
              {!props.loading.has(key) && relations?.length === 0 && <p className="px-2 py-1 text-[9px] text-muted-foreground">No relations</p>}
              {relations?.map((relation) => <RelationRow key={relation.id} relation={relation} active={props.activeRelationId === relation.id} {...props} />)}
            </div>}
          </div>;
        })}
      </div>}
    </div>;
  })}</div>;
}

function RelationRow({ relation, active, onOpenRelation, onInsertRelation, onCopyRelation, onSnapshotRelation }: Pick<ConnectionTreeProps, "onOpenRelation" | "onInsertRelation" | "onCopyRelation" | "onSnapshotRelation"> & { relation: ExternalRelationInfo; active: boolean }) {
  return <div className={cn("group flex items-center rounded-md", active ? "bg-primary/10 text-primary" : "hover:bg-accent")}>
    <button type="button" onClick={() => onOpenRelation(relation)} className="flex h-7 min-w-0 flex-1 items-center gap-1.5 px-2 text-left"><Table2 className="size-3" /><span className="truncate text-[10px]">{relation.name}</span></button>
    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" className="mr-1 size-5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" aria-label={`Actions for ${relation.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="start" side="right">
      <DropdownMenuItem onSelect={() => onOpenRelation(relation)}><Table2 /> Open live</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onInsertRelation(relation)}><CircleOff /> Insert qualified name in SQL</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onCopyRelation(relation)}><Copy /> Copy qualified name</DropdownMenuItem>
      <DropdownMenuSeparator /><DropdownMenuItem onSelect={() => onSnapshotRelation(relation)}><Save /> Snapshot locally</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>
  </div>;
}
