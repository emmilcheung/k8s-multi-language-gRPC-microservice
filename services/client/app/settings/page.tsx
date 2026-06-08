export const dynamic = "force-dynamic";

import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import {
  getSettingsData,
  updateProfileAction,
  updatePreferencesAction,
  updateBillingAddressAction,
  revokeSessionAction,
} from "@/app/actions/settings";
import { SettingsPaymentMethods } from "@/components/settings-payment-methods";
import { ArrowRight, Clock, Shield, CreditCard, MapPinHouse, UserRound, X } from "lucide-react";

export const metadata = { title: "Settings — Marquee" };

function formatTimestamp(value?: string | null): string {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
}

/** Wrapper for form action: delegates to updateProfileAction and redirects on error */
async function handleUpdateProfile(formData: FormData): Promise<void> {
  "use server";
  const result = await updateProfileAction(formData);
  if (result.error) {
    redirect(`/settings?error=${encodeURIComponent(result.error)}`);
  }
}

/** Wrapper for form action: delegates to updatePreferencesAction and redirects on error */
async function handleUpdatePreferences(formData: FormData): Promise<void> {
  "use server";
  const result = await updatePreferencesAction(formData);
  if (result.error) {
    redirect(`/settings?error=${encodeURIComponent(result.error)}`);
  }
}

/** Wrapper for form action: delegates to updateBillingAddressAction and redirects on error */
async function handleUpdateBillingAddress(formData: FormData): Promise<void> {
  "use server";
  const result = await updateBillingAddressAction(formData);
  if (result.error) {
    redirect(`/settings?error=${encodeURIComponent(result.error)}`);
  }
}

/** Wrapper for form action: delegates to revokeSessionAction and redirects on error */
async function handleRevokeSession(formData: FormData): Promise<void> {
  "use server";
  const result = await revokeSessionAction(formData);
  if (result.error) {
    redirect(`/settings?error=${encodeURIComponent(result.error)}`);
  }
}

interface SettingsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const SIDEBAR_ITEMS = [
  "Profile",
  "Payment methods",
  "Notifications",
  "Refund policy",
  "Security & sessions",
  "Connected apps",
  "Sign out",
] as const;

function SidebarItem({ label, active = false }: { label: string; active?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-sm transition-colors",
        active ? "border-line bg-subtle text-ink" : "border-transparent text-mute"
      )}
    >
      {label}
    </div>
  );
}

function SectionCard({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="gap-2 border-b border-line pb-4">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="pt-5">{children}</CardContent>
    </Card>
  );
}

