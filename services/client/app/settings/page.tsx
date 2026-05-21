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
  setDefaultPaymentMethodAction,
  deletePaymentMethodAction,
} from "@/app/actions/settings";
import { SettingsAddPaymentMethodForm } from "@/components/settings-add-payment-method-form";
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

/** Wrapper for form action: delegates to setDefaultPaymentMethodAction and redirects on error */
async function handleSetDefaultPaymentMethod(formData: FormData): Promise<void> {
  "use server";
  const result = await setDefaultPaymentMethodAction(formData);
  if (result.error) {
    redirect(`/settings?error=${encodeURIComponent(result.error)}`);
  }
}

/** Wrapper for form action: delegates to deletePaymentMethodAction and redirects on error */
async function handleDeletePaymentMethod(formData: FormData): Promise<void> {
  "use server";
  const result = await deletePaymentMethodAction(formData);
  if (result.error) {
    redirect(`/settings?error=${encodeURIComponent(result.error)}`);
  }
}

interface SettingsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SettingsPage(props: SettingsPageProps) {
  const searchParams = await props.searchParams;
  const errorParam = searchParams.error;
  const error = typeof errorParam === "string" ? errorParam : undefined;

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
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      {error && (
        <div className="rounded border border-destructive/50 bg-destructive/5 p-3 flex items-start gap-3">
          <X className="size-4 text-destructive mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-destructive">{error}</p>
          </div>
        </div>
      )}
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-block h-px w-6 bg-primary" />
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            My Page
          </span>
        </div>
        <h1 className="font-display font-extrabold text-2xl tracking-tight">Settings</h1>
        {currentUserEmail && (
          <p className="text-sm text-muted-foreground font-medium">{currentUserEmail}</p>
        )}
        <p className="text-sm text-muted-foreground">
          Manage your profile, sessions, payments, and billing details.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserRound className="size-4 text-primary" />
              Profile
            </CardTitle>
            <CardDescription>Update personal information used for your account.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <form action={handleUpdateProfile} className="grid gap-3">
              <div className="grid gap-1.5">
                <label htmlFor="displayName" className="text-xs font-medium text-muted-foreground">
                  Display name
                </label>
                <Input
                  id="displayName"
                  name="displayName"
                  defaultValue={profile?.displayName ?? ""}
                />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="locale" className="text-xs font-medium text-muted-foreground">
                  Locale
                </label>
                <Input id="locale" name="locale" defaultValue={profile?.locale ?? ""} />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="timezone" className="text-xs font-medium text-muted-foreground">
                  Timezone
                </label>
                <Input id="timezone" name="timezone" defaultValue={profile?.timezone ?? ""} />
              </div>
              <button type="submit" className={cn(buttonVariants(), "w-fit")}>Save profile</button>
            </form>

