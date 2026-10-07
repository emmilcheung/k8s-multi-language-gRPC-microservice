"use server";
// app/actions/accounts.ts — Server Actions for organizer accounts: becoming an
// organizer, switching the acting account, and managing the team.
//
// The services enforce every permission; the checks here only keep obviously
// bad input off the wire and turn userErrors into form messages.

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { executeMutation, executeQuery } from "@/lib/graphql/execute";
import {
  AcceptInvitationDocument,
  ChangeMemberRoleDocument,
  CreateOrganizerAccountDocument,
  InviteMemberDocument,
  MyAccountsDocument,
  RemoveMemberDocument,
  SetDoorStaffEventsDocument,
  type AccountRole,
} from "@/lib/graphql/generated";
import {
  ORGANIZER_ACCOUNT_COOKIE,
  isAccountId,
  readSelectedAccountId,
  resolveSelectedAccountId,
} from "@/lib/organizer-account";
import { readRolesFromToken } from "@/lib/server-utils";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session-cookies";

export interface AccountActionState {
  error?: string;
  /** Short confirmation shown after a change that stays on the page. */
  message?: string;
  /** Shown once after an invitation is created; the inviter passes it on. */
  acceptLink?: string;
}

const ACCOUNT_ROLES: AccountRole[] = ["OWNER", "ADMIN", "EVENT_MANAGER", "FINANCE", "DOOR_STAFF"];
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function rememberAccount(accountId: string): Promise<void> {
  (await cookies()).set(ORGANIZER_ACCOUNT_COOKIE, accountId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });
}

function failure(error: unknown, fallback: string): AccountActionState {
  return { error: error instanceof Error && error.message ? error.message : fallback };
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function asRole(value: string): AccountRole | null {
  return (ACCOUNT_ROLES as string[]).includes(value) ? (value as AccountRole) : null;
}

// ─── Nav and account switcher ────────────────────────────────────────────────

/**
 * What the nav bar may offer this user. Presentation only: it also keeps the
 * remembered account in step with the user's memberships, so a removed member's
 * stale cookie is replaced by their first account.
 */
export async function getNavAccess(): Promise<{ organizer: boolean; admin: boolean }> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ACCESS_TOKEN_COOKIE)?.value;
  const admin = readRolesFromToken(token).includes("platform_admin");
  try {
    const { myAccounts } = await executeQuery(MyAccountsDocument, {});
    const ids = myAccounts.map((m) => m.account.id);
    const selected = resolveSelectedAccountId(ids, await readSelectedAccountId());
    if (selected && selected !== (await readSelectedAccountId())) {
      await rememberAccount(selected);
    }
    return { organizer: ids.length > 0, admin };
  } catch {
    return { organizer: false, admin };
  }
}

export async function selectOrganizerAccount(accountId: string): Promise<{ error?: string }> {
  if (!isAccountId(accountId)) return { error: "Choose one of your organizer accounts." };
  try {
    const { myAccounts } = await executeQuery(MyAccountsDocument, {});
    if (!myAccounts.some((m) => m.account.id === accountId)) {
      return { error: "You are not a member of that organizer account." };
    }
    await rememberAccount(accountId);
    revalidatePath("/organizer", "layout");
    return {};
  } catch (error) {
    return failure(error, "Could not switch organizer account.");
  }
}

// ─── Become an organizer ─────────────────────────────────────────────────────

export async function createOrganizerAccountAction(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const name = text(formData, "name");
  const contactEmail = text(formData, "contactEmail");
  if (!name) return { error: "Enter a name for your organizer account." };
  if (name.length > 120) return { error: "The name can be at most 120 characters." };
  if (contactEmail && !EMAIL_RE.test(contactEmail)) {
    return { error: "Enter a valid contact email." };
  }
  if (formData.get("acceptTerms") !== "on") {
    return { error: "Accept the organizer terms to continue." };
  }

  try {
    const { createOrganizerAccount: result } = await executeMutation(
      CreateOrganizerAccountDocument,
      { input: { name, contactEmail: contactEmail || null } },
    );
    if (result.userErrors.length > 0 || !result.account) {
      return { error: result.userErrors[0]?.message ?? "Could not create the organizer account." };
    }
    await rememberAccount(result.account.id);
  } catch (error) {
    return failure(error, "Could not create the organizer account.");
  }
  redirect("/organizer");
}

