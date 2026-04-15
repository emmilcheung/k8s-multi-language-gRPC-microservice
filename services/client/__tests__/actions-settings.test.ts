import { beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePathMock = vi.fn();
const authHeadersMock = vi.fn();
const authSessionHeadersMock = vi.fn();

vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

vi.mock("@/lib/server-utils", () => ({
  base: () => "http://localhost:8000",
  authHeaders: (...args: unknown[]) => authHeadersMock(...args),
  authSessionHeaders: (...args: unknown[]) => authSessionHeadersMock(...args),
}));

import {
  deletePaymentMethodAction,
  getSettingsData,
  revokeSessionAction,
  setDefaultPaymentMethodAction,
  updateProfileAction,
} from "@/app/actions/settings";

describe("settings server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authHeadersMock.mockResolvedValue({ "Content-Type": "application/json" });
    authSessionHeadersMock.mockResolvedValue({
      "Content-Type": "application/json",
      Cookie: "token=access; refreshToken=refresh",
    });
  });

  it("uses session headers only for session endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ profile: { displayName: "Taylor" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ preferences: { marketingOptIn: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ billingAddress: { country: "US" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ paymentMethods: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ orders: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await getSettingsData();

    expect(authSessionHeadersMock).toHaveBeenCalledTimes(1);
    expect(authHeadersMock).toHaveBeenCalledTimes(5);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/users/sessions",
      expect.objectContaining({
        headers: expect.objectContaining({ Cookie: "token=access; refreshToken=refresh" }),
      }),
    );
  });

  it("routes revoke session through the session-header path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 204,
        }),
      ),
    );

    const formData = new FormData();
    formData.set("sessionId", "5f6cf0d3-114f-43bc-82f4-3e96b50e6033");

    await revokeSessionAction(formData);

    expect(authSessionHeadersMock).toHaveBeenCalledTimes(1);
    expect(authHeadersMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).toHaveBeenCalledWith("/settings");
  });

  it("keeps non-session settings mutations on normal auth headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
        }),
      ),
    );

    const profileForm = new FormData();
    profileForm.set("displayName", "Taylor");

    const defaultForm = new FormData();
    defaultForm.set("methodId", "a5dcccf6-22f2-493b-80fc-3350ca0ba3ad");

    const deleteForm = new FormData();
    deleteForm.set("methodId", "a5dcccf6-22f2-493b-80fc-3350ca0ba3ad");

    await updateProfileAction(profileForm);
    await setDefaultPaymentMethodAction(defaultForm);
    await deletePaymentMethodAction(deleteForm);

    expect(authHeadersMock).toHaveBeenCalledTimes(3);
    expect(authSessionHeadersMock).not.toHaveBeenCalled();
    expect(revalidatePathMock).toHaveBeenCalledTimes(3);
  });
});