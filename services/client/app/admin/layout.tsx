import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@/components/ui/button-variants";
import { readRolesFromToken } from "@/lib/server-utils";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session-cookies";
import { cn } from "@/lib/utils";

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Hiding the area is a convenience; every admin action is checked by the services.
  const token = (await cookies()).get(ACCESS_TOKEN_COOKIE)?.value;
  if (!readRolesFromToken(token).includes("platform_admin")) {
    notFound();
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
      <div className="flex flex-col gap-3 border-b border-line pb-5">
        <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-ink">Platform admin</h1>
        <nav className="flex flex-wrap gap-2">
          {[
            ["/admin/claims", "Venue claims"],
            ["/admin/accounts", "Organizer accounts"],
            ["/admin/staff", "Staff roles"],
          ].map(([href, label]) => (
            <Link key={href} href={href} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              {label}
            </Link>
          ))}
        </nav>
      </div>
      {children}
    </div>
  );
}
