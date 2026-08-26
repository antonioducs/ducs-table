import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface SidebarToggleProps {
  open: boolean;
  onToggle: () => void;
}

export function SidebarToggle({ open, onToggle }: SidebarToggleProps) {
  const label = open ? "Hide sidebar" : "Show sidebar";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(
            "absolute top-2 z-30 size-6 rounded-full border border-border/80 bg-card/95 text-muted-foreground shadow-md backdrop-blur-sm transition-[left,transform,color,background-color] hover:bg-accent hover:text-foreground",
            open ? "left-1/2 -translate-x-1/2" : "left-2 translate-x-0",
          )}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onToggle}
          aria-label={label}
          aria-pressed={open}
        >
          {open ? <ChevronLeft aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={open ? "left" : "right"}>{label}</TooltipContent>
    </Tooltip>
  );
}
