import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";

const cookiesMock = vi.fn();
const redirectMock = vi.fn();
const parseAuthCookiesMock = vi.fn();
const toCookieOptionsMock = vi.fn();

vi.mock("next/headers", () => ({
  cookies: () => cookiesMock(),
}));

vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirectMock(...args),
}));

vi.mock("@/lib/server-utils", () => ({
  base: () => "http://localhost:8080",
}));

vi.mock("@/lib/session-cookies", () => ({
  ACCESS_TOKEN_COOKIE: "token",
  REFRESH_TOKEN_COOKIE: "refreshToken",
  ACCESS_COOKIE_PATH: "/",
  REFRESH_COOKIE_PATH: "/",
  ACCESS_COOKIE_SAME_SITE: "strict",
  REFRESH_COOKIE_SAME_SITE: "strict",
  parseAuthCookies: (...args: unknown[]) => parseAuthCookiesMock(...args),
  toCookieOptions: (...args: unknown[]) => toCookieOptionsMock(...args),
}));

import { signup, signin, signout } from "@/app/actions/auth";

function makeForm(email: string, password: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  return fd;
}

describe("auth server actions", () => {
  const cookieSet = vi.fn();
  const cookieDelete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    cookiesMock.mockResolvedValue({
      set: cookieSet,
      delete: cookieDelete,
      get: vi.fn((name: string) => {
        if (name === "token") return { value: "jwt.token.value" };
        if (name === "refreshToken") return { value: "refresh.token.value" };
        return undefined;
      }),
    });
    parseAuthCookiesMock.mockReturnValue({
      token: {
        value: "jwt.token.value",
        path: "/",
        sameSite: "strict",
        maxAge: 900,
        httpOnly: true,
      },
      refreshToken: {
        value: "refresh.token.value",
        path: "/",
        sameSite: "strict",
        maxAge: 604800,
        httpOnly: true,
      },
    });
    toCookieOptionsMock.mockImplementation((cookie: { path?: string; sameSite?: string; maxAge?: number; httpOnly?: boolean }) => ({
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      path: cookie.path,
      maxAge: cookie.maxAge,
    }));
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

  it("signin forwards access and refresh cookies then redirects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: vi.fn().mockReturnValue(
            "token=jwt.token.value; HttpOnly; Path=/, refreshToken=refresh.token.value; HttpOnly; Path=/api/auth/refresh"
          ),
        },
      })
    );

    await signin({}, makeForm("user@example.com", "password123"));

    expect(cookieSet).toHaveBeenCalledWith(
      "token",
      "jwt.token.value",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: 900,
      })
    );
    expect(cookieSet).toHaveBeenCalledWith(
      "refreshToken",
      "refresh.token.value",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: 604800,
      })
    );
    expect(redirectMock).toHaveBeenCalledWith("/");
  });

  it("signout revokes upstream session and clears both local cookies", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await signout();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/api/users/signout",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        headers: expect.objectContaining({
          Cookie: "token=jwt.token.value; refreshToken=refresh.token.value",
        }),
      })
    );
    expect(cookieDelete).toHaveBeenCalledWith("token");
    expect(cookieDelete).toHaveBeenCalledWith("refreshToken");
    expect(redirectMock).toHaveBeenCalledWith("/auth/signin");
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
