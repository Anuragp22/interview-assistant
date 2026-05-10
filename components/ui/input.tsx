import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // Linear-style input: surface-2 background, hairline border, accent
          // border on focus (no offset ring inside an input — looks cleaner)
          "flex h-10 w-full rounded-md border border-border-default bg-surface-2 px-3.5 py-2 text-sm text-fg-strong",
          "transition-colors duration-150",
          "placeholder:text-fg-subtle",
          "focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-fg-strong",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
