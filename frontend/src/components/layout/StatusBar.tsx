import { CircleCheck, Database, HardDrive, LoaderCircle } from "lucide-react";
import type { Job, SourceInfo } from "@/types";
import { formatCount } from "@/lib/utils";

export interface StatusBarProps {
  source?: SourceInfo;
  activeJobs?: number | readonly Job[];
  /** Compatibility with the shell while it passes the complete job history. */
  jobs?: readonly Job[];
}

export function StatusBar({ source, activeJobs, jobs = [] }: StatusBarProps) {
  const activeCount = typeof activeJobs === "number"
    ? activeJobs
    : (activeJobs ?? jobs).filter((job) => job.state === "queued" || job.state === "running").length;
  return (
    <footer className="ducs-glass-bar flex h-7 shrink-0 items-center gap-4 border-t border-border bg-card px-3 text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1.5 text-primary"><HardDrive className="size-3" aria-hidden="true" /> Processed locally</span>
      <span className="flex items-center gap-1.5" aria-live="polite">
        {activeCount > 0 ? <LoaderCircle className="size-3 animate-spin text-warning" aria-hidden="true" /> : <CircleCheck className="size-3 text-primary" aria-hidden="true" />}
        {activeCount > 0 ? `${activeCount} active job${activeCount === 1 ? "" : "s"}` : (source?.status ?? "Ready")}
      </span>
      {source && <span>{source.rowCount === null ? "Row count pending" : `${formatCount(source.rowCount)} rows`} · {source.columns.length} columns</span>}
      <span className="ml-auto flex items-center gap-1.5"><Database className="size-3" aria-hidden="true" /> DuckDB local</span>
    </footer>
  );
}
