import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 transition-colors whitespace-nowrap",
  {
    variants: {
      variant: {
        default:
          "border-border-default bg-surface-2 text-fg-muted",
        accent:
          "border-accent-border bg-accent-soft text-accent",
        success:
          "border-success-200/40 bg-success-200/12 text-success-100",
        warning:
          "border-amber-500/35 bg-amber-500/12 text-amber-300",
        danger:
          "border-destructive-100/40 bg-destructive-100/12 text-destructive-100",
        outline: "border-border-default text-fg-muted",
      },
      mono: {
        true: "font-mono tracking-tight",
        false: "",
      },
    },
    defaultVariants: { variant: "default", mono: false },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

const Badge = ({ className, variant, mono, ...props }: BadgeProps) => (
  <span className={cn(badgeVariants({ variant, mono }), className)} {...props} />
);

export { Badge, badgeVariants };
