import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button-variants";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DoorStaffForm,
  InviteForm,
  RemoveForm,
  RoleForm,
} from "@/components/organizer/team-forms";
import { executeQuery } from "@/lib/graphql/execute";
import {
  AccountEventsDocument,
  AccountMembersDocument,
  MyAccountsDocument,
  UserLookupDocument,
} from "@/lib/graphql/generated";
import { TEAM_ROLES, canManageTeam } from "@/lib/team-roles";
import { readSelectedAccountId, resolveSelectedAccountId } from "@/lib/organizer-account";

async function emailFor(userId: string, cookie: string): Promise<string> {
  try {
    const { userLookup } = await executeQuery(UserLookupDocument, { id: userId }, { cookie });
    return userLookup?.email ?? userId;
  } catch {
    return userId;
  }
}

function roleLabel(role: string): string {
  return TEAM_ROLES.find((r) => r.value === role)?.label ?? role;
}

export default async function TeamPage() {
  const cookie = (await cookies()).toString();
  const { myAccounts } = await executeQuery(MyAccountsDocument, {}, { cookie });
  const accountId = resolveSelectedAccountId(
    myAccounts.map((m) => m.account.id),
    await readSelectedAccountId()
  );
  const membership = myAccounts.find((m) => m.account.id === accountId);

  if (!accountId || !membership) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Team</CardTitle>
          <CardDescription>Create an organizer account first, then invite your team.</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/organizer/new-account" className={buttonVariants({ size: "sm" })}>
            Create organizer account
          </Link>
        </CardContent>
      </Card>
    );
  }

  // Only owners and admins may see or change the team; the console hides the
  // tab from everyone else, and a direct visit goes back to the overview.
  if (!canManageTeam(membership.role)) {
    redirect("/organizer");
  }

  const [{ accountMembers }, { eventsByAccount }] = await Promise.all([
    executeQuery(AccountMembersDocument, { accountId }, { cookie }),
    executeQuery(AccountEventsDocument, { accountId }, { cookie }).catch(() => ({
      eventsByAccount: { edges: [] },
    })),
  ]);
  const emails = await Promise.all(accountMembers.map((m) => emailFor(m.userId, cookie)));
  const events = eventsByAccount.edges.map((edge) => ({ id: edge.node.id, title: edge.node.title }));

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Card>
        <CardHeader>
          <CardTitle>Team of {membership.account.name}</CardTitle>
          <CardDescription>Everyone who can act for this organizer account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {accountMembers.map((member, index) => (
            <div key={member.userId} className="space-y-3 rounded-md border border-line bg-page p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold text-ink">{emails[index]}</p>
                <Badge tone="neutral">{roleLabel(member.role)}</Badge>
              </div>
              <RoleForm accountId={accountId} userId={member.userId} role={member.role} />
              {member.role === "DOOR_STAFF" && (
                <DoorStaffForm
                  accountId={accountId}
                  userId={member.userId}
                  events={events}
                  selected={member.eventIds}
                />
              )}
              <RemoveForm accountId={accountId} userId={member.userId} />
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Invite to team</CardTitle>
            <CardDescription>
              Door staff scan passes only for the events you choose. Share the invitation link with the invitee.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <InviteForm accountId={accountId} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
