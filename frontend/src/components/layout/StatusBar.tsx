import { Columns3, Database, HardDrive, LoaderCircle, Rows3, ShieldCheck } from "lucide-react";
import type { Job, SourceInfo } from "@/types";
import { formatCount } from "@/lib/utils";

export interface StatusBarProps {
  source?: SourceInfo;
  activeJobs?: number | readonly Job[];
  /** Compatibility with the shell while it passes the complete job history. */
  jobs?: readonly Job[];
}

function Divider() {
  return <span aria-hidden="true" className="h-3 w-px bg-border" />;
}

export function StatusBar({ source, activeJobs, jobs = [] }: StatusBarProps) {
  const activeCount = typeof activeJobs === "number"
    ? activeJobs
    : (activeJobs ?? jobs).filter((job) => job.state === "queued" || job.state === "running").length;
  const busy = activeCount > 0;
  return (
    <footer className="ducs-glass-bar relative flex h-7 shrink-0 items-center gap-3 border-t border-border bg-card px-3 text-[10.5px] text-muted-foreground">
      {/* A thread of brand light while work is in flight. */}
      {busy && <span aria-hidden="true" className="ducs-trace absolute inset-x-0 top-0 h-px opacity-80" />}

      <span className="flex items-center gap-1.5 font-medium text-brand-300">
        <ShieldCheck className="size-3" aria-hidden="true" /> Processed locally
      </span>
      <Divider />
      <span className="flex items-center gap-1.5" aria-live="polite">
        {busy
          ? <LoaderCircle className="size-3 animate-spin text-warning" aria-hidden="true" />
          : <span className="ducs-live-dot" aria-hidden="true" />}
        <span className={busy ? "ducs-num text-warning" : undefined}>
          {busy ? `${activeCount} active job${activeCount === 1 ? "" : "s"}` : (source?.status ?? "Ready")}
        </span>
      </span>
      {source && (
        <>
          <Divider />
          <span className="ducs-num flex items-center gap-3">
            <span className="flex items-center gap-1.5"><Rows3 className="size-3 opacity-70" aria-hidden="true" />{source.rowCount === null ? "Row count pending" : `${formatCount(source.rowCount)} rows`}</span>
            <span className="flex items-center gap-1.5"><Columns3 className="size-3 opacity-70" aria-hidden="true" />{source.columns.length} columns</span>
          </span>
        </>
      )}
      <span className="ml-auto flex items-center gap-3">
        <span className="flex items-center gap-1.5"><HardDrive className="size-3 opacity-70" aria-hidden="true" /> On this Mac</span>
        <Divider />
        <span className="flex items-center gap-1.5 text-foreground/70"><Database className="size-3 text-primary/80" aria-hidden="true" /> DuckDB local</span>
      </span>
    </footer>
  );
}
