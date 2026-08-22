import { Check, ChevronsUpDown, FolderKanban, FolderPlus, Loader2, Settings2 } from "lucide-react";
import type { Project } from "@/types";
import { Button } from "@/components/ui/button";
import { recentProjects } from "@/lib/projects";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ProjectSelectorProps {
  projects: readonly Project[];
  activeProjectId?: string;
  switchingProjectId?: string;
  onSelect: (projectId: string) => void;
  onNew: () => void;
  onManage: () => void;
}

export function ProjectSelector({ projects, activeProjectId, switchingProjectId, onSelect, onNew, onManage }: ProjectSelectorProps) {
  const active = projects.find((project) => project.id === activeProjectId);
  const visible = recentProjects(projects);
  const switching = Boolean(switchingProjectId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="max-w-56 gap-1.5 [--wails-draggable:no-drag]"
          aria-label={`Project: ${active?.name ?? "None selected"}`}
          disabled={switching}
        >
          {switching ? <Loader2 className="animate-spin" aria-hidden="true" /> : <FolderKanban aria-hidden="true" />}
          <span className="max-w-36 truncate">{active?.name ?? "Choose project"}</span>
          <ChevronsUpDown className="size-3 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        <DropdownMenuLabel>Recent projects</DropdownMenuLabel>
        {visible.length ? visible.map((project) => (
          <DropdownMenuItem
            key={project.id}
            onSelect={() => project.id !== activeProjectId && onSelect(project.id)}
            aria-current={project.id === activeProjectId ? "page" : undefined}
          >
            <Check className={project.id === activeProjectId ? "text-primary" : "invisible"} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            {project.id === switchingProjectId && <Loader2 className="animate-spin" aria-hidden="true" />}
          </DropdownMenuItem>
        )) : <p className="px-2 py-2 text-[11px] text-muted-foreground">No active projects</p>}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onNew}><FolderPlus aria-hidden="true" /> New project</DropdownMenuItem>
        <DropdownMenuItem onSelect={onManage}><Settings2 aria-hidden="true" /> Manage projects</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
