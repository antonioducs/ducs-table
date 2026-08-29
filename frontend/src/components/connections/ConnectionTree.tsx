import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, CircleOff, Copy, Database, DatabaseZap, Edit3, Eye, EyeOff, MoreHorizontal, Plug, PlugZap, RefreshCw, Save, Search, Table2, Unplug, X } from "lucide-react";
import type { ConnectionInfo, ExternalRelationInfo } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type ConnectionTreeProps = {
  projectName?: string;
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
  onRemove: (connection: ConnectionInfo) => void;
};

export function ConnectionTree(props: ConnectionTreeProps) {
  const { connections, onExpandConnection, onExpandSchema, relationsBySchema, schemasByConnection } = props;
  const [expandedConnections, setExpandedConnections] = useState<Set<string>>(new Set());
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [hiddenSchemas, setHiddenSchemas] = useState<Set<string>>(new Set());
  const [tableFilter, setTableFilter] = useState("");
  const requestedConnections = useRef<Set<string>>(new Set());
  const requestedSchemas = useRef<Set<string>>(new Set());
  const normalizedFilter = tableFilter.trim().toLocaleLowerCase();

  useEffect(() => {
    if (!normalizedFilter) {
      requestedConnections.current.clear();
      requestedSchemas.current.clear();
      return;
    }
    for (const connection of connections) {
      const schemas = schemasByConnection[connection.id];
      if (!schemas) {
        if (!requestedConnections.current.has(connection.id)) {
          requestedConnections.current.add(connection.id);
          onExpandConnection(connection);
        }
        continue;
      }
      for (const schema of schemas) {
        const key = `${connection.id}:${schema}`;
        if (relationsBySchema[key] || requestedSchemas.current.has(key)) continue;
        requestedSchemas.current.add(key);
        onExpandSchema(connection, schema);
      }
    }
  }, [connections, normalizedFilter, onExpandConnection, onExpandSchema, relationsBySchema, schemasByConnection]);

  const hiddenSchemaItems = useMemo(() => [...hiddenSchemas].flatMap((key) => {
    const separator = key.indexOf(":");
    const connectionId = key.slice(0, separator);
    const schema = key.slice(separator + 1);
    const connection = connections.find((item) => item.id === connectionId);
    return connection ? [{ key, label: `${connection.name}.${schema}` }] : [];
  }), [connections, hiddenSchemas]);

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
  const hideSchema = (connection: ConnectionInfo, schema: string) => {
    const key = `${connection.id}:${schema}`;
    setHiddenSchemas((current) => new Set(current).add(key));
    setExpandedSchemas((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  };
  const showSchema = (key: string) => setHiddenSchemas((current) => {
    const next = new Set(current);
    next.delete(key);
    return next;
  });

  if (!props.connections.length) return <p className="px-3 py-2 text-[10px] leading-4 text-muted-foreground/70">Attach PostgreSQL or MongoDB to {props.projectName ?? "this project"} to browse live data</p>;
  return <div className="pb-1">
    <div className="flex items-center gap-1.5 px-2 pb-2">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70 transition-colors duration-150 peer-focus:text-primary" aria-hidden="true" />
        <Input
          type="search"
          value={tableFilter}
          onChange={(event) => setTableFilter(event.target.value)}
          placeholder="Search tables"
          aria-label="Search connection tables"
          className="peer h-7 pl-8 pr-7 text-[11px]"
        />
        {tableFilter && <Button variant="ghost" size="icon-sm" className="absolute right-1 top-1/2 size-5 -translate-y-1/2" onClick={() => setTableFilter("")} aria-label="Clear table search"><X aria-hidden="true" /></Button>}
      </div>
      {hiddenSchemaItems.length > 0 && <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="size-7 shrink-0" aria-label={`${hiddenSchemaItems.length} hidden schema${hiddenSchemaItems.length === 1 ? "" : "s"}`}>
            <Eye className="size-3.5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="right">
          {hiddenSchemaItems.map((item) => <DropdownMenuItem key={item.key} onSelect={() => showSchema(item.key)}><Eye aria-hidden="true" /> Show {item.label}</DropdownMenuItem>)}
          {hiddenSchemaItems.length > 1 && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => setHiddenSchemas(new Set())}><Eye aria-hidden="true" /> Show all schemas</DropdownMenuItem></>}
        </DropdownMenuContent>
      </DropdownMenu>}
    </div>
    {props.connections.map((connection) => {
    const expanded = expandedConnections.has(connection.id) || Boolean(normalizedFilter);
    const schemas = props.schemasByConnection[connection.id];
    const loading = props.loading.has(connection.id);
    const visibleSchemas = schemas?.filter((schema) => {
      const key = `${connection.id}:${schema}`;
      if (!normalizedFilter) return !hiddenSchemas.has(key);
      const relations = props.relationsBySchema[key];
      return !relations || relations.some((relation) => relation.name.toLocaleLowerCase().includes(normalizedFilter));
    });
    return <div key={connection.id}>
      <div className="group mx-1 my-0.5 flex items-center rounded-lg border border-transparent transition-[background-color,border-color] duration-200 ease-soft hover:border-border hover:bg-accent/80">
        <Button variant="ghost" size="icon-sm" className="mr-1 size-6" aria-label={`${expanded ? "Collapse" : "Expand"} ${connection.name}`} onClick={() => toggleConnection(connection)}>
          <ChevronRight className={cn("size-3 transition-transform duration-200 ease-soft", expanded && "rotate-90")} />
        </Button>
        <button type="button" onClick={() => toggleConnection(connection)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left">
          <span className="relative grid size-3.5 shrink-0 place-items-center">
            <DatabaseZap className={cn("size-3.5 transition-colors duration-200", connection.status === "connected" ? "text-primary" : "text-muted-foreground")} />
            {connection.status === "connected" && <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary shadow-[0_0_6px_rgba(52,224,127,.9)]" />}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11.5px]">{connection.name}</span>
          {connection.kind === "mongo" && <Badge variant="warning" className="h-4 shrink-0 px-1 text-[8px]">Experimental</Badge>}
          <Badge variant={connection.status === "connected" ? "default" : connection.status === "error" ? "destructive" : connection.status === "connecting" ? "warning" : "muted"} className="mr-1 h-4 shrink-0 px-1 text-[8px]">{connection.status}</Badge>
        </button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" className="mr-1 size-6 rounded-md opacity-0 transition-opacity duration-150 group-hover:opacity-80 group-focus-within:opacity-100" aria-label={`Actions for ${connection.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="start" side="right">
          {connection.status === "connected" ? <DropdownMenuItem onSelect={() => props.onDisconnect(connection)}><PlugZap /> Disconnect</DropdownMenuItem> : <DropdownMenuItem onSelect={() => props.onConnect(connection)}><Plug /> Connect</DropdownMenuItem>}
          <DropdownMenuItem onSelect={() => props.onEdit(connection)}><Edit3 /> Edit</DropdownMenuItem>
          <DropdownMenuItem disabled={connection.status !== "connected"} onSelect={() => props.onRefresh(connection)}><RefreshCw /> Refresh catalog</DropdownMenuItem>
          <DropdownMenuSeparator /><DropdownMenuItem onSelect={() => props.onRemove(connection)}><Unplug /> Remove from project</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      </div>
      {expanded && <div className="ml-4 border-l border-border pl-1">
        {loading && <p className="px-2 py-1.5 text-[9px] text-muted-foreground">Loading catalog…</p>}
        {props.errors[connection.id] && <p className="px-2 py-1.5 text-[9px] text-destructive">{props.errors[connection.id]}</p>}
        {!loading && connection.status !== "connected" && <button className="flex items-center gap-1 rounded px-2 py-1.5 text-[10px] text-primary transition-colors hover:text-brand-200" onClick={() => props.onConnect(connection)}><Plug className="size-3" /> Connect to browse</button>}
        {!loading && connection.status === "connected" && schemas?.length === 0 && <p className="px-2 py-1.5 text-[9px] text-muted-foreground">No schemas found</p>}
        {!loading && normalizedFilter && schemas && visibleSchemas?.length === 0 && <p className="px-2 py-1.5 text-[9px] text-muted-foreground">No tables match “{tableFilter.trim()}”</p>}
        {visibleSchemas?.map((schema) => {
          const key = `${connection.id}:${schema}`; const relations = props.relationsBySchema[key];
          const matchingRelations = normalizedFilter ? relations?.filter((relation) => relation.name.toLocaleLowerCase().includes(normalizedFilter)) : relations;
          const schemaExpanded = expandedSchemas.has(key) || Boolean(normalizedFilter);
          return <div key={schema}>
            <div className="group/schema flex items-center rounded-md transition-colors duration-150 hover:bg-accent/70">
              <button type="button" onClick={() => toggleSchema(connection, schema)} className="flex h-7 min-w-0 flex-1 items-center gap-1.5 px-1.5 text-left text-[10px] hover:text-primary">
                <ChevronRight className={cn("size-3 shrink-0 transition-transform duration-200 ease-soft", schemaExpanded && "rotate-90")} /><Database className="size-3 shrink-0 text-muted-foreground" /><span className="truncate">{schema}</span>
              </button>
              {!normalizedFilter && <Button variant="ghost" size="icon-sm" className="mr-1 size-5 shrink-0 opacity-0 group-hover/schema:opacity-100 group-focus-within/schema:opacity-100" onClick={() => hideSchema(connection, schema)} aria-label={`Hide schema ${schema}`}><EyeOff aria-hidden="true" /></Button>}
            </div>
            {schemaExpanded && <div className="ml-4 border-l border-border/70 pl-1">
              {props.loading.has(key) && <p className="px-2 py-1 text-[9px] text-muted-foreground">Loading relations…</p>}
              {props.errors[key] && <p className="px-2 py-1 text-[9px] text-destructive">{props.errors[key]}</p>}
              {!props.loading.has(key) && matchingRelations?.length === 0 && <p className="px-2 py-1 text-[9px] text-muted-foreground">{normalizedFilter ? "No matching tables" : "No relations"}</p>}
              {matchingRelations?.map((relation) => <RelationRow key={relation.id} relation={relation} active={props.activeRelationId === relation.id} {...props} />)}
            </div>}
          </div>;
        })}
      </div>}
    </div>;
  })}</div>;
}

function RelationRow({ relation, active, onOpenRelation, onInsertRelation, onCopyRelation, onSnapshotRelation }: Pick<ConnectionTreeProps, "onOpenRelation" | "onInsertRelation" | "onCopyRelation" | "onSnapshotRelation"> & { relation: ExternalRelationInfo; active: boolean }) {
  return <div className={cn("group relative flex items-center rounded-md transition-colors duration-150", active ? "bg-primary/12 text-brand-200" : "hover:bg-accent/70")}>
    {active && <span aria-hidden="true" className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary shadow-[0_0_8px_rgba(52,224,127,.8)]" />}
    <button type="button" onClick={() => onOpenRelation(relation)} className="flex h-7 min-w-0 flex-1 items-center gap-1.5 px-2 text-left"><Table2 className="size-3" /><span className="truncate text-[10px]">{relation.name}</span></button>
    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" className="mr-1 size-5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" aria-label={`Actions for ${relation.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="start" side="right">
      <DropdownMenuItem onSelect={() => onOpenRelation(relation)}><Table2 /> Open live</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onInsertRelation(relation)}><CircleOff /> Insert qualified name in SQL</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onCopyRelation(relation)}><Copy /> Copy qualified name</DropdownMenuItem>
      <DropdownMenuSeparator /><DropdownMenuItem onSelect={() => onSnapshotRelation(relation)}><Save /> Snapshot locally</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>
  </div>;
}
