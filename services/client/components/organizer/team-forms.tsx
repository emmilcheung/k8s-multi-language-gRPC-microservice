"use client";
// components/organizer/team-forms.tsx — Forms on the team page. Each one posts
// to a Server Action and shows its error or confirmation inline.

import { useActionState, type ReactNode } from "react";
import { AlertCircle, CheckCircle, Loader2 } from "lucide-react";
import {
  acceptInvitationAction,
  changeMemberRoleAction,
  createOrganizerAccountAction,
  inviteMemberAction,
  removeMemberAction,
  setDoorStaffEventsAction,
  type AccountActionState,
} from "@/app/actions/accounts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TEAM_ROLES } from "@/lib/team-roles";

type Action = (prev: AccountActionState, formData: FormData) => Promise<AccountActionState>;

const selectClass = "h-8 rounded-md border border-line bg-page px-2 text-sm text-ink";

function Feedback({ state }: { state: AccountActionState }) {
  return (
    <>
      {state.error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.message && (
        <Alert>
          <CheckCircle />
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
    </>
  );
}

function Submit({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <Button type="submit" size="sm" disabled={pending} className="self-start">
      {pending && <Loader2 className="size-4 animate-spin" />}
      {children}
    </Button>
  );
}

// The service returns a path when it has no public web address configured.
function shareableLink(link: string): string {
  return link.startsWith("/") && typeof window !== "undefined" ? `${window.location.origin}${link}` : link;
}

export function NewAccountForm() {
  const [state, action, pending] = useActionState(createOrganizerAccountAction as Action, {});
  return (
    <form action={action} className="flex max-w-md flex-col gap-4">
      <Feedback state={state} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Organizer account name</Label>
        <Input id="name" name="name" required maxLength={120} placeholder="Acme Live Events" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="contactEmail">Contact email (optional)</Label>
        <Input id="contactEmail" name="contactEmail" type="email" placeholder="tickets@example.com" />
      </div>
      <label className="flex items-start gap-2 text-sm text-mute">
        <input type="checkbox" name="acceptTerms" required className="mt-1" />
        <span>I accept the organizer terms for selling tickets on this platform.</span>
      </label>
      <Submit pending={pending}>Create organizer account</Submit>
    </form>
  );
}

export function InviteForm({ accountId }: { accountId: string }) {
  const [state, action, pending] = useActionState(inviteMemberAction as Action, {});
  return (
    <form action={action} className="flex max-w-md flex-col gap-4">
      <input type="hidden" name="accountId" value={accountId} />
      <Feedback state={state} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="invite-email">Email</Label>
        <Input id="invite-email" name="email" type="email" required placeholder="teammate@example.com" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="invite-role">Role</Label>
        <select id="invite-role" name="role" defaultValue="EVENT_MANAGER" className={selectClass}>
          {TEAM_ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <Submit pending={pending}>Invite to team</Submit>
      {state.acceptLink && (
        <div className="flex flex-col gap-1.5 rounded-md border border-line bg-page p-3">
          <Label htmlFor="accept-link">Invitation link (share it with the invitee)</Label>
          <Input id="accept-link" readOnly value={shareableLink(state.acceptLink)} onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
    </form>
  );
}

export function RoleForm({ accountId, userId, role }: { accountId: string; userId: string; role: string }) {
  const [state, action, pending] = useActionState(changeMemberRoleAction as Action, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="userId" value={userId} />
      <select name="role" defaultValue={role} aria-label="Role" className={selectClass}>
        {TEAM_ROLES.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
      <Submit pending={pending}>Change role</Submit>
      <Feedback state={state} />
    </form>
  );
}

export function RemoveForm({ accountId, userId }: { accountId: string; userId: string }) {
  const [state, action, pending] = useActionState(removeMemberAction as Action, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="userId" value={userId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        Remove from team
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function DoorStaffForm({
  accountId,
  userId,
  events,
  selected,
}: {
  accountId: string;
  userId: string;
  events: { id: string; title: string }[];
  selected: string[];
}) {
  const [state, action, pending] = useActionState(setDoorStaffEventsAction as Action, {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="userId" value={userId} />
      <p className="text-xs text-mute">
        Events this door staff member can scan. Leave all unchecked to allow every event of this account.
      </p>
      {events.length === 0 && <p className="text-xs text-mute">This account has no events yet.</p>}
      {events.map((event) => (
        <label key={event.id} className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="eventIds" value={event.id} defaultChecked={selected.includes(event.id)} />
          {event.title}
        </label>
      ))}
      <Submit pending={pending}>Save door staff events</Submit>
      <Feedback state={state} />
    </form>
  );
}

export function AcceptForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(acceptInvitationAction as Action, {});
  return (
    <form action={action} className="flex max-w-md flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <Feedback state={state} />
      <Submit pending={pending}>Accept invitation</Submit>
    </form>
  );
}
