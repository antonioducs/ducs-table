import { Bot, DatabaseZap, Download, FolderOpen, ListChecks, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Project } from "@/types";
import { ProjectSelector } from "@/components/projects/ProjectSelector";

export interface TopBarProps {
  onOpen: () => void;
  onExport: () => void;
  onAddConnection?: () => void;
  onToggleJobs: () => void;
  onToggleAI?: () => void;
  aiOpen?: boolean;
  activeJobs: number;
  canExport: boolean;
  projects?: readonly Project[];
  activeProjectId?: string;
  switchingProjectId?: string;
  onSelectProject?: (projectId: string) => void;
  onNewProject?: () => void;
  onManageProjects?: () => void;
}

export function TopBar({ onOpen, onExport, onAddConnection, onToggleJobs, onToggleAI, aiOpen, activeJobs, canExport, projects = [], activeProjectId, switchingProjectId, onSelectProject, onNewProject, onManageProjects }: TopBarProps) {
  return (
    <header className="ducs-glass-bar flex h-11 shrink-0 items-center border-b border-border bg-card px-3 [--wails-draggable:drag]">
      <div className="mr-2 flex min-w-0 items-center gap-2" aria-label="Duc's Table">
        <span className="grid size-6 place-items-center rounded-md border border-white/10 bg-white/[0.045] text-primary shadow-[inset_0_1px_0_rgba(255,255,255,.06),0_8px_24px_rgba(0,0,0,.18)]">
          <Table2 className="size-3.5" aria-hidden="true" />
        </span>
        <span className="truncate text-[13px] font-semibold tracking-tight">Duc&apos;s Table</span>
      </div>
      <div className="mr-3 border-l border-border pl-2">
        <ProjectSelector
          projects={projects}
          activeProjectId={activeProjectId}
          switchingProjectId={switchingProjectId}
          onSelect={onSelectProject ?? (() => undefined)}
          onNew={onNewProject ?? (() => undefined)}
          onManage={onManageProjects ?? (() => undefined)}
        />
      </div>
      <TooltipProvider delayDuration={350}>
        <nav className="flex items-center gap-1 [--wails-draggable:no-drag]" aria-label="Application actions">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={onOpen}><FolderOpen aria-hidden="true" /> Open files</Button>
            </TooltipTrigger>
            <TooltipContent>Open CSV, TSV, JSON, JSONL, or XLSX files</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={onAddConnection}><DatabaseZap aria-hidden="true" /> Add connection</Button>
            </TooltipTrigger>
            <TooltipContent>Connect PostgreSQL or experimental MongoDB</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={onExport} disabled={!canExport}><Download aria-hidden="true" /> Export</Button>
            </TooltipTrigger>
            <TooltipContent>{canExport ? "Export the active source as CSV" : "Select a ready source to export"}</TooltipContent>
          </Tooltip>
        </nav>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" className={cn("ml-auto [--wails-draggable:no-drag]", aiOpen && "bg-primary/10 text-primary hover:text-primary")} onClick={onToggleAI} aria-pressed={aiOpen}><Bot aria-hidden="true" /> AI</Button>
          </TooltipTrigger>
          <TooltipContent>Toggle AI assistant</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={cn("[--wails-draggable:no-drag]", activeJobs > 0 && "bg-primary/10 text-primary hover:text-primary")}
              onClick={onToggleJobs}
              aria-label={activeJobs > 0 ? `Jobs, ${activeJobs} active` : "Jobs"}
            >
              <ListChecks aria-hidden="true" /> Jobs
              {activeJobs > 0 && (
                <span className="grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[9px] font-bold leading-4 text-primary-foreground">
                  {activeJobs > 99 ? "99+" : activeJobs}
                </span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>View local jobs</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </header>
  );
}
