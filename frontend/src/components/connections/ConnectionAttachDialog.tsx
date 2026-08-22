import { Database, Link2, Loader2, Plus, Settings2 } from "lucide-react";
import type { ConnectionInfo } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface ConnectionAttachDialogProps {
  open: boolean;
  projectName: string;
  availableConnections: readonly ConnectionInfo[];
  attachingId?: string;
  onOpenChange: (open: boolean) => void;
  onAttach: (connection: ConnectionInfo) => void;
  onNew: () => void;
  onManage: () => void;
}

export function ConnectionAttachDialog(props: ConnectionAttachDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add connection to {props.projectName}</DialogTitle>
          <DialogDescription>Reuse a global connection or create a new one. Credentials remain in the system Keychain.</DialogDescription>
        </DialogHeader>
        <section aria-label="Attach existing connection" className="grid gap-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Attach existing</h3>
          {props.availableConnections.length ? props.availableConnections.map((connection) => (
            <div key={connection.id} className="flex items-center gap-2 rounded-md border border-border bg-card p-3">
              <Database className="size-4 text-primary" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-medium">{connection.name}</p>
                <p className="truncate text-[9px] text-muted-foreground">{connection.kind === "mongo" ? "MongoDB" : "PostgreSQL"} · {connection.catalogName}</p>
              </div>
              <Badge variant={connection.status === "connected" ? "default" : "muted"}>{connection.status}</Badge>
              <Button size="sm" variant="secondary" onClick={() => props.onAttach(connection)} disabled={Boolean(props.attachingId)} aria-label={`Attach ${connection.name}`}>
                {props.attachingId === connection.id ? <Loader2 className="animate-spin" /> : <Link2 />} Attach
              </Button>
            </div>
          )) : <div className="rounded-md border border-dashed border-border p-5 text-center text-[11px] text-muted-foreground">No reusable global connections are available for this project.</div>}
        </section>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={props.onNew}><Plus aria-hidden="true" /> New connection</Button>
          <Button variant="ghost" onClick={props.onManage}><Settings2 aria-hidden="true" /> Manage global connections</Button>
        </div>
        <DialogFooter><Button variant="ghost" onClick={() => props.onOpenChange(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
