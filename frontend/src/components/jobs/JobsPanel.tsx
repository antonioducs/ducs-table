import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Ban, CheckCircle2, Clock3, LoaderCircle, Pause, X } from "lucide-react";
import type { Job, JobState, Project } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  const message = job.error?.message ?? job.message;
  const progress = percentage(job.progress);
  const cancellable = job.state === "queued" || job.state === "running";
  const elapsed = formatElapsed(job.startedAt ?? job.createdAt, job.finishedAt);

  return (
    <article className="grid gap-2.5 border-b border-border p-3 last:border-b-0" data-job-state={job.state}>
      <div className="flex min-w-0 items-start gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-muted">
          <Icon className={cn("size-3.5", details.iconClassName)} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[12px] font-medium text-foreground" title={title}>{title}</h3>
          <p className="mt-0.5 truncate text-[9px] uppercase tracking-wide text-muted-foreground">{job.kind} · {projectName}</p>
        </div>
        <Badge variant={details.variant} className="h-4 px-1.5 text-[8px] uppercase leading-none">{details.label}</Badge>
      </div>

      {(job.stage || message) && (
        <div className="grid gap-0.5 pl-9 text-[10px] leading-4">
          {job.stage && <p className="font-medium text-foreground">{job.stage}</p>}
          {message && message !== job.stage && <p className={job.state === "failed" ? "text-destructive" : "text-muted-foreground"}>{message}</p>}
        </div>
      )}

      {progress !== undefined && (job.state === "running" || job.state === "completed") && (
        <div className="pl-9">
          <div className="h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`Progress for ${title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-1 text-right text-[9px] text-muted-foreground">{progress}%</p>
        </div>
      )}

      <div className="flex items-center gap-2 pl-9 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><Clock3 className="size-3" aria-hidden="true" /> Elapsed {elapsed}</span>
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
      <DialogContent className="left-auto right-0 top-0 h-dvh max-h-none w-[390px] max-w-[calc(100%-2rem)] grid-rows-[auto_1fr] translate-x-0 translate-y-0 gap-0 rounded-none border-y-0 border-r-0 p-0">
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
              <h2 className="sticky top-0 z-10 border-b border-border bg-popover px-3 py-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Current project · {projectNames[activeProjectId] ?? "Unknown project"}</h2>
              {currentJobs.length ? rows(currentJobs) : <p className="border-b border-border px-3 py-3 text-[10px] text-muted-foreground">No jobs for the current project.</p>}
            </section>}
            <section aria-label="Other projects jobs">
              <h2 className="sticky top-0 z-10 border-b border-border bg-popover px-3 py-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Other projects</h2>
              {otherJobs.length ? rows(otherJobs) : <p className="px-3 py-3 text-[10px] text-muted-foreground">No jobs from other projects.</p>}
            </section>
          </> : (
            <div className="grid min-h-56 place-items-center p-6 text-center">
              <div>
                <CheckCircle2 className="mx-auto size-6 text-primary/70" aria-hidden="true" />
                <p className="mt-2 text-[12px] font-medium text-foreground">No jobs yet</p>
                <p className="mt-1 text-[10px] text-muted-foreground">Local activity will appear here.</p>
              </div>
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
