import { Braces, DatabaseZap, FileUp, Gauge, HardDrive, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/layout/BrandMark";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  onChoose: () => void;
  onConnect?: () => void;
  dragActive?: boolean;
  projectName?: string;
}

export function EmptyState({ onChoose, onConnect, dragActive = false, projectName }: EmptyStateProps) {
  return (
    <section
      className={cn("relative grid h-full place-items-center overflow-hidden bg-background p-8 transition-colors duration-300", dragActive && "bg-primary/[0.06]")}
      aria-label="Import data files"
      data-drag-active={dragActive}
    >
      {/* Faint data-grid floor: gives the void a sense of place. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.35] [mask-image:radial-gradient(circle_at_50%_45%,black,transparent_72%)]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(160,255,205,.055) 1px, transparent 1px), linear-gradient(90deg, rgba(160,255,205,.055) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />
      {dragActive && <div className="ducs-marching pointer-events-none absolute inset-3 rounded-2xl bg-primary/5" />}

      <div className="relative max-w-xl text-center">
        <div className="relative mx-auto grid size-20 place-items-center">
          {/* Halo rings behind the mark */}
          <span aria-hidden="true" className="absolute inset-0 rounded-[26px] border border-primary/20 animate-ducs-breathe" />
          <span aria-hidden="true" className="absolute -inset-6 rounded-[38px] bg-primary/[0.07] blur-2xl" />
          <span className="ducs-glass-card relative grid size-16 place-items-center rounded-2xl text-primary">
            {dragActive
              ? <FileUp className="size-7 animate-ducs-pop" aria-hidden="true" />
              : <BrandMark size={34} animated />}
          </span>
        </div>

        <h2 className="ducs-display ducs-brand-text mt-6 text-[26px] leading-tight">Drop a data file anywhere</h2>
        <p className="mt-2 text-[13px] text-muted-foreground">CSV, TSV, JSON, JSONL or XLSX — processed locally</p>
        {projectName && <p className="mt-1 text-[11px] text-muted-foreground/80">Add the first source to {projectName}.</p>}

        <div className="mt-6 h-9" aria-live="polite">
          {dragActive ? (
            <p className="flex h-9 items-center justify-center gap-1.5 text-[12px] font-medium text-primary"><FileUp className="size-3.5 animate-bounce" aria-hidden="true" /> Release to import files</p>
          ) : (
            <span className="inline-flex gap-2">
              <Button size="lg" onClick={onChoose}><FileUp aria-hidden="true" /> Open data file</Button>
              <Button variant="secondary" size="lg" onClick={onConnect}><DatabaseZap aria-hidden="true" /> Connect database</Button>
            </span>
          )}
        </div>

        <div className="ducs-stagger mt-9 grid grid-cols-3 gap-2 text-left">
          <Feature icon={<HardDrive />} title="Local" detail="Files stay on this Mac" />
          <Feature icon={<Gauge />} title="Fast" detail="DuckDB-backed paging" />
          <Feature icon={<Braces />} title="SQL-ready" detail="Join every imported table" />
        </div>

        <p className="mt-6 flex items-center justify-center gap-1.5 text-[10.5px] text-muted-foreground/70">
          <Sparkles className="size-3 text-primary/70" aria-hidden="true" />
          Tip: press <span className="ducs-kbd">⌘</span><span className="ducs-kbd">T</span> to start a query on an empty workspace
        </p>
      </div>
    </section>
  );
}

function Feature({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return (
    <div className="ducs-glass-card group rounded-xl p-3 transition-[transform,border-color,box-shadow] duration-300 ease-soft hover:-translate-y-0.5 hover:border-primary/25 motion-reduce:hover:translate-y-0">
      <span className="grid size-7 place-items-center rounded-lg border border-primary/20 bg-primary/10 text-primary transition-colors duration-300 group-hover:bg-primary/20 [&>svg]:size-3.5">{icon}</span>
      <p className="mt-2.5 text-[11.5px] font-medium text-foreground">{title}</p>
      <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{detail}</p>
    </div>
  );
}
