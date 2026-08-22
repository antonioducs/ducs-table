import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return <SwitchPrimitive.Root className={cn("inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border bg-muted px-0.5 transition-colors data-[state=checked]:border-primary/50 data-[state=checked]:bg-primary/30 disabled:cursor-not-allowed disabled:opacity-50", className)} {...props}>
    <SwitchPrimitive.Thumb className="block size-3.5 rounded-full bg-muted-foreground shadow transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-primary" />
  </SwitchPrimitive.Root>;
}
