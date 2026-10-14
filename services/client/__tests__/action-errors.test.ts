import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeMutationMock = vi.fn();
const executeQueryMock = vi.fn();
const serverApiMock = vi.fn();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/graphql/execute", () => ({
  executeMutation: (...a: unknown[]) => executeMutationMock(...a),
  executeQuery: (...a: unknown[]) => executeQueryMock(...a),
}));
vi.mock("@/lib/api", () => ({ serverApi: (...a: unknown[]) => serverApiMock(...a) }));

import { inviteMemberAction } from "@/app/actions/accounts";
import { changePlatformRoleAction, decideVenueClaimAction, suspendAccountAction } from "@/app/actions/admin";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const GENERIC = "Something went wrong. Please try again.";
const RAW = "connect ECONNREFUSED 10.0.3.7:4001 token=secret-invite-token";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("action error handling", () => {
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => logged.mockRestore());

  const invite = () =>
    form({ accountId: ACCOUNT, email: "a@example.com", role: "EVENT_MANAGER" });

  it("shows a generic message, not raw network text, when an account action throws", async () => {
    executeMutationMock.mockRejectedValue(new Error(RAW));

    const result = await inviteMemberAction({}, invite());

    expect(result).toEqual({ error: GENERIC });
    expect(logged).toHaveBeenCalled();
  });

  it("keeps the service's own message when it returns a user error", async () => {
    executeMutationMock.mockResolvedValue({
      inviteMember: { acceptLink: null, userErrors: [{ message: "That person is already on the team.", code: "CONFLICT" }] },
    });

    const result = await inviteMemberAction({}, invite());

    expect(result).toEqual({ error: "That person is already on the team." });
  });

  it("shows a generic message when an admin action throws", async () => {
    executeMutationMock.mockRejectedValue(new Error(RAW));

    const result = await suspendAccountAction({}, form({ accountId: ACCOUNT, reason: "fraud" }));

    expect(result).toEqual({ error: GENERIC });
  });

  it("does not pass an API error's text to the page when a role change is refused", async () => {
    executeQueryMock.mockResolvedValue({ userLookup: { id: ACCOUNT } });
    serverApiMock.mockRejectedValue(Object.assign(new Error(RAW), { name: "ApiError" }));

    const result = await changePlatformRoleAction(
      {},
      form({ email: "s@example.com", role: "platform_support", action: "grant", reason: "rota" }),
    );

    expect(result).toEqual({ error: GENERIC });
  });

  it("rejects a claim id that is not a uuid without calling the service", async () => {
    const result = await decideVenueClaimAction(
      {},
      form({ claimId: "1 OR 1=1", decision: "APPROVE", reason: "ok" }),
    );

    expect(result).toEqual({ error: GENERIC });
    expect(executeMutationMock).not.toHaveBeenCalled();
  });

  it("rejects a looked-up user id that is not a uuid before changing roles", async () => {
    executeQueryMock.mockResolvedValue({ userLookup: { id: "../../x" } });

    const result = await changePlatformRoleAction(
      {},
      form({ email: "s@example.com", role: "platform_admin", action: "grant", reason: "rota" }),
    );

    expect(result).toEqual({ error: GENERIC });
    expect(serverApiMock).not.toHaveBeenCalled();
  });
});
