import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePathMock = vi.fn();
const executeQueryMock = vi.fn();
const executeMutationMock = vi.fn();
const authSessionHeadersMock = vi.fn();

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

vi.mock("@/lib/graphql/execute", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
  executeMutation: (...args: unknown[]) => executeMutationMock(...args),
}));

vi.mock("@/lib/server-utils", () => ({
  authSessionHeaders: (...args: unknown[]) => authSessionHeadersMock(...args),
}));

import {
  deletePaymentMethodAction,
  getSettingsData,
  registerPaymentMethodAction,
  revokeSessionAction,
  setDefaultPaymentMethodAction,
  updateProfileAction,
  updateBillingAddressAction,
  updatePreferencesAction,
  type OrderSummary,
} from "@/app/actions/settings";
import { RegisterPaymentMethodDocument } from "@/lib/graphql/generated";

describe("settings server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: authSessionHeaders returns both cookies (sufficient for most tests)
    authSessionHeadersMock.mockResolvedValue({
      "Content-Type": "application/json",
      Cookie: "token=mock-access; refreshToken=mock-refresh",
    });
  });

  it("passes session-aware cookie (access + refresh) to executeQuery for getSettingsData", async () => {
    authSessionHeadersMock.mockResolvedValueOnce({
      "Content-Type": "application/json",
      Cookie: "token=access-abc; refreshToken=refresh-xyz",
    });
    executeQueryMock.mockResolvedValueOnce({
      currentUser: { id: "u1", profile: null, preferences: null, billingAddress: null, paymentMethods: [] },
      sessions: [],
      orders: [],
    });

    await getSettingsData();

    expect(authSessionHeadersMock).toHaveBeenCalledOnce();
    expect(executeQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      {},
      { cookie: "token=access-abc; refreshToken=refresh-xyz" },
    );
  });

  it("passes undefined cookie to executeQuery when authSessionHeaders returns no Cookie", async () => {
    authSessionHeadersMock.mockResolvedValueOnce({
      "Content-Type": "application/json",
      // No Cookie key — unauthenticated / cookie-less context
    });
    executeQueryMock.mockResolvedValueOnce({
      currentUser: null,
      sessions: [],
      orders: [],
    });

    await getSettingsData();

    expect(executeQueryMock).toHaveBeenCalledWith(
      expect.anything(),
      {},
      { cookie: undefined },
    );
  });

  it("maps lastUsedAt null to lastRotatedAt undefined (no empty-string sentinel)", async () => {
    executeQueryMock.mockResolvedValueOnce({
      currentUser: { profile: null, preferences: null, billingAddress: null, paymentMethods: [] },
      sessions: [
        { id: "s1", createdAt: "2025-01-01T00:00:00Z", lastUsedAt: null, userAgent: null, ipAddress: null, current: false },
      ],
      orders: [],
    });

    const data = await getSettingsData();

    expect(data.sessions[0].lastRotatedAt).toBeUndefined();
  });

  it("maps lastUsedAt value to lastRotatedAt string", async () => {
    executeQueryMock.mockResolvedValueOnce({
      currentUser: { profile: null, preferences: null, billingAddress: null, paymentMethods: [] },
      sessions: [
        { id: "s1", createdAt: "2025-01-01T00:00:00Z", lastUsedAt: "2025-06-01T00:00:00Z", userAgent: null, ipAddress: null, current: false },
      ],
      orders: [],
    });

    const data = await getSettingsData();

    expect(data.sessions[0].lastRotatedAt).toBe("2025-06-01T00:00:00Z");
  });

  it("fetches settings data via GraphQL query with narrow order summary", async () => {
    executeQueryMock.mockResolvedValueOnce({
      currentUser: {
        id: "user-123",
        profile: { displayName: "Taylor", locale: "en-US", timezone: "UTC" },
        preferences: { marketingOptIn: true, orderUpdates: true, productUpdates: false },
        billingAddress: { line1: "123 Main St", city: "San Francisco", country: "US", state: "CA", postalCode: "94105", line2: null },
        paymentMethods: [
          { id: "pm-1", brand: "visa", label: "My Visa", last4: "4242", expMonth: 12, expYear: 2026, isDefault: true },
        ],
      },
      sessions: [
        { id: "session-1", userAgent: "Chrome", ipAddress: "127.0.0.1", createdAt: "2025-01-01T00:00:00Z", lastUsedAt: "2025-01-02T00:00:00Z", current: true },
      ],
      orders: [
        { id: "order-1", status: "COMPLETE", createdAt: "2025-01-01T00:00:00Z" },
      ],
    });

    const data = await getSettingsData();

    expect(executeQueryMock).toHaveBeenCalledOnce();
    expect(data.profile?.displayName).toBe("Taylor");
    expect(data.paymentMethods).toHaveLength(1);
    expect(data.paymentMethods[0].isDefault).toBe(true);
    expect(data.sessions).toHaveLength(1);
    expect(data.orders).toHaveLength(1);
    
    // Verify narrow order shape: only id, status, createdAt
    const order = data.orders[0] as OrderSummary;
    expect(order).toEqual({
      id: "order-1",
      status: "complete",
      createdAt: "2025-01-01T00:00:00Z",
    });
    expect(Object.keys(order).sort()).toEqual(["createdAt", "id", "status"]);
  });

  it("routes revoke session through executeMutation", async () => {
    executeMutationMock.mockResolvedValueOnce(true);

    const formData = new FormData();
    formData.set("sessionId", "5f6cf0d3-114f-43bc-82f4-3e96b50e6033");

    await revokeSessionAction(formData);

    expect(executeMutationMock).toHaveBeenCalledOnce();
    expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
  });

  it("handles GraphQL mutations for profile, payment methods", async () => {
    executeMutationMock.mockResolvedValue({});

    const profileForm = new FormData();
    profileForm.set("displayName", "Taylor");

    const defaultForm = new FormData();
    defaultForm.set("methodId", "a5dcccf6-22f2-493b-80fc-3350ca0ba3ad");

    const deleteForm = new FormData();
    deleteForm.set("methodId", "a5dcccf6-22f2-493b-80fc-3350ca0ba3ad");

    await updateProfileAction(profileForm);
    await setDefaultPaymentMethodAction(defaultForm);
    await deletePaymentMethodAction(deleteForm);

    expect(executeMutationMock).toHaveBeenCalledTimes(3);
    expect(revalidatePathMock).toHaveBeenCalledTimes(3);
  });

  describe("error path tests", () => {
    it("returns error when updateProfileAction mutation rejects", async () => {
      const testError = new Error("GraphQL mutation failed");
      executeMutationMock.mockRejectedValueOnce(testError);

      const formData = new FormData();
      formData.set("displayName", "Taylor");

      const result = await updateProfileAction(formData);

      expect(result).toEqual({ error: "GraphQL mutation failed" });
      expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it("returns required fields error when updateBillingAddressAction lacks required fields", async () => {
      const formData = new FormData();
      formData.set("line2", "Optional line");
      // Missing line1, city, postalCode, country

      const result = await updateBillingAddressAction(formData);

      expect(result).toEqual({ error: "Address line 1, city, postal code, and country are required" });
      expect(executeMutationMock).not.toHaveBeenCalled();
    });

    it("returns mutation error when updateBillingAddressAction mutation rejects", async () => {
      const testError = new Error("Billing address update failed");
      executeMutationMock.mockRejectedValueOnce(testError);

      const formData = new FormData();
      formData.set("line1", "123 Main St");
      formData.set("city", "San Francisco");
      formData.set("postalCode", "94105");
      formData.set("country", "US");

      const result = await updateBillingAddressAction(formData);

      expect(result).toEqual({ error: "Billing address update failed" });
      expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it("returns fallback error when updateBillingAddressAction receives non-Error rejection", async () => {
      executeMutationMock.mockRejectedValueOnce("String error");

      const formData = new FormData();
      formData.set("line1", "123 Main St");
      formData.set("city", "San Francisco");
      formData.set("postalCode", "94105");
      formData.set("country", "US");

      const result = await updateBillingAddressAction(formData);

      expect(result).toEqual({ error: "Failed to update billing address" });
    });

    it("rejects invalid order status in getSettingsData", async () => {
      executeQueryMock.mockResolvedValueOnce({
        currentUser: {
          id: "user-123",
          profile: null,
          preferences: null,
          billingAddress: null,
          paymentMethods: [],
        },
        sessions: [],
        orders: [
          { id: "order-1", status: "INVALID_STATUS", createdAt: "2025-01-01T00:00:00Z" },
        ],
      });

      await expect(getSettingsData()).rejects.toThrow("Invalid order status: INVALID_STATUS");
    });

    it("validates order status mapping: accepts valid lowercase statuses", async () => {
      const validStatuses = ["created", "awaiting_payment", "cancelled", "complete"];
      
      for (const status of validStatuses) {
        executeQueryMock.mockResolvedValueOnce({
          currentUser: { profile: null, preferences: null, billingAddress: null, paymentMethods: [] },
          sessions: [],
          orders: [{ id: `order-${status}`, status: status.toUpperCase(), createdAt: "2025-01-01T00:00:00Z" }],
        });

        const data = await getSettingsData();
        expect(data.orders[0].status).toBe(status);
      }
    });

    it("returns error when revokeSessionAction lacks required sessionId", async () => {
      const formData = new FormData();
      // No sessionId set

      const result = await revokeSessionAction(formData);

      expect(result).toEqual({ error: "Session ID is required" });
      expect(executeMutationMock).not.toHaveBeenCalled();
      expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it("returns error when revokeSessionAction mutation rejects", async () => {
      const testError = new Error("Revoke failed");
      executeMutationMock.mockRejectedValueOnce(testError);

      const formData = new FormData();
      formData.set("sessionId", "session-123");

      const result = await revokeSessionAction(formData);

      expect(result).toEqual({ error: "Revoke failed" });
      expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it("returns error when setDefaultPaymentMethodAction lacks required methodId", async () => {
      const formData = new FormData();
      // No methodId set

      const result = await setDefaultPaymentMethodAction(formData);

      expect(result).toEqual({ error: "Payment method ID is required" });
      expect(executeMutationMock).not.toHaveBeenCalled();
    });

    it("returns error when deletePaymentMethodAction lacks required methodId", async () => {
      const formData = new FormData();
      // No methodId set

      const result = await deletePaymentMethodAction(formData);

      expect(result).toEqual({ error: "Payment method ID is required" });
      expect(executeMutationMock).not.toHaveBeenCalled();
    });

    it("returns error when updatePreferencesAction mutation rejects", async () => {
      const testError = new Error("Preferences update failed");
      executeMutationMock.mockRejectedValueOnce(testError);

      const formData = new FormData();
      formData.set("marketingOptIn", "on");

      const result = await updatePreferencesAction(formData);

      expect(result).toEqual({ error: "Preferences update failed" });
      expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it("builds billing address payload with all fields provided - no as any cast", async () => {
      executeMutationMock.mockResolvedValueOnce({});

      const formData = new FormData();
      formData.set("line1", "456 Oak Ave");
      formData.set("line2", "Suite 100");
      formData.set("city", "New York");
      formData.set("state", "NY");
      formData.set("postalCode", "10001");
      formData.set("country", "US");

      const result = await updateBillingAddressAction(formData);

      expect(result).toEqual({});
      expect(executeMutationMock).toHaveBeenCalledOnce();
      
      const callArgs = executeMutationMock.mock.calls[0];
      const payload = callArgs[1].input;
      
      expect(payload).toEqual({
        line1: "456 Oak Ave",
        line2: "Suite 100",
        city: "New York",
        state: "NY",
        postalCode: "10001",
        country: "US",
      });
      expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
    });

    it("builds billing address payload with only required fields", async () => {
      executeMutationMock.mockResolvedValueOnce({});

      const formData = new FormData();
      formData.set("line1", "789 Pine St");
      formData.set("city", "Boston");
      formData.set("postalCode", "02101");
      formData.set("country", "US");

      const result = await updateBillingAddressAction(formData);

      expect(result).toEqual({});
      expect(executeMutationMock).toHaveBeenCalledOnce();
      
      const callArgs = executeMutationMock.mock.calls[0];
      const payload = callArgs[1].input;
      
      // Optional fields should be undefined
      expect(payload).toEqual({
        line1: "789 Pine St",
        line2: undefined,
        city: "Boston",
        state: undefined,
        postalCode: "02101",
        country: "US",
      });
      expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
    });
  });

  describe("registerPaymentMethodAction", () => {
    it("calls executeMutation with RegisterPaymentMethodDocument and correct variables", async () => {
      executeMutationMock.mockResolvedValueOnce({
        registerPaymentMethod: { id: "pm-new", brand: "visa", last4: "4242", expMonth: 12, expYear: 2028, isDefault: true, label: null },
      });

      const result = await registerPaymentMethodAction({
        providerPaymentMethodId: "pm_stripe_abc123",
        setAsDefault: true,
        consentAccepted: true,
        consentVersion: "settings-card-save-v1",
      });

      expect(result).toEqual({});
      expect(executeMutationMock).toHaveBeenCalledOnce();
      const [document, variables] = executeMutationMock.mock.calls[0];
      expect(document).toBe(RegisterPaymentMethodDocument);
      expect(variables).toEqual({
        input: {
          providerPaymentMethodId: "pm_stripe_abc123",
          setAsDefault: true,
          consentAccepted: true,
          consentVersion: "settings-card-save-v1",
        },
      });
      expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
    });

    it("revalidates /settings on success", async () => {
      executeMutationMock.mockResolvedValueOnce({
        registerPaymentMethod: { id: "pm-new", brand: "visa", last4: "4242", expMonth: 12, expYear: 2028, isDefault: false, label: null },
      });

      await registerPaymentMethodAction({
        providerPaymentMethodId: "pm_stripe_xyz",
        setAsDefault: false,
        consentAccepted: true,
        consentVersion: "settings-card-save-v1",
      });

      expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
    });

    it("returns error when mutation rejects", async () => {
      executeMutationMock.mockRejectedValueOnce(new Error("Registration failed"));

      const result = await registerPaymentMethodAction({
        providerPaymentMethodId: "pm_stripe_fail",
        setAsDefault: false,
        consentAccepted: true,
        consentVersion: "settings-card-save-v1",
      });

      expect(result).toEqual({ error: "Registration failed" });
      expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it("returns fallback error on non-Error rejection", async () => {
      executeMutationMock.mockRejectedValueOnce("String error");

      const result = await registerPaymentMethodAction({
        providerPaymentMethodId: "pm_stripe_fail",
        setAsDefault: false,
        consentAccepted: true,
        consentVersion: "settings-card-save-v1",
      });

      expect(result).toEqual({ error: "Failed to register payment method" });
      expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it("returns error when providerPaymentMethodId is empty", async () => {
      const result = await registerPaymentMethodAction({
        providerPaymentMethodId: "",
        setAsDefault: false,
        consentAccepted: true,
        consentVersion: "settings-card-save-v1",
      });

      expect(result).toEqual({ error: "Provider payment method ID is required" });
      expect(executeMutationMock).not.toHaveBeenCalled();
      expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it("returns error when providerPaymentMethodId is whitespace-only", async () => {
      const result = await registerPaymentMethodAction({
        providerPaymentMethodId: "   ",
        setAsDefault: false,
        consentAccepted: true,
        consentVersion: "settings-card-save-v1",
      });

      expect(result).toEqual({ error: "Provider payment method ID is required" });
      expect(executeMutationMock).not.toHaveBeenCalled();
      expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it("returns consent error when consentAccepted is false without calling GraphQL", async () => {
      const result = await registerPaymentMethodAction({
        providerPaymentMethodId: "pm_stripe_abc123",
        setAsDefault: false,
        consentAccepted: false,
        consentVersion: "settings-card-save-v1",
      });

      expect(result).toEqual({ error: "Please consent to saving your payment method for future use." });
      expect(executeMutationMock).not.toHaveBeenCalled();
      expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it("returns consent error when consentAccepted is a truthy non-boolean value without calling GraphQL", async () => {
      const result = await registerPaymentMethodAction({
        providerPaymentMethodId: "pm_stripe_abc123",
        setAsDefault: false,
        consentAccepted: 1 as unknown as boolean,
        consentVersion: "settings-card-save-v1",
      });

      expect(result).toEqual({ error: "Please consent to saving your payment method for future use." });
      expect(executeMutationMock).not.toHaveBeenCalled();
      expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it("returns error when consentVersion is empty without calling GraphQL", async () => {
      const result = await registerPaymentMethodAction({
        providerPaymentMethodId: "pm_stripe_abc123",
        setAsDefault: false,
        consentAccepted: true,
        consentVersion: "",
      });

      expect(result).toEqual({ error: "Consent version is required" });
      expect(executeMutationMock).not.toHaveBeenCalled();
      expect(revalidatePathMock).not.toHaveBeenCalled();
    });

    it("returns error when consentVersion is whitespace-only without calling GraphQL", async () => {
      const result = await registerPaymentMethodAction({
        providerPaymentMethodId: "pm_stripe_abc123",
        setAsDefault: false,
        consentAccepted: true,
        consentVersion: "   ",
      });

      expect(result).toEqual({ error: "Consent version is required" });
      expect(executeMutationMock).not.toHaveBeenCalled();
      expect(revalidatePathMock).not.toHaveBeenCalled();
    });
  });
});
