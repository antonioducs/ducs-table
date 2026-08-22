import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Database, FlaskConical, KeyRound, Loader2, Network } from "lucide-react";
import { bridge, getErrorMessage } from "@/lib/bridge";
import type { ConnectionInfo, ConnectionInput, ConnectionKind, MongoConfig, PostgresConfig } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: string;
  connection?: ConnectionInfo;
  onSaved: (connection: ConnectionInfo) => void;
};

const postgresDefaults: PostgresConfig = { host: "localhost", port: 5432, database: "", username: "", sslMode: "prefer", connectTimeoutSeconds: 10, poolSize: 4 };
const mongoDefaults: MongoConfig = { mode: "mongodb", hosts: ["localhost:27017"], database: "", tls: false, readPreference: "secondaryPreferred", connectTimeoutSeconds: 10, experimentalConsent: false };

export function ConnectionDialog({ open, onOpenChange, projectId, connection, onSaved }: Props) {
  const [kind, setKind] = useState<ConnectionKind>(connection?.kind ?? "postgres");
  const [name, setName] = useState("");
  const [catalogName, setCatalogName] = useState("");
  const [password, setPassword] = useState("");
  const [autoConnect, setAutoConnect] = useState(false);
  const [postgres, setPostgres] = useState<PostgresConfig>(postgresDefaults);
  const [mongo, setMongo] = useState<MongoConfig>(mongoDefaults);
  const [busy, setBusy] = useState<"test" | "save">();
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string }>();

  useEffect(() => {
    if (!open) return;
    setKind(connection?.kind ?? "postgres");
    setName(connection?.name ?? "");
    setCatalogName(connection?.catalogName ?? "");
    setPassword("");
    setAutoConnect(connection?.autoConnect ?? false);
    setPostgres(connection?.config.postgres ? { ...connection.config.postgres } : postgresDefaults);
    setMongo(connection?.config.mongo ? { ...connection.config.mongo, hosts: [...connection.config.mongo.hosts] } : mongoDefaults);
    setBusy(undefined);
    setFeedback(undefined);
  }, [connection, open]);

  const config = useMemo(() => kind === "postgres" ? { postgres } : { mongo }, [kind, mongo, postgres]);
  const validation = !name.trim() ? "Enter a connection name."
    : !catalogName.trim() ? "Enter a SQL catalog alias."
      : kind === "postgres" && (!postgres.host.trim() || !postgres.database.trim() || !postgres.username.trim()) ? "Host, database, and username are required."
        : kind === "mongo" && (!mongo.hosts.length || !mongo.database.trim()) ? "Hosts and database are required."
          : kind === "mongo" && !mongo.experimentalConsent ? "Accept the experimental MongoDB notice to continue."
            : undefined;

  const input = (): ConnectionInput => ({ name: name.trim(), kind, catalogName: catalogName.trim(), config, autoConnect, password: password || undefined });
  const changeOpen = (next: boolean) => { if (!next) setPassword(""); onOpenChange(next); };

  const test = async () => {
    if (validation) { setFeedback({ ok: false, message: validation }); return; }
    setBusy("test"); setFeedback(undefined);
    try {
      await bridge.TestConnection({ id: connection?.id, kind, config, password: password || undefined });
      setFeedback({ ok: true, message: "Connection succeeded. The external catalog is readable." });
    } catch (error) { setFeedback({ ok: false, message: getErrorMessage(error) }); }
    finally { setBusy(undefined); }
  };

  const save = async () => {
    if (validation) { setFeedback({ ok: false, message: validation }); return; }
    setBusy("save"); setFeedback(undefined);
    try {
      if (!connection && !projectId) throw new Error("Choose a project before creating a connection.");
      const saved = connection
        ? await bridge.UpdateConnection({ ...input(), id: connection.id })
        : await bridge.CreateConnection({ ...input(), projectId: projectId! });
      onSaved(saved);
      if (!projectId) { changeOpen(false); return; }
      try {
        const connected = await bridge.ConnectConnection({ projectId, id: saved.id });
        onSaved(connected);
        changeOpen(false);
      } catch (error) {
        setFeedback({ ok: false, message: `Saved securely, but connection failed: ${getErrorMessage(error)}` });
      }
    } catch (error) { setFeedback({ ok: false, message: getErrorMessage(error) }); }
    finally { setBusy(undefined); }
  };

  return <Dialog open={open} onOpenChange={(next) => !busy && changeOpen(next)}>
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{connection ? "Edit connection" : "Add database connection"}</DialogTitle>
        <DialogDescription>Credentials are stored only in macOS Keychain. Remote databases are attached read-only.</DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-2 gap-2">
        <ProviderCard kind="postgres" selected={kind === "postgres"} disabled={Boolean(connection)} onSelect={() => setKind("postgres")} />
        <ProviderCard kind="mongo" selected={kind === "mongo"} disabled={Boolean(connection)} onSelect={() => setKind("mongo")} />
      </div>

      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Display name"><Input aria-label="Connection name" value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === "postgres" ? "Production" : "Catalog"} /></Field>
          <Field label="SQL catalog alias"><Input aria-label="SQL catalog alias" value={catalogName} disabled={Boolean(connection)} onChange={(event) => setCatalogName(event.target.value)} placeholder={kind === "postgres" ? "prod" : "catalog_mongo"} /></Field>
        </div>

        {kind === "postgres" ? <>
          <div className="grid grid-cols-[1fr_100px] gap-3">
            <Field label="Host"><Input aria-label="PostgreSQL host" value={postgres.host} onChange={(event) => setPostgres({ ...postgres, host: event.target.value })} /></Field>
            <Field label="Port"><Input aria-label="PostgreSQL port" type="number" min={1} max={65535} value={postgres.port} onChange={(event) => setPostgres({ ...postgres, port: Number(event.target.value) })} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Database"><Input aria-label="PostgreSQL database" value={postgres.database} onChange={(event) => setPostgres({ ...postgres, database: event.target.value })} /></Field>
            <Field label="Username"><Input aria-label="PostgreSQL username" value={postgres.username} onChange={(event) => setPostgres({ ...postgres, username: event.target.value })} /></Field>
          </div>
        </> : <>
          <div className="grid grid-cols-[150px_1fr] gap-3">
            <Field label="Connection mode"><Select value={mongo.mode} onValueChange={(value) => setMongo({ ...mongo, mode: value as MongoConfig["mode"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="mongodb">mongodb</SelectItem><SelectItem value="mongodb+srv">mongodb+srv</SelectItem></SelectContent></Select></Field>
            <Field label="Hosts (comma-separated)"><Input aria-label="MongoDB hosts" value={mongo.hosts.join(", ")} onChange={(event) => setMongo({ ...mongo, hosts: event.target.value.split(",").map((host) => host.trim()).filter(Boolean) })} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Database"><Input aria-label="MongoDB database" value={mongo.database} onChange={(event) => setMongo({ ...mongo, database: event.target.value })} /></Field>
            <Field label="Username (optional)"><Input aria-label="MongoDB username" value={mongo.username ?? ""} onChange={(event) => setMongo({ ...mongo, username: event.target.value })} /></Field>
          </div>
        </>}

        <Field label={connection?.hasSecret ? "Password (leave blank to keep current Keychain password)" : "Password (stored in Keychain)"}>
          <div className="relative"><KeyRound className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" /><Input aria-label="Connection password" className="pl-8" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={connection?.hasSecret ? "Unchanged" : "Optional for passwordless authentication"} /></div>
        </Field>

        <Collapsible>
          <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="w-fit"><ChevronDown /> Advanced settings</Button></CollapsibleTrigger>
          <CollapsibleContent className="mt-2 grid grid-cols-2 gap-3 rounded-md border border-border bg-card/40 p-3">
            {kind === "postgres" ? <>
              <Field label="SSL mode"><Select value={postgres.sslMode} onValueChange={(value) => setPostgres({ ...postgres, sslMode: value as PostgresConfig["sslMode"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></Field>
              <Field label="Schema scope (optional)"><Input value={postgres.schema ?? ""} onChange={(event) => setPostgres({ ...postgres, schema: event.target.value })} /></Field>
              <Field label="Pool size (1–8, when supported)"><Input type="number" min={1} max={8} value={postgres.poolSize} onChange={(event) => setPostgres({ ...postgres, poolSize: Number(event.target.value) })} /></Field>
            </> : <>
              <Field label="Auth source"><Input value={mongo.authSource ?? ""} onChange={(event) => setMongo({ ...mongo, authSource: event.target.value })} /></Field>
              <Field label="Replica set"><Input value={mongo.replicaSet ?? ""} onChange={(event) => setMongo({ ...mongo, replicaSet: event.target.value })} /></Field>
              <Field label="Read preference"><Select value={mongo.readPreference} onValueChange={(value) => setMongo({ ...mongo, readPreference: value as MongoConfig["readPreference"] })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{["primary", "primaryPreferred", "secondary", "secondaryPreferred", "nearest"].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></Field>
              <Toggle label="TLS" checked={mongo.tls} onCheckedChange={(checked) => setMongo({ ...mongo, tls: checked })} />
              <Toggle label="Direct connection" checked={Boolean(mongo.directConnection)} onCheckedChange={(checked) => setMongo({ ...mongo, directConnection: checked })} />
            </>}
            <Field label="Connect timeout (seconds)"><Input type="number" min={1} max={60} value={kind === "postgres" ? postgres.connectTimeoutSeconds : mongo.connectTimeoutSeconds} onChange={(event) => kind === "postgres" ? setPostgres({ ...postgres, connectTimeoutSeconds: Number(event.target.value) }) : setMongo({ ...mongo, connectTimeoutSeconds: Number(event.target.value) })} /></Field>
            <Toggle label="Connect automatically at startup" checked={autoConnect} onCheckedChange={setAutoConnect} />
          </CollapsibleContent>
        </Collapsible>

        <div className="grid gap-2 rounded-md border border-primary/15 bg-primary/5 p-3 text-[10px] leading-4 text-muted-foreground">
          <p className="flex gap-2"><Network className="mt-0.5 size-3.5 shrink-0 text-primary" />The first connection may download the signed DuckDB {kind === "postgres" ? "PostgreSQL" : "MongoDB community"} extension. It is cached in the app&apos;s private directory.</p>
          <p className="flex gap-2"><KeyRound className="mt-0.5 size-3.5 shrink-0 text-primary" />Passwords never enter the workspace database, bootstrap payload, events, or browser storage.</p>
        </div>

        {kind === "mongo" && <label className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-[10px] leading-4">
          <input type="checkbox" className="mt-0.5 accent-current" checked={mongo.experimentalConsent} onChange={(event) => setMongo({ ...mongo, experimentalConsent: event.target.checked })} />
          <span><strong className="text-warning">Experimental MongoDB support.</strong> The community extension may be unavailable on some architectures, and inferred columns can vary across heterogeneous documents.</span>
        </label>}

        {feedback && <div role={feedback.ok ? "status" : "alert"} className={cn("flex items-start gap-2 rounded-md border p-2.5 text-[10px]", feedback.ok ? "border-primary/25 bg-primary/10 text-primary" : "border-destructive/30 bg-destructive/10 text-destructive")}>
          {feedback.ok ? <CheckCircle2 className="size-3.5 shrink-0" /> : <AlertTriangle className="size-3.5 shrink-0" />}{feedback.message}
        </div>}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => changeOpen(false)} disabled={Boolean(busy)}>Cancel</Button>
        <Button variant="secondary" onClick={() => void test()} disabled={Boolean(busy) || Boolean(validation)}>{busy === "test" ? <Loader2 className="animate-spin" /> : <FlaskConical />} Test connection</Button>
        <Button onClick={() => void save()} disabled={Boolean(busy) || Boolean(validation)}>{busy === "save" ? <Loader2 className="animate-spin" /> : <Database />} {projectId ? "Save & connect" : "Save changes"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function ProviderCard({ kind, selected, disabled, onSelect }: { kind: ConnectionKind; selected: boolean; disabled: boolean; onSelect: () => void }) {
  const mongo = kind === "mongo";
  return <button type="button" disabled={disabled && !selected} onClick={onSelect} className={cn("rounded-lg border p-3 text-left transition-colors", selected ? "border-primary/40 bg-primary/10" : "border-border bg-card hover:border-primary/20", disabled && !selected && "opacity-40")}>
    <span className="flex items-center gap-2"><Database className={cn("size-4", selected ? "text-primary" : "text-muted-foreground")} /><strong className="text-[12px]">{mongo ? "MongoDB" : "PostgreSQL"}</strong><Badge variant={mongo ? "warning" : "default"} className="ml-auto">{mongo ? "Experimental" : "Stable"}</Badge></span>
    <span className="mt-1 block text-[9px] text-muted-foreground">{mongo ? "Collections with inferred schemas" : "Read-only schemas, tables, and views"}</span>
  </button>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="grid gap-1.5"><Label>{label}</Label>{children}</div>; }
function Toggle({ label, checked, onCheckedChange }: { label: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) { return <div className="flex min-h-8 items-center justify-between gap-3"><Label>{label}</Label><Switch checked={checked} onCheckedChange={onCheckedChange} /></div>; }
