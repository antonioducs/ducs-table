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
            "absolute top-2.5 z-30 size-6 rounded-full border border-border/80 bg-[rgb(12_17_15_/_96%)] text-muted-foreground shadow-[0_4px_14px_-4px_rgba(0,0,0,.9)] backdrop-blur-sm",
            "transition-[left,transform,color,background-color,border-color,box-shadow] duration-200 ease-soft",
            "hover:border-primary/40 hover:bg-accent hover:text-primary hover:shadow-[0_0_16px_-4px_rgba(52,224,127,.65)]",
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
