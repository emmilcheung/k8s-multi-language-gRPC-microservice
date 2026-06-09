import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import type { AnyVariables, OperationContext } from "urql";
import { createGraphQLClient, toApiError } from "@/lib/graphql-client";

/**
 * Execute a typed GraphQL query WITHOUT any auth cookie. Unlike executeQuery,
 * this never reads request cookies, so callers stay statically renderable
 * (ISR). Use only for public, non-user-specific data.
 */
export async function executePublicQuery<TData, TVariables extends AnyVariables>(
  document: TypedDocumentNode<TData, TVariables>,
  variables: TVariables,
  options: { timeoutMs?: number } = {},
): Promise<TData> {
  const client = createGraphQLClient(undefined, options.timeoutMs);
  const context: Partial<OperationContext> = { requestPolicy: "network-only" };
  const result = await client.query(document, variables, context).toPromise();
  if (result.error) throw toApiError(result.error);
  if (result.data === undefined) throw new Error("GraphQL query returned no data");
  return result.data;
}