export default async function SettingsPage(props: SettingsPageProps) {
  const searchParams = await props.searchParams;
  const errorParam = searchParams.error;
  const error = typeof errorParam === "string" ? errorParam : undefined;
  const paymentMethodSaved = searchParams.paymentMethodSaved === "1";

  const cookieStore = await cookies();
  const token = cookieStore.get("token")?.value;
  if (!token) {
    redirect("/auth/signin");
  }

  let currentUserEmail: string | null = null;
  try {
    const payloadB64 = token.split(".")[1];
    if (payloadB64) {
      const json = Buffer.from(payloadB64, "base64url").toString("utf-8");
      const payload = JSON.parse(json) as { email?: string };
      currentUserEmail = payload.email ?? null;
    }
  } catch { /* non-fatal */ }

  const { profile, preferences, billingAddress, sessions, paymentMethods, orders } =
    await getSettingsData();

  const pendingOrders = orders.filter(
    (order) => order.status === "created" || order.status === "awaiting_payment"
  ).length;
  const completedOrders = orders.filter((order) => order.status === "complete").length;
  const latestOrder = orders[0];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8">
      {error && (
        <div className="rounded border border-destructive/50 bg-destructive/5 p-3 flex items-start gap-3">
          <X className="size-4 text-destructive mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-destructive">{error}</p>
          </div>
        </div>
      )}
      {paymentMethodSaved && (
        <div className="rounded border border-emerald-500/40 bg-emerald-500/5 p-3">
          <p className="text-sm font-medium text-emerald-600">Payment method saved successfully.</p>
        </div>
      )}
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="inline-block h-px w-6 bg-accent" />
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            Settings
          </span>
        </div>
        <h1 className="text-[30px] font-semibold tracking-[-0.03em] text-ink">Settings</h1>
        {currentUserEmail && (
          <p className="text-sm text-mute font-medium">{currentUserEmail}</p>
        )}
        <p className="text-sm text-mute">
          Manage your profile, sessions, payments, and billing details.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="space-y-1">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">
            Settings
          </p>
          {SIDEBAR_ITEMS.map((item) => (
            <SidebarItem key={item} label={item} active={item === "Payment methods"} />
          ))}
        </aside>

        <div className="space-y-5">
          <Card>
            <CardContent className="flex flex-col gap-4 pt-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-4">
                <div className="flex size-14 items-center justify-center rounded-full bg-[linear-gradient(135deg,oklch(0.62_0.19_270),oklch(0.73_0.16_330))] text-lg font-semibold text-white">
                  {profile?.displayName?.slice(0, 2).toUpperCase() || "JS"}
                </div>
                <div className="space-y-1">
                  <p className="text-lg font-semibold text-ink">{profile?.displayName || "Jamie Stone"}</p>
                  <p className="text-sm text-mute">
                    {currentUserEmail || "jamie@example.com"} · joined recently
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="ok" dot>
                      Verified
                    </Badge>
                    <Badge tone="neutral">Stagepass+</Badge>
                  </div>
                </div>
              </div>
              <button type="button" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Edit profile
              </button>
            </CardContent>
          </Card>

          <SectionCard
            title="Profile"
            description="Update personal information used for your account."
            icon={<UserRound className="size-4 text-accent" />}
          >
            <form action={handleUpdateProfile} className="grid gap-3">
              <div className="grid gap-1.5">
                <label htmlFor="displayName" className="text-xs font-medium text-mute">
                  Display name
                </label>
                <Input
                  id="displayName"
                  name="displayName"
                  defaultValue={profile?.displayName ?? ""}
                />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="locale" className="text-xs font-medium text-mute">
                  Locale
                </label>
                <Input id="locale" name="locale" defaultValue={profile?.locale ?? ""} />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="timezone" className="text-xs font-medium text-mute">
                  Timezone
                </label>
                <Input id="timezone" name="timezone" defaultValue={profile?.timezone ?? ""} />
              </div>
              <button type="submit" className={cn(buttonVariants(), "w-fit")}>Save profile</button>
            </form>
          </SectionCard>

          <SectionCard
            title="Payment methods"
            description="Used for ticket purchases and quick checkout."
            icon={<CreditCard className="size-4 text-accent" />}
          >
            <SettingsPaymentMethods initialPaymentMethods={paymentMethods} />
          </SectionCard>

          <SectionCard
            title="Notifications"
            description="Only supported preferences are shown until the reminder schema lands."
          >
            <form action={handleUpdatePreferences} className="grid gap-3">
              <label className="flex items-center justify-between gap-4 rounded-xl border border-line px-4 py-3 text-sm">
                <span className="flex flex-col gap-1">
                  <span className="font-medium text-ink">Order updates</span>
                  <span className="text-xs text-mute">Receipts and order-state changes.</span>
                </span>
                <input
                  type="checkbox"
                  name="orderUpdates"
                  defaultChecked={Boolean(preferences?.orderUpdates)}
                  className="size-4 rounded border-line bg-subtle"
                />
              </label>
              <label className="flex items-center justify-between gap-4 rounded-xl border border-line px-4 py-3 text-sm">
                <span className="flex flex-col gap-1">
                  <span className="font-medium text-ink">Product updates</span>
                  <span className="text-xs text-mute">New platform capabilities and ticketing improvements.</span>
                </span>
                <input
                  type="checkbox"
                  name="productUpdates"
                  defaultChecked={Boolean(preferences?.productUpdates)}
                  className="size-4 rounded border-line bg-subtle"
                />
              </label>
              <label className="flex items-center justify-between gap-4 rounded-xl border border-line px-4 py-3 text-sm">
                <span className="flex flex-col gap-1">
                  <span className="font-medium text-ink">Marketing emails</span>
                  <span className="text-xs text-mute">Tour announcements, offers, and curated picks.</span>
                </span>
                <input
                  type="checkbox"
                  name="marketingOptIn"
                  defaultChecked={Boolean(preferences?.marketingOptIn)}
                  className="size-4 rounded border-line bg-subtle"
                />
              </label>
              <button type="submit" className={cn(buttonVariants({ variant: "outline" }), "w-fit")}>
                Save preferences
              </button>
            </form>
          </SectionCard>

          <SectionCard
            title="Security & sessions"
            description="Review active sessions and revoke access you do not trust."
            icon={<Shield className="size-4 text-accent" />}
          >
            <div className="space-y-3">
            {sessions.length === 0 ? (
              <p className="rounded border border-dashed border-line p-4 text-sm text-mute">
                No active sessions found.
              </p>
            ) : (
              sessions.map((session) => (
                <div
                  key={session.sessionId}
                  className="flex flex-col gap-3 rounded border border-line p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold">
                        {session.userAgent?.trim() || "Unknown device"}
                      </p>
                      {session.current && <Badge className="text-xs">Current</Badge>}
                    </div>
                    <p className="text-xs text-mute">
                      Last active: {formatTimestamp(session.lastRotatedAt ?? session.createdAt)}
                    </p>
                    <p className="text-xs text-mute">
                      IP: {session.ipAddress?.trim() || "Unknown"}
                    </p>
                  </div>

                  {!session.current && (
                    <form action={handleRevokeSession}>
                      <input type="hidden" name="sessionId" value={session.sessionId} />
                      <button
                        type="submit"
                        className={cn(buttonVariants({ variant: "destructive", size: "sm" }))}
                      >
                        Revoke
                      </button>
                    </form>
                  )}
                </div>
              ))
            )}
            </div>
          </SectionCard>

          <SectionCard
            title="Billing address"
            description="Keep your billing details up to date for invoices and receipts."
            icon={<MapPinHouse className="size-4 text-accent" />}
          >
            <form action={handleUpdateBillingAddress} className="grid gap-3">
              <div className="grid gap-1.5">
                <label htmlFor="line1" className="text-xs font-medium text-mute">
                  Address line 1
                </label>
                <Input id="line1" name="line1" defaultValue={billingAddress?.line1 ?? ""} />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="line2" className="text-xs font-medium text-mute">
                  Address line 2
                </label>
                <Input id="line2" name="line2" defaultValue={billingAddress?.line2 ?? ""} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <label htmlFor="city" className="text-xs font-medium text-mute">
                    City
                  </label>
                  <Input id="city" name="city" defaultValue={billingAddress?.city ?? ""} />
                </div>
                <div className="grid gap-1.5">
                  <label htmlFor="state" className="text-xs font-medium text-mute">
                    State / region
                  </label>
                  <Input id="state" name="state" defaultValue={billingAddress?.state ?? ""} />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <label htmlFor="postalCode" className="text-xs font-medium text-mute">
                    Postal code
                  </label>
                  <Input
                    id="postalCode"
                    name="postalCode"
                    defaultValue={billingAddress?.postalCode ?? ""}
                  />
                </div>
                <div className="grid gap-1.5">
                  <label htmlFor="country" className="text-xs font-medium text-mute">
                    Country
                  </label>
                  <Input id="country" name="country" defaultValue={billingAddress?.country ?? ""} />
                </div>
              </div>
              <button type="submit" className={cn(buttonVariants(), "w-fit")}>Save billing address</button>
            </form>
          </SectionCard>

          <Card>
            <CardHeader>
              <CardTitle>Order snapshot</CardTitle>
              <CardDescription>Quick links and a high-level view of recent orders.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-xl border border-line bg-subtle px-4 py-4">
                <p className="text-xs uppercase tracking-[0.14em] text-mute">Total orders</p>
                <p className="mt-1 text-2xl font-semibold text-ink">{orders.length}</p>
              </div>
              <div className="rounded-xl border border-line bg-subtle px-4 py-4">
                <p className="text-xs uppercase tracking-[0.14em] text-mute">Pending payment</p>
                <p className="mt-1 flex items-center gap-1 text-2xl font-semibold text-ink">
                  <Clock className="size-5 text-warn" />
                  {pendingOrders}
                </p>
              </div>
              <div className="rounded-xl border border-line bg-subtle px-4 py-4">
                <p className="text-xs uppercase tracking-[0.14em] text-mute">Completed</p>
                <p className="mt-1 text-2xl font-semibold text-ink">{completedOrders}</p>
              </div>

              <div className="sm:col-span-3 flex flex-wrap gap-2">
                <Link href="/orders" className={cn(buttonVariants(), "gap-2")}>View all orders</Link>
                {latestOrder && (
                  <Link
                    href={`/orders/${latestOrder.id}`}
                    className={cn(buttonVariants({ variant: "outline" }), "gap-2")}
                  >
                    Latest order
                    <ArrowRight className="size-4" />
                  </Link>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}