import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      // Background + gradient-sweep animation come from the [data-slot="skeleton"]
      // rules in globals.css (staggered per sibling — no synced pulse).
      className={cn("rounded-md", className)}
      {...props}
    />
  )
}

export { Skeleton }
