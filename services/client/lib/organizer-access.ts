import { executeQuery } from "@/lib/graphql/execute";
import { MyAccountsDocument } from "@/lib/graphql/generated";
import { readSelectedAccountId, resolveSelectedAccountId } from "@/lib/organizer-account";

/**
 * The organizer account the user is acting as: the remembered one, else their
 * first membership. A render cannot set cookies, so pages pass this id on
 * their own calls. `null` means the user belongs to no account. Event pages use
 * it so a teammate who did not create an event can open it; the services still
 * decide whether the user may act on that particular event.
 */
export async function resolveActingAccountId(cookie: string): Promise<string | null> {
  try {
    const { myAccounts } = await executeQuery(MyAccountsDocument, {}, { cookie });
    return (
      resolveSelectedAccountId(
        myAccounts.map((m) => m.account.id),
        await readSelectedAccountId(),
      ) ?? null
    );
  } catch (error) {
    console.error("Could not load organizer accounts:", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}
