import type { TypedDocumentNode } from "@graphql-typed-document-node/core";
import type { AnyVariables } from "urql";
import { print } from "graphql";
import { ApiError } from "@/lib/api-error";
import { traceHeaders } from "@/lib/tracing";

function resolvePublicGraphqlUrl(): string {
  const base = (
    process.env.INTERNAL_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:8080"
  ).replace(/\/$/, "");
  return (
    process.env.GRAPHQL_API_URL ??
    process.env.NEXT_PUBLIC_GRAPHQL_API_URL ??
    `${base}/graphql`
  );
}

/**
 * Execute a typed GraphQL query for PUBLIC, non-user-specific data, keeping the
 * calling route statically renderable (ISR).
 *
 * Deliberately uses a plain `fetch` instead of the urql client: urql attaches an
 * AbortController `signal` to every request, and `traceHeaders`/cookie wiring on
 * the shared client can pull in request-scoped state — Next.js opts any route
 * with a signal-bearing or no-store fetch out of static rendering. This path
 * sends no cookie and no signal, so the route can be cached and revalidated.
 */
export async function executePublicQuery<TData, TVariables extends AnyVariables>(
  document: TypedDocumentNode<TData, TVariables>,
  variables: TVariables,
  options: { revalidate?: number } = {},
): Promise<TData> {
  const res = await fetch(resolvePublicGraphqlUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...traceHeaders(),
    },
    body: JSON.stringify({ query: print(document), variables }),
    next: { revalidate: options.revalidate ?? 30 },
  });

  if (!res.ok) {
    throw new ApiError(res.status, `GraphQL request failed: ${res.status}`);
  }

  const json = (await res.json()) as {
    data?: TData;
    errors?: Array<{ message: string }>;
  };

  if (json.errors && json.errors.length > 0) {
    throw new ApiError(200, json.errors.map((e) => e.message).join("; "), json.errors);
  }
  if (json.data === undefined || json.data === null) {
    throw new ApiError(404, "GraphQL query returned no data");
  }
  return json.data;
}
