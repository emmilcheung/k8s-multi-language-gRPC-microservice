import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session-cookies";
import { AcceptForm } from "@/components/organizer/team-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  if (!token) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>Invitation link incomplete</CardTitle>
          <CardDescription>Ask the person who invited you to send the full link again.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const cookieStore = await cookies();
  if (!cookieStore.get(ACCESS_TOKEN_COOKIE)?.value) {
    const next = `/invitations/accept?token=${encodeURIComponent(token)}`;
    redirect(`/auth/signin?next=${encodeURIComponent(next)}`);
  }

  // Accepting is a button press, never a side effect of opening the link.
  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle>Join an organizer team</CardTitle>
        <CardDescription>
          Accepting adds you to the team with the role you were invited for. Anyone who holds this link can join, so only accept invitations from someone you trust.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AcceptForm token={token} />
      </CardContent>
    </Card>
  );
}
