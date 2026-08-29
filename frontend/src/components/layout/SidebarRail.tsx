import { DatabaseZap, FolderOpen, PanelLeftOpen, SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BrandMark } from "@/components/layout/BrandMark";

interface SidebarRailProps {
  onExpand: () => void;
  onNewQuery: () => void;
  onOpenFiles: () => void;
  onAddConnection: () => void;
}

interface RailActionProps {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  emphasized?: boolean;
}

function RailAction({ label, onClick, children, emphasized = false }: RailActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={emphasized ? "brand" : "ghost"}
          size="icon-sm"
          className="size-8 rounded-lg transition-transform duration-200 ease-spring hover:-translate-y-px hover:text-foreground motion-reduce:hover:translate-y-0"
          onClick={onClick}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export function SidebarRail({ onExpand, onNewQuery, onOpenFiles, onAddConnection }: SidebarRailProps) {
  return (
    <aside className="ducs-glass-panel flex h-full w-12 shrink-0 flex-col items-center border-r border-border bg-card py-2" aria-label="Collapsed sidebar actions">
      <span className="mb-1.5 grid size-8 place-items-center opacity-80" aria-hidden="true"><BrandMark size={16} /></span>
      <RailAction label="Show sidebar" onClick={onExpand} emphasized><PanelLeftOpen aria-hidden="true" /></RailAction>
      <div className="my-2 h-px w-6 bg-gradient-to-r from-transparent via-border to-transparent" aria-hidden="true" />
      <nav className="flex flex-col items-center gap-1" aria-label="Quick actions">
        <RailAction label="New query" onClick={onNewQuery}><SquarePen aria-hidden="true" /></RailAction>
        <RailAction label="Open files" onClick={onOpenFiles}><FolderOpen aria-hidden="true" /></RailAction>
        <RailAction label="Add connection" onClick={onAddConnection}><DatabaseZap aria-hidden="true" /></RailAction>
      </nav>
    </aside>
  );
}
