import * as React from "react";
import { cn } from "@/lib/utils";

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn("text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground", className)} {...props} />;
}
