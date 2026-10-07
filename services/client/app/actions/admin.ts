"use server";
// app/actions/admin.ts — Server Actions for the platform admin area.
//
// Every action needs a reason, which the services record in the audit history.
// Who may act is decided by the services; the admin pages are hidden from
// everyone else as a convenience only.

import { ApiError, serverApi } from "@/lib/api";
import { executeMutation, executeQuery } from "@/lib/graphql/execute";
import {
  DecideVenueClaimDocument,
  SuspendAccountDocument,
  UserLookupDocument,
} from "@/lib/graphql/generated";
import { isAccountId } from "@/lib/organizer-account";

export interface AdminActionState {
  error?: string;
  message?: string;
}

const PLATFORM_ROLES = ["platform_admin", "platform_support"] as const;
const MAX_REASON_LENGTH = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function reasonOf(formData: FormData): { reason: string } | { error: string } {
  const reason = text(formData, "reason");
  if (!reason) return { error: "Give a reason. It is kept in the audit history." };
  if (reason.length > MAX_REASON_LENGTH) {
    return { error: `The reason can be at most ${MAX_REASON_LENGTH} characters.` };
  }
  return { reason };
}

function failure(error: unknown, fallback: string): AdminActionState {
  return { error: error instanceof Error && error.message ? error.message : fallback };
}

export async function decideVenueClaimAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const claimId = text(formData, "claimId");
  const decision = text(formData, "decision");
  const reason = reasonOf(formData);
  if (!claimId) return { error: "Enter the claim id." };
  if (decision !== "APPROVE" && decision !== "REJECT") return { error: "Choose approve or reject." };
  if ("error" in reason) return reason;

  try {
    const { decideVenueClaim: result } = await executeMutation(DecideVenueClaimDocument, {
      input: { claimId, decision, reason: reason.reason },
    });
    if (result.userErrors.length > 0) return { error: result.userErrors[0].message };
    return {
      message: `Claim ${decision === "APPROVE" ? "approved" : "rejected"}.`,
    };
  } catch (error) {
    return failure(error, "Could not decide the claim.");
  }
}

export async function suspendAccountAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const accountId = text(formData, "accountId");
  const reason = reasonOf(formData);
  if (!isAccountId(accountId)) return { error: "Enter the organizer account id (a uuid)." };
  if ("error" in reason) return reason;

  try {
    const { suspendAccount: result } = await executeMutation(SuspendAccountDocument, {
      input: { accountId, reason: reason.reason },
    });
    if (result.userErrors.length > 0 || !result.account) {
      return { error: result.userErrors[0]?.message ?? "Could not suspend the account." };
    }
    return { message: `${result.account.name} is suspended.` };
  } catch (error) {
    return failure(error, "Could not suspend the account.");
  }
}

export async function changePlatformRoleAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const email = text(formData, "email");
  const role = text(formData, "role");
  const action = text(formData, "action");
  const reason = reasonOf(formData);
  if (!EMAIL_RE.test(email)) return { error: "Enter the email of the staff member." };
  if (!(PLATFORM_ROLES as readonly string[]).includes(role)) return { error: "Choose a platform role." };
  if (action !== "grant" && action !== "remove") return { error: "Choose grant or remove." };
  if ("error" in reason) return reason;

  try {
    const lookup = await executeQuery(UserLookupDocument, { email });
    const userId = lookup.userLookup?.id;
    if (!userId) return { error: "No user has that email." };

    await serverApi(`/admin/users/${userId}/roles`, {
      method: "POST",
      body: JSON.stringify({ role, action, reason: reason.reason }),
    });
    return {
      message:
        action === "grant"
          ? `${email} now has ${role}.`
          : `${role} removed from ${email}. Their sessions end at the next token refresh.`,
    };
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    return failure(error, "Could not change the platform role.");
  }
}
