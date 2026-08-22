import { useEffect, useState } from "react";
import { Database, Edit3, Loader2, Trash2 } from "lucide-react";
import type { ConnectionInfo } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface ConnectionManagerDialogProps {
  open: boolean;
  connections: readonly ConnectionInfo[];
  onOpenChange: (open: boolean) => void;
  onEdit: (connection: ConnectionInfo) => void;
  onUsageCount: (connectionId: string) => Promise<number>;
  onDelete: (connection: ConnectionInfo) => Promise<void>;
}

export function ConnectionManagerDialog(props: ConnectionManagerDialogProps) {
  const onUsageCount = props.onUsageCount;
  const [target, setTarget] = useState<ConnectionInfo>();
  const [usage, setUsage] = useState<number>();
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!target) return;
    let alive = true;
    setUsage(undefined);
    setConfirmation("");
    setError(undefined);
    void onUsageCount(target.id).then((count) => { if (alive) setUsage(count); }).catch((value) => {
      if (alive) setError(value instanceof Error ? value.message : String(value));
    });
    return () => { alive = false; };
  }, [onUsageCount, target]);

  const remove = async () => {
    if (!target || confirmation !== target.name) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.onDelete(target);
      setTarget(undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open={props.open} onOpenChange={(open) => !busy && props.onOpenChange(open)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Global connections</DialogTitle>
            <DialogDescription>Edits apply everywhere. Remove a connection here only when every project should lose it.</DialogDescription>
          </DialogHeader>
          <div className="grid max-h-96 gap-2 overflow-auto">
            {props.connections.length ? props.connections.map((connection) => (
              <article key={connection.id} className="flex items-center gap-3 rounded-md border border-border bg-card p-3">
                <Database className="size-4 text-primary" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-[12px] font-medium">{connection.name}</h3>
                  <p className="truncate text-[9px] text-muted-foreground">{connection.kind === "mongo" ? "MongoDB" : "PostgreSQL"} · {connection.catalogName}</p>
                </div>
                <Badge variant={connection.status === "connected" ? "default" : connection.status === "error" ? "destructive" : "muted"}>{connection.status}</Badge>
                <Button variant="ghost" size="sm" onClick={() => props.onEdit(connection)}><Edit3 aria-hidden="true" /> Edit</Button>
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setTarget(connection)}><Trash2 aria-hidden="true" /> Delete everywhere</Button>
              </article>
            )) : <p className="rounded-md border border-dashed border-border p-6 text-center text-[11px] text-muted-foreground">No global connections yet.</p>}
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => props.onOpenChange(false)}>Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(target)} onOpenChange={(open) => !open && !busy && setTarget(undefined)}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete “{target?.name}” everywhere?</AlertDialogTitle>
          <AlertDialogDescription>
            {usage === undefined ? "Checking project usage…" : `This connection is attached to ${usage} project${usage === 1 ? "" : "s"}. Its metadata and Keychain credential will be deleted globally; local snapshots remain.`}
          </AlertDialogDescription>
          <label className="grid gap-1.5 text-[11px]">
            Type <strong>{target?.name}</strong> to confirm
            <Input aria-label="Connection deletion confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" />
          </label>
          {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy || usage === undefined || confirmation !== target?.name} onClick={() => void remove()}>
              {busy ? <Loader2 className="animate-spin" /> : null} Delete everywhere
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
