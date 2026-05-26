"use server";

import { revalidatePath } from "next/cache";
import { executeMutation } from "@/lib/graphql/execute";
import { UpdateAttendancePolicyDocument } from "@/lib/graphql/generated";

export async function updateAttendancePolicyAction(
  eventId: string,
  input: { requireQrForEntry: boolean; allowManualOverride: boolean }
): Promise<{
  policy?: { eventId: string; requireQrForEntry: boolean; allowManualOverride: boolean };
  error?: string;
}> {
  try {
    const data = await executeMutation(UpdateAttendancePolicyDocument, { eventId, input });
    revalidatePath(`/tickets/${eventId}/attendance`);
    return { policy: data.updateAttendancePolicy };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to save attendance settings." };
  }
}