            <form action={handleUpdatePreferences} className="grid gap-3 rounded border border-border p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Preferences
              </p>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  name="marketingOptIn"
                  defaultChecked={Boolean(preferences?.marketingOptIn)}
                  className="size-4 rounded border-border bg-background"
                />
                Receive marketing updates
              </label>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  name="orderUpdates"
                  defaultChecked={Boolean(preferences?.orderUpdates)}
                  className="size-4 rounded border-border bg-background"
                />
                Receive order status updates
              </label>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  name="productUpdates"
                  defaultChecked={Boolean(preferences?.productUpdates)}
                  className="size-4 rounded border-border bg-background"
                />
                Receive product updates
              </label>
              <button type="submit" className={cn(buttonVariants({ variant: "outline" }), "w-fit")}>
                Save preferences
              </button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="size-4 text-primary" />
              Security Sessions
            </CardTitle>
            <CardDescription>Review active sessions and revoke access you do not trust.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {sessions.length === 0 ? (
              <p className="rounded border border-dashed border-border p-4 text-sm text-muted-foreground">
                No active sessions found.
              </p>
            ) : (
              sessions.map((session) => (
                <div
                  key={session.sessionId}
                  className="flex flex-col gap-3 rounded border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold">
                        {session.userAgent?.trim() || "Unknown device"}
                      </p>
                      {session.current && <Badge className="text-xs">Current</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Last active: {formatTimestamp(session.lastRotatedAt ?? session.createdAt)}
                    </p>
                    <p className="text-xs text-muted-foreground">
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="size-4 text-primary" />
              Saved Payment Methods
            </CardTitle>
            <CardDescription>Manage your saved cards and choose a default payment method.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <SettingsAddPaymentMethodForm />

            {paymentMethods.length === 0 ? (
              <p className="rounded border border-dashed border-border p-4 text-sm text-muted-foreground">
                No saved payment methods yet.
              </p>
            ) : (
              paymentMethods.map((method) => (
                <div
                  key={method.id}
                  className="flex flex-col gap-3 rounded border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold">
                        {method.label ??
                          (method.last4
                            ? `${method.brand?.toUpperCase() ?? "Saved method"} •••• ${method.last4}`
                            : method.brand?.toUpperCase() ?? "Saved method")}
                      </p>
                      {method.isDefault && <Badge className="text-xs">Default</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {method.expMonth && method.expYear
                        ? `Expires ${String(method.expMonth).padStart(2, "0")}/${method.expYear}`
                        : "Expiry not available"}
                    </p>
                  </div>

                  <div className="flex gap-2">
                    {!method.isDefault && (
                      <form action={handleSetDefaultPaymentMethod}>
                        <input type="hidden" name="methodId" value={method.id} />
                        <button
                          type="submit"
                          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                        >
                          Set default
                        </button>
                      </form>
                    )}
                    <form action={handleDeletePaymentMethod}>
                      <input type="hidden" name="methodId" value={method.id} />
                      <button
                        type="submit"
                        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "text-destructive")}
                      >
                        Delete
                      </button>
                    </form>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPinHouse className="size-4 text-primary" />
              Billing Address
            </CardTitle>
            <CardDescription>Keep your billing details up to date for invoices and receipts.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={handleUpdateBillingAddress} className="grid gap-3">
              <div className="grid gap-1.5">
                <label htmlFor="line1" className="text-xs font-medium text-muted-foreground">
                  Address line 1
                </label>
                <Input id="line1" name="line1" defaultValue={billingAddress?.line1 ?? ""} />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="line2" className="text-xs font-medium text-muted-foreground">
                  Address line 2
                </label>
                <Input id="line2" name="line2" defaultValue={billingAddress?.line2 ?? ""} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <label htmlFor="city" className="text-xs font-medium text-muted-foreground">
                    City
                  </label>
                  <Input id="city" name="city" defaultValue={billingAddress?.city ?? ""} />
                </div>
                <div className="grid gap-1.5">
                  <label htmlFor="state" className="text-xs font-medium text-muted-foreground">
                    State / region
                  </label>
                  <Input id="state" name="state" defaultValue={billingAddress?.state ?? ""} />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <label htmlFor="postalCode" className="text-xs font-medium text-muted-foreground">
                    Postal code
                  </label>
                  <Input
                    id="postalCode"
                    name="postalCode"
                    defaultValue={billingAddress?.postalCode ?? ""}
                  />
                </div>
                <div className="grid gap-1.5">
                  <label htmlFor="country" className="text-xs font-medium text-muted-foreground">
                    Country
                  </label>
                  <Input id="country" name="country" defaultValue={billingAddress?.country ?? ""} />
                </div>
              </div>
              <button type="submit" className={cn(buttonVariants(), "w-fit")}>Save billing address</button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Order History</CardTitle>
          <CardDescription>
            Quick links and high-level order summary from your latest orders page.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="rounded border border-border p-4">
            <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Total orders</p>
            <p className="mt-1 font-display text-2xl font-extrabold">{orders.length}</p>
          </div>
          <div className="rounded border border-border p-4">
            <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Pending payment</p>
            <p className="mt-1 flex items-center gap-1 font-display text-2xl font-extrabold">
              <Clock className="size-5 text-amber-600" />
              {pendingOrders}
            </p>
          </div>
          <div className="rounded border border-border p-4">
            <p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Completed</p>
            <p className="mt-1 font-display text-2xl font-extrabold">{completedOrders}</p>
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
  );
}