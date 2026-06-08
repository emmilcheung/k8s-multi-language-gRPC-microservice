import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-sm border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      tone: {
        neutral: "bg-subtle text-ink",
        accent: "bg-accent-soft text-accent",
        ok: "bg-ok-soft text-ok",
        warn: "bg-warn-soft text-warn",
        bad: "bg-bad-soft text-bad",
        ink: "bg-ink text-white",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

// Dot color mapping for each tone
const dotColorMap: Record<string, string> = {
  neutral: "bg-mute",
  accent: "bg-accent",
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  ink: "bg-accent",
}

function Badge(
  componentProps: useRender.ComponentProps<"span"> &
    VariantProps<typeof badgeVariants> & {
      tone?: "neutral" | "accent" | "ok" | "warn" | "bad" | "ink"
      dot?: boolean
    }
) {
  const {
    className,
    children,
    variant = "default",
    tone,
    dot = false,
    render,
    ...props
  } = componentProps

  const dotColor = tone ? dotColorMap[tone] : ""
  const toneClasses = tone ? badgeVariants({ tone }) : ""
  const variantClasses = !tone ? badgeVariants({ variant }) : ""

  const content = (
    <>
      {dot && (
        <span className={cn("inline-block size-1.5 rounded-full", dotColor)} />
      )}
      {children}
    </>
  )

  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(variantClasses, toneClasses, className),
        children: content,
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
      tone,
    },
  })
}

export { Badge, badgeVariants }
