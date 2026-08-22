import { DatabaseZap, Table2, TerminalSquare, WifiOff, X } from "lucide-react";
import type { AppTab } from "@/stores/app-store";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface TabsBarProps {
  tabs: readonly AppTab[];
  activeTabId?: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

export function TabsBar({ tabs, activeTabId, onSelect, onClose }: TabsBarProps) {
  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (event.key === "Delete") {
      event.preventDefault();
      onClose(tabs[index].id);
      return;
    }
    if (nextIndex === undefined) return;
    event.preventDefault();
    onSelect(tabs[nextIndex].id);
    const buttons = event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[nextIndex]?.focus();
  }

  return (
    <TooltipProvider delayDuration={450}>
      <div role="tablist" aria-label="Open sources" className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-border bg-muted">
        {tabs.length === 0 && <span className="flex items-center px-3 text-[10px] text-muted-foreground">No open tables</span>}
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          const Icon = tab.kind === "placeholder" ? WifiOff : tab.kind === "external" ? DatabaseZap : tab.isResult ? TerminalSquare : Table2;
          return (
            <div
              key={tab.id}
              className={cn(
                "group relative flex min-w-28 max-w-52 shrink-0 items-center border-r border-border",
                active ? "bg-background text-foreground" : "bg-card/50 text-muted-foreground hover:bg-card hover:text-foreground",
              )}
            >
              {active && <span className="absolute inset-x-0 top-0 h-px bg-primary" aria-hidden="true" />}
              <button
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onSelect(tab.id)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 py-0 pl-2.5 pr-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <Icon className={cn("size-3 shrink-0", active && "text-primary")} aria-hidden="true" />
                <span className="truncate text-left" title={tab.title}>{tab.title}</span>
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="mr-1 size-5 opacity-50 group-hover:opacity-100 group-focus-within:opacity-100"
                    onClick={() => onClose(tab.id)}
                    aria-label={`Close ${tab.title}`}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Close tab</TooltipContent>
              </Tooltip>
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
