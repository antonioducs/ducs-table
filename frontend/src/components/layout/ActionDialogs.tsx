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
        <div className="ducs-stagger grid gap-2">
          <ExportChoice
            busy={busy}
            icon={<Table2 />}
            title="Entire table or result"
            detail="Every row and column in the source."
            onSelect={() => onExport("entire")}
          />
          <ExportChoice
            busy={busy}
            icon={<Eye />}
            title="Current view"
            detail="Visible columns in order, with active filters and sorting."
            onSelect={() => onExport("current-view")}
          />
        </div>
        {busy && (
          <p className="flex items-center gap-2 text-[11px] text-primary"><Download className="ducs-pulse size-3.5" /> Exporting with DuckDB…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ExportChoice({ busy, icon, title, detail, onSelect }: {
  busy: boolean;
  icon: React.ReactNode;
  title: string;
  detail: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onSelect}
      className="group flex items-start gap-3 rounded-xl border border-border bg-background/60 p-3 text-left outline-none transition-[border-color,background-color,transform,box-shadow] duration-200 ease-soft hover:-translate-y-px hover:border-primary/40 hover:bg-primary/[0.06] hover:shadow-[0_10px_26px_-16px_rgba(52,224,127,.8)] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-reduce:hover:translate-y-0"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-primary/20 bg-primary/10 text-primary transition-colors duration-200 group-hover:bg-primary/20 [&>svg]:size-4">{icon}</span>
      <span>
        <span className="block text-[12.5px] font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-[10.5px] leading-4 text-muted-foreground">{detail}</span>
      </span>
    </button>
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

