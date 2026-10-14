// __tests__/organizer-team-access.test.tsx — The team is only for owners and
// admins: the users subgraph refuses the roster to every other role, so the
// console must not offer the Team tab to them, and a direct visit must not
// request the roster (the refusal would crash the server-rendered page).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const redirectMock = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined, toString: (): string => "" })),
}));

const executeQueryMock = vi.fn();
vi.mock("@/lib/graphql/execute", () => ({
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}));

vi.mock("@/components/organizer/account-switcher", () => ({
  AccountSwitcher: () => <div />,
}));

vi.mock("@/components/organizer/team-forms", () => ({
  DoorStaffForm: () => <div />,
  InviteForm: () => <div>invite form</div>,
  RemoveForm: () => <div />,
  RoleForm: () => <div />,
}));

const ACME = "3f1c6d0e-5b7a-4c1e-9a52-0a1b2c3d4e5f";

function memberAs(role: string) {
  return {
    myAccounts: [{ role, account: { id: ACME, name: "Acme", contactEmail: null, status: "ACTIVE" } }],
  };
}

function operationsCalled(): string[] {
  return executeQueryMock.mock.calls.map(
    ([doc]) => (doc as { definitions: { name?: { value: string } }[] }).definitions[0]?.name?.value ?? "",
  );
}

describe("Team tab in the organizer console", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["OWNER", "ADMIN"])("is offered to an account %s, who may manage the team", async (role) => {
    executeQueryMock.mockResolvedValueOnce(memberAs(role));

    const { default: OrganizerLayout } = await import("@/app/organizer/layout");
    render(await OrganizerLayout({ children: null }));

    expect(screen.getByRole("link", { name: /team/i })).toHaveAttribute("href", "/organizer/team");
  });

  it.each(["EVENT_MANAGER", "FINANCE", "DOOR_STAFF"])(
    "is hidden from a %s, whom the server refuses the roster",
    async (role) => {
      executeQueryMock.mockResolvedValueOnce(memberAs(role));

      const { default: OrganizerLayout } = await import("@/app/organizer/layout");
      render(await OrganizerLayout({ children: null }));

      expect(screen.queryByRole("link", { name: /team/i })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: /overview/i })).toBeInTheDocument();
    },
  );
});

describe("Team page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a member who may not manage the team back to the overview without asking for the roster", async () => {
    executeQueryMock.mockResolvedValueOnce(memberAs("EVENT_MANAGER"));

    const { default: TeamPage } = await import("@/app/organizer/team/page");

    await expect(TeamPage()).rejects.toThrow("NEXT_REDIRECT /organizer");
    expect(operationsCalled()).toEqual(["MyAccounts"]);
  });

  it("shows an owner the roster and the invite form", async () => {
    executeQueryMock.mockImplementation(async (doc: { definitions: { name?: { value: string } }[] }) => {
      switch (doc.definitions[0]?.name?.value) {
        case "MyAccounts":
          return memberAs("OWNER");
        case "AccountMembers":
          return { accountMembers: [{ userId: "owner-uuid", role: "OWNER", eventIds: [] }] };
        case "AccountEvents":
          return { eventsByAccount: { edges: [] } };
        case "UserLookup":
          return { userLookup: { email: "owner@example.com" } };
        default:
          throw new Error("unexpected query");
      }
    });

    const { default: TeamPage } = await import("@/app/organizer/team/page");
    render(await TeamPage());

    expect(redirectMock).not.toHaveBeenCalled();
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    expect(screen.getByText("invite form")).toBeInTheDocument();
  });
});
