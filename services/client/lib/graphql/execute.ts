import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import type { AnyVariables, OperationContext } from "urql";
import { createGraphQLClient, toApiError } from "@/lib/graphql-client";
import { getValidAccessToken } from "@/lib/server-utils";
import { ACCESS_TOKEN_COOKIE } from "@/lib/session-cookies";

interface ExecuteOptions {
  /** Forwarded cookie header. Defaults to a fresh access token from server state. */
  cookie?: string;
  /** Reserved for future Next.js fetch revalidate tag wiring. */
  revalidate?: number;
  /** Optional wall-clock timeout override for this operation. */
  timeoutMs?: number;
}

async function resolveCookie(provided?: string): Promise<string | undefined> {
  if (provided) return provided;
  const token = await getValidAccessToken();
  return token ? `${ACCESS_TOKEN_COOKIE}=${token}` : undefined;
}

/**
 * Execute a typed GraphQL query from a Server Component.
 *
 * Throws ApiError on failure so Server Components can use try/catch +
 * `notFound()` in the same shape they do for serverApi() today.
 */
export async function executeQuery<TData, TVariables extends AnyVariables>(
  document: TypedDocumentNode<TData, TVariables>,
  variables: TVariables,
  options: ExecuteOptions = {},
): Promise<TData> {
  const cookie = await resolveCookie(options.cookie);
  const client = createGraphQLClient(cookie, options.timeoutMs);
  const context: Partial<OperationContext> = {
    requestPolicy: "network-only",
  };
  const result = await client.query(document, variables, context).toPromise();
  if (result.error) throw toApiError(result.error);
  if (result.data === undefined) {
    throw new Error("GraphQL query returned no data");
  }
  return result.data;
}

// Re-export the cookie-free query helper so callers that don't need ISR-safety
// can import from either this file or lib/graphql/execute-public.ts.
// The page at app/tickets/[ticketId]/page.tsx imports directly from
// execute-public.ts to avoid pulling this module's cookies() import into the
// ISR render tree.
export { executePublicQuery } from "./execute-public";

/**
 * Execute a typed GraphQL mutation from a Server Action.
 *
 * Returns the raw data on success; throws ApiError on failure so Server
 * Actions can wrap with their usual { error: string } translation.
 */
export async function executeMutation<TData, TVariables extends AnyVariables>(
  document: TypedDocumentNode<TData, TVariables>,
  variables: TVariables,
  options: ExecuteOptions = {},
): Promise<TData> {
  const cookie = await resolveCookie(options.cookie);
  const client = createGraphQLClient(cookie, options.timeoutMs);
  const result = await client.mutation(document, variables).toPromise();
  if (result.error) throw toApiError(result.error);
  if (result.data === undefined) {
    throw new Error("GraphQL mutation returned no data");
  }
  return result.data;
}
