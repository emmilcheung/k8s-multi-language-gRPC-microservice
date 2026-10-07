import { executeQuery } from "@/lib/graphql/execute";
import { MyAccountsDocument } from "@/lib/graphql/generated";

/**
 * Whether the user belongs to any organizer account. Event pages use it so a
 * teammate who did not create an event can open it; the services still decide
 * whether the user may act on that particular event.
 */
export async function belongsToOrganizerAccount(cookie: string): Promise<boolean> {
  try {
    const { myAccounts } = await executeQuery(MyAccountsDocument, {}, { cookie });
    return myAccounts.length > 0;
  } catch {
    return false;
  }
}
