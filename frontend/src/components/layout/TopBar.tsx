import { Bot, DatabaseZap, Download, FolderOpen, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Project } from "@/types";
import { ProjectSelector } from "@/components/projects/ProjectSelector";
import { BrandMark, Wordmark } from "@/components/layout/BrandMark";

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
    <header
      data-brand-edge
      className="ducs-glass-bar flex h-12 shrink-0 items-center gap-1 border-b border-border bg-card px-2.5 [--wails-draggable:drag]"
    >
      <div className="group/brand mr-1.5 flex min-w-0 items-center gap-2 pl-0.5" aria-label="Duc's Table">
        <span className="grid size-7 place-items-center rounded-[9px] border border-primary/25 bg-gradient-to-b from-primary/[0.18] to-primary/[0.04] shadow-[inset_0_1px_0_rgba(215,255,235,.1),0_6px_18px_-8px_rgba(52,224,127,.55)] transition-transform duration-300 ease-spring group-hover/brand:scale-[1.06] motion-reduce:transition-none">
          <BrandMark size={17} />
        </span>
        <Wordmark className="truncate" />
      </div>

      <span aria-hidden="true" className="mx-1 h-5 w-px bg-gradient-to-b from-transparent via-border to-transparent" />

      <div className="mr-2">
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
        {/* Primary actions grouped in a single segmented surface. */}
        <nav
          className="flex items-center gap-0.5 rounded-lg border border-border/70 bg-white/[0.02] p-0.5 [--wails-draggable:no-drag]"
          aria-label="Application actions"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="hover:[&_svg]:-translate-y-px" onClick={onOpen}><FolderOpen aria-hidden="true" /> Open files</Button>
            </TooltipTrigger>
            <TooltipContent>Open CSV, TSV, JSON, JSONL, or XLSX files</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="hover:[&_svg]:scale-110" onClick={onAddConnection}><DatabaseZap aria-hidden="true" /> Add connection</Button>
            </TooltipTrigger>
            <TooltipContent>Connect PostgreSQL or experimental MongoDB</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="hover:[&_svg]:translate-y-px" onClick={onExport} disabled={!canExport}><Download aria-hidden="true" /> Export</Button>
            </TooltipTrigger>
            <TooltipContent>{canExport ? "Export the active source as CSV" : "Select a ready source to export"}</TooltipContent>
          </Tooltip>
        </nav>

        <div className="ml-auto flex items-center gap-1 [--wails-draggable:no-drag]">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={aiOpen ? "brand" : "ghost"}
                size="sm"
                className={cn(aiOpen && "shadow-[0_0_18px_-6px_rgba(52,224,127,.55)]")}
                onClick={onToggleAI}
                aria-pressed={aiOpen}
              >
                <Bot aria-hidden="true" /> AI
              </Button>
            </TooltipTrigger>
            <TooltipContent>Toggle AI assistant</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={activeJobs > 0 ? "brand" : "ghost"}
                size="sm"
                onClick={onToggleJobs}
                aria-label={activeJobs > 0 ? `Jobs, ${activeJobs} active` : "Jobs"}
              >
                <ListChecks aria-hidden="true" /> Jobs
                {activeJobs > 0 && (
                  <span className="ducs-num grid min-w-4 animate-ducs-pop place-items-center rounded-full bg-primary px-1 text-[9px] font-bold leading-4 text-primary-foreground shadow-[0_0_12px_-2px_rgba(52,224,127,.9)]">
                    {activeJobs > 99 ? "99+" : activeJobs}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>View local jobs</TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </header>
  );
}
