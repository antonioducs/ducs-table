import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// eslint-disable-next-line react-refresh/only-export-components
export const buttonVariants = cva(
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent px-3 text-[12px] font-medium outline-none transition-[color,background-color,border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,.16),0_8px_24px_rgba(79,70,229,.16)] hover:bg-primary-hover hover:shadow-[inset_0_1px_0_rgba(255,255,255,.2),0_10px_28px_rgba(79,70,229,.22)]",
        secondary: "border-border bg-secondary/90 text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,.035)] hover:border-white/15 hover:bg-accent",
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
        outline: "border-border bg-transparent text-foreground hover:border-white/20 hover:bg-accent",
        destructive: "bg-destructive text-white hover:bg-[#ff7979]",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 px-2.5 text-[11px]",
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
