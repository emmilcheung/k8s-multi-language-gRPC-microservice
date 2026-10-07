import { executeQuery } from "@/lib/graphql/execute";
import { MyAccountsDocument } from "@/lib/graphql/generated";
import { readSelectedAccountId, rememberAccount, resolveSelectedAccountId } from "@/lib/organizer-account";

/** Remembers the user's first organizer account when none is remembered yet. */
export async function rememberDefaultAccount(): Promise<void> {
  const { myAccounts } = await executeQuery(MyAccountsDocument, {});
  const selected = resolveSelectedAccountId(
    myAccounts.map((m) => m.account.id),
    await readSelectedAccountId(),
  );
  if (selected) await rememberAccount(selected);
}