// ─── Team ────────────────────────────────────────────────────────────────────

export async function inviteMemberAction(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const accountId = text(formData, "accountId");
  const email = text(formData, "email");
  const role = asRole(text(formData, "role"));
  if (!isAccountId(accountId)) return { error: "Choose an organizer account first." };
  if (!EMAIL_RE.test(email)) return { error: "Enter the email of the person to invite." };
  if (!role) return { error: "Choose a role for the new team member." };

  try {
    const { inviteMember: result } = await executeMutation(InviteMemberDocument, {
      input: { accountId, email, role },
    });
    if (result.userErrors.length > 0 || !result.acceptLink) {
      return { error: result.userErrors[0]?.message ?? "Could not create the invitation." };
    }
    revalidatePath("/organizer/team");
    return { message: `Invitation created for ${email}.`, acceptLink: result.acceptLink };
  } catch (error) {
    return failure(error, "Could not create the invitation.");
  }
}

export async function changeMemberRoleAction(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const accountId = text(formData, "accountId");
  const userId = text(formData, "userId");
  const role = asRole(text(formData, "role"));
  if (!isAccountId(accountId) || !userId) return { error: "Choose a team member." };
  if (!role) return { error: "Choose a role." };

  try {
    const { changeMemberRole: result } = await executeMutation(ChangeMemberRoleDocument, {
      input: { accountId, userId, role },
    });
    if (result.userErrors.length > 0) {
      return { error: result.userErrors[0].message };
    }
    revalidatePath("/organizer/team");
    return { message: "Role updated." };
  } catch (error) {
    return failure(error, "Could not change the role.");
  }
}

export async function removeMemberAction(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const accountId = text(formData, "accountId");
  const userId = text(formData, "userId");
  if (!isAccountId(accountId) || !userId) return { error: "Choose a team member." };

  try {
    const { removeMember: result } = await executeMutation(RemoveMemberDocument, {
      input: { accountId, userId },
    });
    if (result.userErrors.length > 0 || !result.removed) {
      return { error: result.userErrors[0]?.message ?? "Could not remove the member." };
    }
    revalidatePath("/organizer/team");
    return { message: "Member removed." };
  } catch (error) {
    return failure(error, "Could not remove the member.");
  }
}

export async function setDoorStaffEventsAction(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const accountId = text(formData, "accountId");
  const userId = text(formData, "userId");
  if (!isAccountId(accountId) || !userId) return { error: "Choose a team member." };
  const eventIds = formData
    .getAll("eventIds")
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  try {
    const { setDoorStaffEvents: result } = await executeMutation(SetDoorStaffEventsDocument, {
      input: { accountId, userId, eventIds },
    });
    if (result.userErrors.length > 0) {
      return { error: result.userErrors[0].message };
    }
    revalidatePath("/organizer/team");
    return {
      message:
        eventIds.length > 0
          ? `Door staff limited to ${eventIds.length} event${eventIds.length === 1 ? "" : "s"}.`
          : "Door staff can scan every event of this account.",
    };
  } catch (error) {
    return failure(error, "Could not save the door staff events.");
  }
}

// ─── Accept an invitation ────────────────────────────────────────────────────

export async function acceptInvitationAction(
  _prev: AccountActionState,
  formData: FormData,
): Promise<AccountActionState> {
  const token = text(formData, "token");
  if (!token) return { error: "This invitation link is missing its token." };

  try {
    const { acceptInvitation: result } = await executeMutation(AcceptInvitationDocument, { token });
    if (result.userErrors.length > 0 || !result.account) {
      return { error: result.userErrors[0]?.message ?? "Could not accept the invitation." };
    }
    await rememberAccount(result.account.id);
  } catch (error) {
    return failure(error, "Could not accept the invitation.");
  }
  redirect("/organizer");
}
