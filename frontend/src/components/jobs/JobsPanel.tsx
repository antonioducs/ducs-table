import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Ban, CheckCircle2, Clock3, LoaderCircle, Pause, X } from "lucide-react";
import type { Job, JobState, Project } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { presentAppError } from "@/lib/app-error";
import { cn, formatElapsed } from "@/lib/utils";

export interface JobsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobs: readonly Job[];
  projects?: readonly Project[];
  activeProjectId?: string;
  onCancel: (job: Job) => void;
}

interface JobStateDetails {
  label: string;
  variant: "default" | "muted" | "warning" | "destructive";
  icon: LucideIcon;
  iconClassName: string;
}

const stateDetails: Record<JobState, JobStateDetails> = {
  queued: { label: "Queued", variant: "muted", icon: Pause, iconClassName: "text-muted-foreground" },
  running: { label: "Running", variant: "warning", icon: LoaderCircle, iconClassName: "animate-spin text-warning" },
  completed: { label: "Completed", variant: "default", icon: CheckCircle2, iconClassName: "text-primary" },
  failed: { label: "Failed", variant: "destructive", icon: AlertTriangle, iconClassName: "text-destructive" },
  cancelled: { label: "Cancelled", variant: "muted", icon: Ban, iconClassName: "text-muted-foreground" },
};

function titleFor(job: Job): string {
  return job.label?.trim() || job.sourceName?.trim() || `${job.kind.charAt(0).toUpperCase()}${job.kind.slice(1)} job`;
}

function percentage(progress?: number): number | undefined {
  if (progress === undefined || !Number.isFinite(progress)) return undefined;
  return Math.min(100, Math.max(0, Math.round(progress <= 1 ? progress * 100 : progress)));
}

