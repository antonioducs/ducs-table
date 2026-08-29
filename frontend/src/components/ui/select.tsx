import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "group flex h-8 w-full items-center justify-between gap-1.5 rounded-md border border-input bg-card/80 px-2.5 text-[11px] outline-none",
        "transition-[border-color,box-shadow,background-color] duration-150 ease-soft",
        "hover:border-input/90 hover:bg-card focus:border-primary/60 focus:shadow-[0_0_0_3px_rgba(52,224,127,.14)]",
        "data-[state=open]:border-primary/60 data-[state=open]:shadow-[0_0_0_3px_rgba(52,224,127,.14)]",
        "disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="shrink-0">
        <ChevronDown className="size-3.5 text-muted-foreground transition-transform duration-200 ease-soft group-data-[state=open]:rotate-180" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={5}
        className={cn(
          "ducs-glass-popover z-50 min-w-[var(--radix-select-trigger-width)] origin-[var(--radix-select-content-transform-origin)] overflow-hidden rounded-lg border border-white/10 bg-popover p-1 text-popover-foreground",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:duration-150 data-[state=open]:ease-soft",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:duration-100",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex h-7 cursor-default select-none items-center rounded-md pl-7 pr-2 text-[11px] outline-none",
        "transition-colors duration-150 ease-soft focus:bg-accent focus:text-foreground data-[state=checked]:text-brand-200",
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 grid place-items-center">
        <SelectPrimitive.ItemIndicator><Check className="size-3 text-primary" /></SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
