"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { executeMutation, executeQuery } from "@/lib/graphql/execute";
import { authSessionHeaders } from "@/lib/server-utils";
import {
  SettingsPageDocument,
  UpdateProfileDocument,
  UpdatePreferencesDocument,
  UpdateBillingAddressDocument,
  RevokeSessionDocument,
  SetDefaultPaymentMethodDocument,
  DeletePaymentMethodDocument,
  RegisterPaymentMethodDocument,
  type BillingAddressInput,
} from "@/lib/graphql/generated";
import { coerceOrderStatus } from "@/lib/order-status";
import type {
  BillingAddress,
  Preferences,
  Profile,
  SavedPaymentMethod,
  SessionInfo,
} from "@/lib/types";

/** Narrow order summary for settings page: only the fields actually used/fetched */
export interface OrderSummary {
  id: string;
  status: "created" | "awaiting_payment" | "cancelled" | "complete";
  createdAt: string;
}

export interface SettingsData {
  profile: Profile | null;
  preferences: Preferences | null;
  billingAddress: BillingAddress | null;
  sessions: SessionInfo[];
  paymentMethods: SavedPaymentMethod[];
  orders: OrderSummary[];
}

export interface PaymentMethodActionResult {
  error?: string;
  paymentMethod?: SavedPaymentMethod;
  deletedMethodId?: string;
}

function asString(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>;
}

function mapSavedPaymentMethod(method: {
  id: string;
  brand?: string | null;
  label?: string | null;
  last4?: string | null;
  expMonth?: number | null;
  expYear?: number | null;
  isDefault?: boolean | null;
}): SavedPaymentMethod {
  return {
    id: method.id,
    brand: method.brand ?? undefined,
    label: method.label ?? undefined,
    last4: method.last4 ?? undefined,
    expMonth: method.expMonth ?? undefined,
    expYear: method.expYear ?? undefined,
    isDefault: method.isDefault ?? undefined,
  };
}

export async function getSettingsData(): Promise<SettingsData> {
  const sessionHeaders = await authSessionHeaders();
  const cookieHeader = sessionHeaders["Cookie"];
  const data = await executeQuery(SettingsPageDocument, {}, { cookie: cookieHeader });
  const user = data.currentUser;
  const sessions = data.sessions;
  const orders = data.orders;

  return {
    profile: user?.profile ? {
      displayName: user.profile.displayName ?? undefined,
      locale: user.profile.locale ?? undefined,
      timezone: user.profile.timezone ?? undefined,
    } : null,
    preferences: user?.preferences ? {
      marketingOptIn: user.preferences.marketingOptIn ?? undefined,
      orderUpdates: user.preferences.orderUpdates ?? undefined,
      productUpdates: user.preferences.productUpdates ?? undefined,
    } : null,
    billingAddress: user?.billingAddress ? {
      line1: user.billingAddress.line1 ?? undefined,
      line2: user.billingAddress.line2 ?? undefined,
      city: user.billingAddress.city ?? undefined,
      state: user.billingAddress.state ?? undefined,
      postalCode: user.billingAddress.postalCode ?? undefined,
      country: user.billingAddress.country ?? undefined,
    } : null,
    sessions: sessions.map((s) => ({
      sessionId: s.id,
      createdAt: s.createdAt,
      lastRotatedAt: s.lastUsedAt ?? undefined,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      current: s.current,
    })),
    paymentMethods: (user?.paymentMethods ?? []).map((pm) => mapSavedPaymentMethod(pm)),
    orders: (orders ?? []).map((o) => ({
      id: o.id,
      status: coerceOrderStatus(o.status),
      createdAt: o.createdAt ?? "",
    })),
  };
}

export async function updateProfileAction(formData: FormData): Promise<{ error?: string }> {
  try {
    const payload = compactObject({
      displayName: asString(formData.get("displayName")),
      locale: asString(formData.get("locale")),
      timezone: asString(formData.get("timezone")),
    });

    await executeMutation(UpdateProfileDocument, { input: payload });
    revalidatePath("/settings");
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to update profile" };
  }
}

