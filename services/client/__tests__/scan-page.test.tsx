import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name)! } : undefined),
    toString: (): string => "token=jwt",
  })),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

vi.mock("@/lib/server-utils", () => ({
  readCurrentUserIdFromToken: () => "door-staff-user",
}));

vi.mock("@/components/scanner-client", () => ({ ScannerClient: () => null }));

const executeQueryMock = vi.fn();
vi.mock("@/lib/graphql/execute", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}));

import ScanPage from "@/app/scan/page";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

function mockServices(memberships: string[]) {
  executeQueryMock.mockImplementation(async (doc: { definitions: { name?: { value: string } }[] }) => {
    const name = doc.definitions[0]?.name?.value;
    if (name === "MyAccounts") return { myAccounts: memberships.map((id) => ({ account: { id } })) };
    if (name === "AttendancePolicy") return { attendancePolicy: { requireQrForEntry: true } };
    return { ticket: { userId: "someone-else", name: "Show" } };
  });
}

describe("scan page acting account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieJar.clear();
    cookieJar.set("token", "jwt");
  });

  it("uses the user's first membership when no account is remembered", async () => {
    mockServices([FIRST, SECOND]);

    await ScanPage({ searchParams: Promise.resolve({ eventId: "event-1" }) });

    const eventCalls = executeQueryMock.mock.calls.filter(([, , options]) => options?.accountId);
    expect(eventCalls).toHaveLength(2);
    for (const [, , options] of eventCalls) expect(options.accountId).toBe(FIRST);
  });

  it("keeps the remembered account when the user still belongs to it", async () => {
    cookieJar.set("organizer_account", SECOND);
    mockServices([FIRST, SECOND]);

    await ScanPage({ searchParams: Promise.resolve({ eventId: "event-1" }) });

    const eventCalls = executeQueryMock.mock.calls.filter(([, , options]) => options?.accountId);
    for (const [, , options] of eventCalls) expect(options.accountId).toBe(SECOND);
  });

  it("refuses someone else's event when the user belongs to no account", async () => {
    mockServices([]);

    await expect(
      ScanPage({ searchParams: Promise.resolve({ eventId: "event-1" }) }),
    ).rejects.toThrow("NOT_FOUND");
  });
});
