import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";

const cookiesMock = vi.fn();
const redirectMock = vi.fn();
const parseMock = vi.fn();

vi.mock("next/headers", () => ({
  cookies: () => cookiesMock(),
}));

vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirectMock(...args),
}));

vi.mock("set-cookie-parser", () => ({
  parse: (...args: unknown[]) => parseMock(...args),
}));

vi.mock("@/lib/server-utils", () => ({
  base: () => "http://localhost:8080",
}));

import { signup, signin } from "@/app/actions/auth";

function makeForm(email: string, password: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  return fd;
}

describe("auth server actions", () => {
  const cookieSet = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    cookiesMock.mockResolvedValue({ set: cookieSet });
    parseMock.mockReturnValue({ token: { value: "jwt.token.value" } });
  });

  it("signup rejects invalid email format", async () => {
    const result = await signup({}, makeForm("not-an-email", "password123"));
    expect(result).toEqual({ error: "Please enter a valid email address." });
  });

  it("signin rejects missing credentials", async () => {
    const fd = new FormData();
    const result = await signin({}, fd);
    expect(result).toEqual({ error: "Email and password are required." });
  });

  it("signin maps non-OK upstream response to user message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: vi.fn().mockResolvedValue({ error: { message: "Invalid credentials" } }),
      })
    );

    const result = await signin({}, makeForm("user@example.com", "bad-password"));
    expect(result).toEqual({ error: "Invalid credentials" });
  });

  it("signin forwards token cookie with 15m maxAge then redirects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: vi.fn().mockReturnValue("token=jwt.token.value; HttpOnly; Path=/") },
      })
    );

    await signin({}, makeForm("user@example.com", "password123"));

    expect(cookieSet).toHaveBeenCalledWith(
      "token",
      "jwt.token.value",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 900,
      })
    );
    expect(redirectMock).toHaveBeenCalledWith("/");
  });

  it("signup returns generic message when unexpected error occurs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));

    const result = await signup({}, makeForm("user@example.com", "password123"));
    expect(result).toEqual({ error: "An unexpected error occurred." });
  });

  it("signin returns ApiError message when thrown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new ApiError(500, "Gateway exploded")));

    const result = await signin({}, makeForm("user@example.com", "password123"));
    expect(result).toEqual({ error: "Gateway exploded" });
  });
});