export async function updatePreferencesAction(
  formData: FormData
): Promise<{ error?: string }> {
  try {
    const payload = compactObject({
      marketingOptIn: formData.get("marketingOptIn") === "on",
      orderUpdates: formData.get("orderUpdates") === "on",
      productUpdates: formData.get("productUpdates") === "on",
    });

    await executeMutation(UpdatePreferencesDocument, { input: payload });
    revalidatePath("/settings");
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to update preferences" };
  }
}

export async function updateBillingAddressAction(
  formData: FormData
): Promise<{ error?: string }> {
  try {
    const line1 = asString(formData.get("line1"));
    const city = asString(formData.get("city"));
    const postalCode = asString(formData.get("postalCode"));
    const country = asString(formData.get("country"));

    if (!line1 || !city || !postalCode || !country) {
      return { error: "Address line 1, city, postal code, and country are required" };
    }

    const payload: BillingAddressInput = {
      line1,
      line2: asString(formData.get("line2")) ?? undefined,
      city,
      state: asString(formData.get("state")) ?? undefined,
      postalCode,
      country,
    };

    await executeMutation(UpdateBillingAddressDocument, { input: payload });
    revalidatePath("/settings");
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to update billing address" };
  }
}

export async function revokeSessionAction(formData: FormData): Promise<{ error?: string }> {
  try {
    const sessionId = asString(formData.get("sessionId"));
    if (!sessionId) return { error: "Session ID is required" };

    await executeMutation(RevokeSessionDocument, { id: sessionId });
    revalidatePath("/settings");
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to revoke session" };
  }
}

export async function setDefaultPaymentMethodAction(
  formData: FormData
): Promise<PaymentMethodActionResult> {
  try {
    const methodId = asString(formData.get("methodId"));
    if (!methodId) return { error: "Payment method ID is required" };

    const result = await executeMutation(SetDefaultPaymentMethodDocument, { id: methodId });
    return { paymentMethod: mapSavedPaymentMethod(result.setDefaultPaymentMethod) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to set default payment method" };
  }
}

export async function deletePaymentMethodAction(formData: FormData): Promise<PaymentMethodActionResult> {
  try {
    const methodId = asString(formData.get("methodId"));
    if (!methodId) return { error: "Payment method ID is required" };

    await executeMutation(DeletePaymentMethodDocument, { id: methodId });
    return { deletedMethodId: methodId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to delete payment method" };
  }
}

export async function registerPaymentMethodAction(input: {
  providerPaymentMethodId: string;
  setAsDefault: boolean;
  consentAccepted: boolean;
  consentVersion: string;
}): Promise<PaymentMethodActionResult> {
  try {
    if (!input.providerPaymentMethodId.trim()) {
      return { error: "Provider payment method ID is required" };
    }

    if (input.consentAccepted !== true) {
      return { error: "Please consent to saving your payment method for future use." };
    }

    if (!input.consentVersion.trim()) {
      return { error: "Consent version is required" };
    }

    const result = await executeMutation(RegisterPaymentMethodDocument, { input });
    return { paymentMethod: mapSavedPaymentMethod(result.registerPaymentMethod) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to register payment method" };
  }
}

export async function registerPaymentMethodFormAction(
  _prev: PaymentMethodActionResult,
  formData: FormData
): Promise<PaymentMethodActionResult> {
  const result = await registerPaymentMethodAction({
    providerPaymentMethodId: asString(formData.get("providerPaymentMethodId")) ?? "",
    setAsDefault: formData.get("setAsDefault") === "true",
    consentAccepted: formData.get("consentAccepted") === "true",
    consentVersion: asString(formData.get("consentVersion")) ?? "",
  });

  if (result.error) {
    return result;
  }

  revalidatePath("/settings");
  redirect("/settings?paymentMethodSaved=1");
}
