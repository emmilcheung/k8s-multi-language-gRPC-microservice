"use server";

import { revalidatePath } from "next/cache";
import { authHeaders, authSessionHeaders, base } from "@/lib/server-utils";
import type {
  BillingAddress,
  Order,
  Preferences,
  Profile,
  SavedPaymentMethod,
  SessionInfo,
} from "@/lib/types";

export interface SettingsData {
  profile: Profile | null;
  preferences: Preferences | null;
  billingAddress: BillingAddress | null;
  sessions: SessionInfo[];
  paymentMethods: SavedPaymentMethod[];
  orders: Order[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

async function parseBody(res: Response): Promise<unknown> {
  return res.json().catch(() => null);
}

function toErrorMessage(path: string, status: number, body: unknown): string {
  const payload = asRecord(body);
  const err = asRecord(payload?.error);
  const upstreamMessage = typeof err?.message === "string" ? err.message : undefined;
  return upstreamMessage ?? `Request to ${path} failed with status ${status}`;
}

async function headersForPath(path: string): Promise<HeadersInit> {
  if (path.startsWith("/api/users/sessions")) {
    return authSessionHeaders();
  }
  return authHeaders();
}

function pickPayload(body: unknown, keys: string[]): unknown {
  const payload = asRecord(body);
  if (!payload) return body;

  for (const key of keys) {
    if (key in payload) return payload[key];
  }

  return body;
}

async function fetchOptionalObject<T>(
  path: string,
  keys: string[]
): Promise<T | null> {
  const res = await fetch(`${base()}${path}`, {
    cache: "no-store",
    headers: await headersForPath(path),
  }).catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : `Failed to reach upstream for ${path}`;
    throw new Error(message);
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await parseBody(res);
    throw new Error(toErrorMessage(path, res.status, body));
  }

  const body = await parseBody(res);
  const candidate = pickPayload(body, keys);
  const record = asRecord(candidate);
  return record ? (record as T) : null;
}

async function fetchOptionalArray<T>(path: string, keys: string[]): Promise<T[]> {
  const res = await fetch(`${base()}${path}`, {
    cache: "no-store",
    headers: await headersForPath(path),
  }).catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : `Failed to reach upstream for ${path}`;
    throw new Error(message);
  });

  if (res.status === 404) return [];
  if (!res.ok) {
    const body = await parseBody(res);
    throw new Error(toErrorMessage(path, res.status, body));
  }

  const body = await parseBody(res);
  const candidate = pickPayload(body, keys);
  return Array.isArray(candidate) ? (candidate as T[]) : [];
}

async function mutate(
  path: string,
  method: "PUT" | "PATCH" | "DELETE",
  body?: Record<string, unknown>
): Promise<void> {
  const headers = await headersForPath(path);
  const res = await fetch(`${base()}${path}`, {
    method,
    cache: "no-store",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : `Failed to reach upstream for ${path}`;
    throw new Error(message);
  });

  if (!res.ok) {
    const responseBody = await parseBody(res);
    throw new Error(toErrorMessage(path, res.status, responseBody));
  }

  revalidatePath("/settings");
}

export async function getSettingsData(): Promise<SettingsData> {
  const [profile, preferences, billingAddress, sessions, paymentMethods, orders] =
    await Promise.all([
      fetchOptionalObject<Profile>("/api/user-settings/profile", ["profile"]),
      fetchOptionalObject<Preferences>("/api/user-settings/preferences", ["preferences"]),
      fetchOptionalObject<BillingAddress>("/api/user-settings/billing-address", ["billing", "billingAddress"]),
      fetchOptionalArray<SessionInfo>("/api/users/sessions", ["sessions"]),
      fetchOptionalArray<SavedPaymentMethod>("/api/payments/methods", ["methods", "paymentMethods"]),
      fetchOptionalArray<Order>("/api/orders", ["orders"]),
    ]);

  return {
    profile,
    preferences,
    billingAddress,
    sessions,
    paymentMethods,
    orders,
  };
}

export async function updateProfileAction(formData: FormData): Promise<void> {
  const payload = compactObject({
    displayName: asString(formData.get("displayName")),
    locale: asString(formData.get("locale")),
    timezone: asString(formData.get("timezone")),
  });

  await mutate("/api/user-settings/profile", "PUT", payload);
}

export async function updatePreferencesAction(formData: FormData): Promise<void> {
  const payload = compactObject({
    marketingOptIn: formData.get("marketingOptIn") === "on",
    orderUpdates: formData.get("orderUpdates") === "on",
    productUpdates: formData.get("productUpdates") === "on",
  });

  await mutate("/api/user-settings/preferences", "PUT", payload);
}

export async function updateBillingAddressAction(
  formData: FormData
): Promise<void> {
  const payload = compactObject({
    line1: asString(formData.get("line1")),
    line2: asString(formData.get("line2")),
    city: asString(formData.get("city")),
    state: asString(formData.get("state")),
    postalCode: asString(formData.get("postalCode")),
    country: asString(formData.get("country")),
  });

  await mutate("/api/user-settings/billing-address", "PUT", payload);
}

export async function revokeSessionAction(formData: FormData): Promise<void> {
  const sessionId = asString(formData.get("sessionId"));
  if (!sessionId) return;

  await mutate(`/api/users/sessions/${encodeURIComponent(sessionId)}`, "DELETE");
}

export async function setDefaultPaymentMethodAction(
  formData: FormData
): Promise<void> {
  const methodId = asString(formData.get("methodId"));
  if (!methodId) return;

  await mutate(`/api/payments/methods/${encodeURIComponent(methodId)}/default`, "PATCH");
}

export async function deletePaymentMethodAction(
  formData: FormData
): Promise<void> {
  const methodId = asString(formData.get("methodId"));
  if (!methodId) return;

  await mutate(`/api/payments/methods/${encodeURIComponent(methodId)}`, "DELETE");
}