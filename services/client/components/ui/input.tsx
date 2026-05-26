import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

interface InputProps extends React.ComponentProps<"input"> {
  leading?: React.ReactNode
  trailing?: React.ReactNode
}

function Input({
  className,
  type,
  leading,
  trailing,
  ...props
}: InputProps) {
  // If neither leading nor trailing is present, render bare primitive
  if (!leading && !trailing) {
    return (
      <InputPrimitive
        type={type}
        data-slot="input"
        className={cn(
          "h-8 w-full min-w-0 rounded-md border border-line bg-subtle px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-mute focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-subtle/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm",
          className
        )}
        {...props}
      />
    )
  }

  // Wrapper div when slots are present
  const hasLeading = !!leading
  const hasTrailing = !!trailing
  const trailingIsString = typeof trailing === "string"

  return (
    <div className="relative flex items-center">
      {hasLeading && (
        <div className="absolute left-2.5 flex items-center text-mute pointer-events-none">
          <span className="inline-flex size-4">{leading}</span>
        </div>
      )}
      <InputPrimitive
        type={type}
        data-slot="input"
        className={cn(
          "h-8 w-full min-w-0 rounded-md border border-line bg-subtle py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-mute focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-subtle/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm",
          hasLeading && "pl-8",
          hasTrailing && "pr-12",
          !hasLeading && !hasTrailing && "px-2.5",
          className
        )}
        {...props}
      />
      {hasTrailing && (
        <div
          className={cn(
            "absolute right-2.5 flex items-center text-mute pointer-events-none",
            trailingIsString && "text-xs font-mono tabular-nums"
          )}
        >
          {trailing}
        </div>
      )}
    </div>
  )
}

export { Input }
