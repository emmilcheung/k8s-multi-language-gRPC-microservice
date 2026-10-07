import Link from "next/link";
import { cookies } from "next/headers";
import { LayoutDashboard, Building2, Users } from "lucide-react";
import { AccountSwitcher } from "@/components/organizer/account-switcher";
import { buttonVariants } from "@/components/ui/button-variants";
import { executeQuery } from "@/lib/graphql/execute";
import { MyAccountsDocument } from "@/lib/graphql/generated";
import { readSelectedAccountId, resolveSelectedAccountId } from "@/lib/organizer-account";
import { canManageTeam } from "@/lib/team-roles";
import { cn } from "@/lib/utils";

async function loadAccounts(): Promise<{ id: string; name: string; role: string }[]> {
  try {
    const { myAccounts } = await executeQuery(MyAccountsDocument, {}, { cookie: (await cookies()).toString() });
    return myAccounts.map((m) => ({ id: m.account.id, name: m.account.name, role: m.role }));
  } catch {
    return [];
  }
}

export default async function OrganizerLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const accounts = await loadAccounts();
  const selectedId = resolveSelectedAccountId(
    accounts.map((a) => a.id),
    await readSelectedAccountId()
  );
  const showTeam = canManageTeam(accounts.find((a) => a.id === selectedId)?.role);

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
          <nav className="flex flex-wrap items-center gap-2">
            {selectedId && <AccountSwitcher accounts={accounts} selectedId={selectedId} />}
            <Link href="/organizer" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}>
              <LayoutDashboard className="size-3.5" />
              Overview
            </Link>
            {showTeam && (
              <Link href="/organizer/team" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5")}>
                <Users className="size-3.5" />
                Team
              </Link>
            )}
            <Link href="/venues" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5")}>
              <Building2 className="size-3.5" />
              Venues
            </Link>
            <Link href="/organizer/new-account" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "gap-1.5")}>
              New organizer account
            </Link>
          </nav>
        </div>
      </div>
      {children}
    </div>
  );
}
