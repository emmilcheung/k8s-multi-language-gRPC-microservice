"use server";
// app/actions/saved-events.ts — Server Actions for save/unsave event mutations.

import { revalidatePath } from "next/cache";
import { executeMutation } from "@/lib/graphql/execute";
import { SaveEventDocument, UnsaveEventDocument } from "@/lib/graphql/generated";

export interface SavedEventState {
  error?: string;
  savedByMe?: boolean;
}

export async function saveEvent(
  eventId: string,
  _prev: SavedEventState,
  _formData: FormData
): Promise<SavedEventState> {
  void _prev;
  void _formData;
  try {
    const data = await executeMutation(SaveEventDocument, { eventId });
    revalidatePath("/orders");
    revalidatePath(`/tickets/${eventId}`);
    return { savedByMe: data.saveEvent.savedByMe };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to save event." };
  }
}

export async function unsaveEvent(
  eventId: string,
  _prev: SavedEventState,
  _formData: FormData
): Promise<SavedEventState> {
  void _prev;
  void _formData;
  try {
    const data = await executeMutation(UnsaveEventDocument, { eventId });
    revalidatePath("/orders");
    revalidatePath(`/tickets/${eventId}`);
    return { savedByMe: data.unsaveEvent.savedByMe };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Failed to unsave event." };
  }
}
