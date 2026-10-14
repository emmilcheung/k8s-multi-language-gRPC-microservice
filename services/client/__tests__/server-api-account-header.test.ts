import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name)! } : undefined),
  })),
}));

import { serverApi } from "@/lib/api";

const fetchMock = vi.fn();
const sentHeaders = () => (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;

describe("serverApi acting-account header", () => {
  beforeEach(() => {
    cookieJar.clear();
    cookieJar.set("organizer_account", ACCOUNT);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is sent on per-request organizer calls", async () => {
    cookieJar.set("token", "t");
    await serverApi("/api/organizer/events");
    expect(sentHeaders()["X-Organizer-Account"]).toBe(ACCOUNT);
  });

  it("is left off a fetch the shared cache serves to everyone", async () => {
    await serverApi("/api/tickets");
    expect(sentHeaders()).not.toHaveProperty("X-Organizer-Account");
  });
});
