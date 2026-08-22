import { useEffect, useState } from "react";
import { Download, Eye, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function NameDialog({ open, onOpenChange, title, description, initialName = "", actionLabel, busy, onSubmit }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  initialName?: string;
  actionLabel: string;
  busy?: boolean;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  useEffect(() => { if (open) setName(initialName); }, [initialName, open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
        <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && name.trim() && !busy) onSubmit(name.trim()); }} placeholder="Name" />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!name.trim() || busy} onClick={() => onSubmit(name.trim())}>{busy ? "Saving…" : actionLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ExportDialog({ open, onOpenChange, busy, onExport }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onExport: (scope: "entire" | "current-view") => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Export CSV</DialogTitle><DialogDescription>DuckDB writes directly to the destination you choose. Rows never pass through the web view.</DialogDescription></DialogHeader>
        <div className="grid gap-2">
          <button disabled={busy} onClick={() => onExport("entire")} className="flex items-start gap-3 rounded-lg border border-border bg-background p-3 text-left outline-none hover:border-primary/35 hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            <Table2 className="mt-0.5 size-4 text-primary" /><span><span className="block text-[12px] font-medium">Entire table or result</span><span className="mt-0.5 block text-[10px] text-muted-foreground">Every row and column in the source.</span></span>
          </button>
          <button disabled={busy} onClick={() => onExport("current-view")} className="flex items-start gap-3 rounded-lg border border-border bg-background p-3 text-left outline-none hover:border-primary/35 hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            <Eye className="mt-0.5 size-4 text-primary" /><span><span className="block text-[12px] font-medium">Current view</span><span className="mt-0.5 block text-[10px] text-muted-foreground">Visible columns in order, with active filters and sorting.</span></span>
          </button>
        </div>
        {busy && <p className="flex items-center gap-2 text-[11px] text-primary"><Download className="ducs-pulse size-3.5" /> Exporting with DuckDB…</p>}
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog({ open, onOpenChange, title, description, actionLabel = "Remove", onConfirm }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  actionLabel?: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
        <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={onConfirm}>{actionLabel}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