function JobRow({ job, projectName, onCancel }: { job: Job; projectName: string; onCancel: (job: Job) => void }) {
  const details = stateDetails[job.state];
  const Icon = details.icon;
  const title = titleFor(job);
  const error = job.error ? presentAppError(job.error, job.message ?? `${job.kind} failed`, job.stage) : undefined;
  const stage = error?.stage ?? job.stage;
  const message = error?.message ?? job.message;
  const progress = percentage(job.progress);
  const cancellable = job.state === "queued" || job.state === "running";
  const elapsed = formatElapsed(job.startedAt ?? job.createdAt, job.finishedAt);

  return (
    <article
      className={cn(
        "grid animate-ducs-rise gap-2.5 border-b border-border p-3 transition-colors duration-200 last:border-b-0 hover:bg-white/[0.02]",
        job.state === "running" && "bg-primary/[0.03]",
      )}
      data-job-state={job.state}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className={cn(
          "grid size-7 shrink-0 place-items-center rounded-lg border border-border bg-muted",
          job.state === "running" && "border-warning/30 bg-warning/10",
          job.state === "completed" && "border-primary/25 bg-primary/10",
          job.state === "failed" && "border-destructive/30 bg-destructive/10",
        )}>
          <Icon className={cn("size-3.5", details.iconClassName)} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[12px] font-medium text-foreground" title={title}>{title}</h3>
          <p className="ducs-eyebrow mt-0.5 truncate text-muted-foreground/80">{job.kind} · {projectName}</p>
        </div>
        <Badge variant={details.variant} className="h-4 px-1.5 text-[8px] uppercase leading-none">{details.label}</Badge>
      </div>

      {(stage || message || error?.suggestion || error?.shortErrorRef || error?.logPath) && (
        <div className="grid gap-0.5 pl-9 text-[10px] leading-4">
          {stage && <p className="font-medium text-foreground">{error?.stage ? <>Stage: <code>{stage}</code></> : stage}</p>}
          {message && message !== stage && <p className={job.state === "failed" ? "text-destructive" : "text-muted-foreground"}>{message}</p>}
          {error?.suggestion && <p className="text-muted-foreground">{error.suggestion}</p>}
          {(error?.shortErrorRef || error?.logPath) && <p className="flex min-w-0 flex-wrap gap-x-2 text-muted-foreground">
            {error.shortErrorRef && <span>Reference: <code className="text-foreground" title={error.errorRef}>{error.shortErrorRef}</code></span>}
            {error.logPath && <span className="min-w-0">Log: <code className="break-all text-foreground" title={error.logPath}>{error.logPath}</code></span>}
          </p>}
        </div>
      )}

      {progress !== undefined && (job.state === "running" || job.state === "completed") && (
        <div className="pl-9">
          <div className="h-1.5 overflow-hidden rounded-full border border-border/60 bg-black/40" role="progressbar" aria-label={`Progress for ${title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <div
              className="h-full rounded-full bg-gradient-to-r from-brand-500 via-primary to-brand-200 shadow-[0_0_10px_rgba(52,224,127,.7)] transition-[width] duration-500 ease-soft"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="ducs-num mt-1 text-right text-[9.5px] text-muted-foreground">{progress}%</p>
        </div>
      )}

      <div className="flex items-center gap-2 pl-9 text-[10px] text-muted-foreground">
        <span className="ducs-num flex items-center gap-1"><Clock3 className="size-3" aria-hidden="true" /> Elapsed {elapsed}</span>
        {cancellable && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onCancel(job)}
            aria-label={`Cancel ${title}`}
          ><X aria-hidden="true" /> Cancel</Button>
        )}
      </div>
    </article>
  );
}

export function JobsPanel({ open, onOpenChange, jobs, projects = [], activeProjectId, onCancel }: JobsPanelProps) {
  const activeCount = jobs.filter((job) => job.state === "queued" || job.state === "running").length;
  const projectNames = Object.fromEntries(projects.map((project) => [project.id, project.name]));
  const currentJobs = activeProjectId ? jobs.filter((job) => job.projectId === activeProjectId) : [];
  const otherJobs = activeProjectId ? jobs.filter((job) => job.projectId !== activeProjectId) : [...jobs];
  const rows = (items: readonly Job[]) => items.map((job) => <JobRow key={job.id} job={job} projectName={projectNames[job.projectId] ?? "Unknown project"} onCancel={onCancel} />);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Side drawer: overrides the dialog's centered zoom with a right-edge slide. */}
      <DialogContent className="left-auto right-0 top-0 h-dvh max-h-none w-[390px] max-w-[calc(100%-2rem)] grid-rows-[auto_1fr] translate-x-0 translate-y-0 gap-0 rounded-none border-y-0 border-r-0 p-0 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100">
        <DialogHeader className="border-b border-border px-4 py-3 pr-11">
          <div className="flex items-center gap-2">
            <DialogTitle>Jobs</DialogTitle>
            {activeCount > 0 && <Badge variant="warning">{activeCount} active</Badge>}
          </div>
          <DialogDescription>Imports and long-running local operations.</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0" aria-live="polite">
          {jobs.length > 0 ? <>
            {activeProjectId && <section aria-label="Current project jobs">
              <h2 className="ducs-eyebrow sticky top-0 z-10 border-b border-border bg-popover/95 px-3 py-2 text-muted-foreground/85 backdrop-blur-sm">Current project · {projectNames[activeProjectId] ?? "Unknown project"}</h2>
              {currentJobs.length ? rows(currentJobs) : <p className="border-b border-border px-3 py-3 text-[10px] text-muted-foreground">No jobs for the current project.</p>}
            </section>}
            <section aria-label="Other projects jobs">
              <h2 className="ducs-eyebrow sticky top-0 z-10 border-b border-border bg-popover/95 px-3 py-2 text-muted-foreground/85 backdrop-blur-sm">Other projects</h2>
              {otherJobs.length ? rows(otherJobs) : <p className="px-3 py-3 text-[10px] text-muted-foreground">No jobs from other projects.</p>}
            </section>
          </> : (
            <div className="grid min-h-56 place-items-center p-6 text-center">
              <div className="ducs-rise">
                <span className="ducs-glass-card mx-auto grid size-11 place-items-center rounded-xl text-primary"><CheckCircle2 className="size-5" aria-hidden="true" /></span>
                <p className="ducs-display mt-3 text-[13px] text-foreground">No jobs yet</p>
                <p className="mt-1 text-[10.5px] text-muted-foreground">Local activity will appear here.</p>
              </div>
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
