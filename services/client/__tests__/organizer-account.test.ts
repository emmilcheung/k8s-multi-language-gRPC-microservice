import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieJar = new Map<string, string>();
const cookieSetMock = vi.fn((name: string, value: string) => {
  cookieJar.set(name, value);
});
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name)! } : undefined),
    set: cookieSetMock,
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const queryMock = vi.fn();
const mutationMock = vi.fn();
const createGraphQLClientMock = vi.fn(() => ({
  query: () => ({ toPromise: queryMock }),
  mutation: () => ({ toPromise: mutationMock }),
}));
vi.mock("@/lib/graphql-client", () => ({
  createGraphQLClient: (...args: unknown[]) =>
    (createGraphQLClientMock as (...a: unknown[]) => unknown)(...args),
  toApiError: (e: Error) => e,
}));

vi.mock("@/lib/server-utils", () => ({
  getValidAccessToken: vi.fn(async () => "access-token"),
  base: () => "http://kong",
}));

import {
  ORGANIZER_ACCOUNT_COOKIE,
  resolveSelectedAccountId,
} from "@/lib/organizer-account";
import { executeMutation, executeQuery } from "@/lib/graphql/execute";
import { selectOrganizerAccount } from "@/app/actions/accounts";

const ACME = "11111111-1111-4111-8111-111111111111";
const GLOBEX = "22222222-2222-4222-8222-222222222222";

describe("selected organizer account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieJar.clear();
    queryMock.mockResolvedValue({ data: { ok: true } });
    mutationMock.mockResolvedValue({ data: { ok: true } });
  });

  it("is remembered per browser in a cookie when the member picks an account they belong to", async () => {
    queryMock.mockResolvedValueOnce({
      data: { myAccounts: [{ account: { id: ACME } }, { account: { id: GLOBEX } }] },
    });

    const result = await selectOrganizerAccount(GLOBEX);

    expect(result).toEqual({});
    expect(cookieSetMock).toHaveBeenCalledWith(
      ORGANIZER_ACCOUNT_COOKIE,
      GLOBEX,
      expect.objectContaining({ httpOnly: true, path: "/" }),
    );
  });

  it("refuses to remember an account the user is not a member of", async () => {
    queryMock.mockResolvedValueOnce({ data: { myAccounts: [{ account: { id: ACME } }] } });

    const result = await selectOrganizerAccount(GLOBEX);

    expect(result.error).toBeTruthy();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("refuses a value that is not a uuid so nothing else is ever sent to the services", async () => {
    const result = await selectOrganizerAccount("acme; drop table");

    expect(result.error).toBeTruthy();
    expect(cookieSetMock).not.toHaveBeenCalled();
  });

  it("is sent as the acting account on organizer queries and mutations", async () => {
    cookieJar.set(ORGANIZER_ACCOUNT_COOKIE, GLOBEX);
    const doc = { kind: "Document", definitions: [] } as never;

    await executeQuery(doc, {});
    await executeMutation(doc, {});

    expect(createGraphQLClientMock).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      undefined,
      { "X-Organizer-Account": GLOBEX },
    );
    expect(createGraphQLClientMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      undefined,
      { "X-Organizer-Account": GLOBEX },
    );
  });

  it("sends nothing when the stored value is not a uuid, so a tampered cookie cannot reach the services", async () => {
    cookieJar.set(ORGANIZER_ACCOUNT_COOKIE, "not-a-uuid");
    const doc = { kind: "Document", definitions: [] } as never;

    await executeQuery(doc, {});

    expect(createGraphQLClientMock).toHaveBeenCalledWith(expect.any(String), undefined, {});
  });
});

describe("resolveSelectedAccountId", () => {
  it("keeps the stored account when the user still belongs to it", () => {
    expect(resolveSelectedAccountId([ACME, GLOBEX], GLOBEX)).toBe(GLOBEX);
  });

  it("falls back to the first account when the stored one is no longer theirs", () => {
    expect(resolveSelectedAccountId([ACME, GLOBEX], "33333333-3333-4333-8333-333333333333")).toBe(ACME);
  });

  it("falls back to the first account when nothing was stored", () => {
    expect(resolveSelectedAccountId([ACME, GLOBEX], undefined)).toBe(ACME);
  });

  it("selects nothing for a user with no organizer accounts", () => {
    expect(resolveSelectedAccountId([], GLOBEX)).toBeUndefined();
  });
});
