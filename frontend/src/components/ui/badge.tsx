import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[10px] font-semibold tracking-[0.02em] transition-colors duration-150 ease-soft",
  {
    variants: {
      variant: {
        default: "border-primary/30 bg-primary/12 text-brand-300 shadow-[inset_0_1px_0_rgba(215,255,235,.06),0_0_14px_-6px_rgba(52,224,127,.7)]",
        muted: "border-border bg-muted text-muted-foreground",
        outline: "border-border/80 bg-transparent text-muted-foreground",
        info: "border-info/30 bg-info/10 text-info",
        warning: "border-warning/30 bg-warning/10 text-warning",
        destructive: "border-destructive/30 bg-destructive/12 text-destructive",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({ className, variant, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
