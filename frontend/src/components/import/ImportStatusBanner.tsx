import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Ban, Clock3, Eye, LoaderCircle, RotateCcw, SearchX, X } from "lucide-react";
import type { Job, SourceInfo, SourceStatus } from "@/types";
import { Button } from "@/components/ui/button";
import { cn, formatElapsed } from "@/lib/utils";

export type SourceViewState = SourceStatus | "no-results";

export interface SourceStateProps {
  source: SourceInfo;
  job?: Job;
  elapsed?: string;
  onCancel?: () => void;
  onRetry?: () => void;
  className?: string;
}

interface StateDetails {
  title: string;
  description: string;
  icon: LucideIcon;
  tone: string;
  active: boolean;
}

function stateFor(source: SourceInfo): SourceViewState {
  return source.status === "ready" && source.rowCount === 0 ? "no-results" : source.status;
}

function detailsFor(state: SourceViewState, source: SourceInfo, job?: Job): StateDetails | null {
  switch (state) {
    case "preview":
      return { title: "Preview available", description: job?.message ?? "Showing a sample while the complete dataset is prepared.", icon: Eye, tone: "text-primary", active: true };
    case "preparing":
      return { title: "Preparing for fast queries…", description: job?.message ?? "Materializing rows in DuckDB for fast local queries.", icon: LoaderCircle, tone: "text-warning", active: true };
    case "failed":
      return { title: "Import failed", description: source.error?.message ?? job?.error?.message ?? "The source could not be prepared.", icon: AlertTriangle, tone: "text-destructive", active: false };
    case "cancelled":
      return { title: "Import cancelled", description: job?.message ?? "The source can be imported again with different options.", icon: Ban, tone: "text-warning", active: false };
    case "no-results":
      return { title: "No results", description: source.isEphemeral ? "The query completed successfully but returned no rows." : "This table contains no rows.", icon: SearchX, tone: "text-muted-foreground", active: false };
    case "ready":
      return null;
  }
}

function elapsedFor(job?: Job, elapsed?: string): string | undefined {
  if (elapsed) return elapsed;
  if (!job) return undefined;
  return formatElapsed(job.startedAt ?? job.createdAt, job.finishedAt);
}

function StateAction({ state, onCancel, onRetry, compact = false }: Pick<SourceStateProps, "onCancel" | "onRetry"> & { state: SourceViewState; compact?: boolean }) {
  if ((state === "preview" || state === "preparing") && onCancel) {
    return <Button variant="outline" size="sm" onClick={onCancel}><X aria-hidden="true" /> Cancel</Button>;
  }
  if ((state === "failed" || state === "cancelled") && onRetry) {
    return <Button variant={compact ? "outline" : "default"} size="sm" onClick={onRetry}><RotateCcw aria-hidden="true" /> {state === "failed" ? "Retry options" : "Retry"}</Button>;
  }
  return null;
}

export function SourceStateBanner({ source, job, elapsed, onCancel, onRetry, className }: SourceStateProps) {
  const state = stateFor(source);
  const details = detailsFor(state, source, job);
  if (!details) return null;
  const Icon = details.icon;
  const elapsedLabel = elapsedFor(job, elapsed);

  return (
    <div
      className={cn("flex min-h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-2.5 py-1.5", className)}
      role={state === "failed" ? "alert" : "status"}
      aria-live="polite"
      aria-busy={details.active}
      data-source-state={state}
    >
      <Icon className={cn("size-3.5 shrink-0", details.tone, state === "preparing" && "animate-spin")} aria-hidden="true" />
      <div className="min-w-0 flex-1 text-[11px]">
        <span className="font-medium text-foreground">{details.title}</span>
        <span className="ml-1.5 text-muted-foreground">{details.description}</span>
      </div>
      {job?.stage && job.stage !== job.message && <code className="hidden max-w-40 truncate text-[9px] text-muted-foreground xl:block">{job.stage}</code>}
      {elapsedLabel && (
        <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"><Clock3 className="size-3" aria-hidden="true" /> {elapsedLabel}</span>
      )}
      <StateAction state={state} onCancel={onCancel} onRetry={onRetry} compact />
    </div>
  );
}

export function SourceStateOverlay({ source, job, elapsed, onCancel, onRetry, className }: SourceStateProps) {
  const state = stateFor(source);
  const details = detailsFor(state, source, job);
  if (!details) return null;
  const Icon = details.icon;
  const elapsedLabel = elapsedFor(job, elapsed);

  return (
    <div
      className={cn("grid h-full min-h-48 place-items-center bg-background/95 p-6", className)}
      role={state === "failed" ? "alert" : "status"}
      aria-live="polite"
      aria-busy={details.active}
      data-source-state={state}
    >
      <div className="flex max-w-md flex-col items-center text-center">
        <span className={cn("grid size-10 place-items-center rounded-lg border border-border bg-card", details.tone)}>
          <Icon className={cn("size-4", state === "preparing" && "animate-spin")} aria-hidden="true" />
        </span>
        <h2 className="mt-3 text-[14px] font-semibold text-foreground">{details.title}</h2>
        <p className="mt-1 max-w-sm text-[11px] leading-5 text-muted-foreground">{details.description}</p>
        {job?.stage && job.stage !== job.message && <code className="mt-2 rounded border border-border bg-muted px-2 py-1 text-[10px] text-muted-foreground">{job.stage}</code>}
        {elapsedLabel && <span className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground"><Clock3 className="size-3" aria-hidden="true" /> Elapsed {elapsedLabel}</span>}
        <div className="mt-4"><StateAction state={state} onCancel={onCancel} onRetry={onRetry} /></div>
      </div>
    </div>
  );
}

export function ImportStatusBanner(props: SourceStateProps) {
  return <SourceStateBanner {...props} />;
}
