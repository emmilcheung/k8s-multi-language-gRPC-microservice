import Link from "next/link";
import { LayoutDashboard, Building2 } from "lucide-react";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";

export default function OrganizerLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
      <div className="flex flex-col gap-4 border-b border-line pb-5">
        <div className="flex items-center gap-2">
          <span className="inline-block h-px w-6 bg-accent" />
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            Organizer console
          </span>
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-ink">Organizer tools</h1>
            <p className="text-sm text-mute">
              Live attendance, scanner tools, and event operations for your shows.
            </p>
          </div>
          <nav className="flex flex-wrap gap-2">
            <Link href="/organizer" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}>
              <LayoutDashboard className="size-3.5" />
              Overview
            </Link>
            <Link href="/venues" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5")}>
              <Building2 className="size-3.5" />
              Venues
            </Link>
          </nav>
        </div>
      </div>
      {children}
    </div>
  );
}
