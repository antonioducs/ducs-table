import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// eslint-disable-next-line react-refresh/only-export-components
export const buttonVariants = cva(
  [
    "relative inline-flex h-8 shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-md border border-transparent px-3",
    "text-[12px] font-medium tracking-[-0.005em] outline-none",
    "transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-150 ease-soft",
    "active:scale-[0.975] motion-reduce:active:scale-100",
    "focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-40 disabled:saturate-50",
    "[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:transition-transform [&_svg]:duration-200",
  ].join(" "),
  {
    variants: {
      variant: {
        default: [
          "ducs-sheen bg-gradient-to-b from-brand-300 to-brand-400 text-primary-foreground",
          "shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_8px_22px_-8px_rgba(52,224,127,.55)]",
          "hover:from-brand-200 hover:to-brand-300 hover:shadow-[inset_0_1px_0_rgba(255,255,255,.45),0_12px_30px_-8px_rgba(52,224,127,.7)]",
        ].join(" "),
        secondary: [
          "border-border bg-secondary/90 text-foreground shadow-[inset_0_1px_0_rgba(215,255,235,.05)]",
          "hover:border-primary/25 hover:bg-accent hover:text-foreground hover:shadow-[inset_0_1px_0_rgba(215,255,235,.08),0_6px_18px_-10px_rgba(52,224,127,.35)]",
        ].join(" "),
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
        outline: [
          "border-border bg-transparent text-foreground",
          "hover:border-primary/40 hover:bg-primary/[0.07] hover:text-foreground",
        ].join(" "),
        destructive: [
          "bg-destructive/90 text-white shadow-[inset_0_1px_0_rgba(255,255,255,.2),0_8px_22px_-10px_rgba(255,107,107,.6)]",
          "hover:bg-destructive hover:shadow-[inset_0_1px_0_rgba(255,255,255,.28),0_12px_28px_-10px_rgba(255,107,107,.75)]",
        ].join(" "),
        brand: [
          "border-primary/30 bg-primary/12 text-primary",
          "shadow-[inset_0_1px_0_rgba(215,255,235,.06)]",
          "hover:border-primary/50 hover:bg-primary/20 hover:text-brand-200",
        ].join(" "),
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 px-2.5 text-[11px]",
        lg: "h-9 gap-2 px-4 text-[13px] [&_svg]:size-4",
        icon: "size-8 p-0",
        "icon-sm": "size-7 p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";
