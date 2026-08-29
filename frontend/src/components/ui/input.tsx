import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "h-8 w-full rounded-md border border-input bg-card/80 px-2.5 text-[12px] text-foreground shadow-[inset_0_1px_0_rgba(215,255,235,.03)] outline-none",
        "transition-[border-color,box-shadow,background-color] duration-150 ease-soft",
        "placeholder:text-muted-foreground/60",
        "hover:border-input/80 hover:bg-card",
        "focus:border-primary/60 focus:bg-card focus:shadow-[inset_0_1px_0_rgba(215,255,235,.05),0_0_0_3px_rgba(52,224,127,.14)]",
        "aria-invalid:border-destructive/70 aria-invalid:shadow-[0_0_0_3px_rgba(255,107,107,.14)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
