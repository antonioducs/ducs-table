import { Braces, DatabaseZap, FileUp, Gauge, HardDrive, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  onChoose: () => void;
  onConnect?: () => void;
  dragActive?: boolean;
}

export function EmptyState({ onChoose, onConnect, dragActive = false }: EmptyStateProps) {
  return (
    <section
      className={cn("relative grid h-full place-items-center overflow-hidden bg-background p-8 transition-colors", dragActive && "bg-primary/5")}
      aria-label="Import data files"
      data-drag-active={dragActive}
    >
      {dragActive && <div className="pointer-events-none absolute inset-3 rounded-xl border-2 border-dashed border-primary bg-primary/5" />}
      <div className="relative max-w-xl text-center">
        <div className="mx-auto grid size-16 place-items-center rounded-2xl border border-primary/25 bg-card text-primary shadow-[0_0_40px_rgba(50,230,126,.08)]">
          {dragActive ? <FileUp className="size-7" aria-hidden="true" /> : <Table2 className="size-7" aria-hidden="true" />}
        </div>
        <h2 className="mt-5 text-xl font-semibold tracking-tight">Drop a data file anywhere</h2>
        <p className="mt-2 text-[13px] text-muted-foreground">CSV, TSV, JSON, JSONL or XLSX — processed locally</p>
        <div className="mt-5 h-9" aria-live="polite">
          {dragActive ? (
            <p className="flex h-9 items-center justify-center gap-1.5 text-[12px] font-medium text-primary"><FileUp className="size-3.5" aria-hidden="true" /> Release to import files</p>
          ) : (
            <span className="inline-flex gap-2"><Button className="h-9 px-4" onClick={onChoose}><FileUp aria-hidden="true" /> Open data file</Button><Button variant="secondary" className="h-9 px-4" onClick={onConnect}><DatabaseZap aria-hidden="true" /> Connect database</Button></span>
          )}
        </div>
        <div className="mt-8 grid grid-cols-3 gap-2 text-left">
          <Feature icon={<HardDrive />} title="Local" detail="Files stay on this Mac" />
          <Feature icon={<Gauge />} title="Fast" detail="DuckDB-backed paging" />
          <Feature icon={<Braces />} title="SQL-ready" detail="Join every imported table" />
        </div>
      </div>
    </section>
  );
}

function Feature({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <span className="text-primary [&>svg]:size-3.5">{icon}</span>
      <p className="mt-2 text-[11px] font-medium text-foreground">{title}</p>
      <p className="mt-0.5 text-[9px] leading-4 text-muted-foreground">{detail}</p>
    </div>
  );
}
