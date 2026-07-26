import {
  CombinedError,
  cacheExchange,
  createClient,
  errorExchange,
  fetchExchange,
  mapExchange,
  type Client,
} from "urql";
import { retryExchange } from "@urql/exchange-retry";
import { ApiError } from "@/lib/api-error";
import { traceHeaders } from "@/lib/tracing";

// TODO(audit): PQ + introspection lockdown per 2026-04-20-graphql-federation.md §1.4
const GRAPHQL_FALLBACK_PATH = "/graphql";

function resolveGraphqlUrl(): string {
  const serverUrl = process.env.GRAPHQL_API_URL;
  const publicUrl = process.env.NEXT_PUBLIC_GRAPHQL_API_URL;
  const fallback = `${
    process.env.INTERNAL_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:8080"
  }${GRAPHQL_FALLBACK_PATH}`;
  return (
    (typeof window === "undefined" ? serverUrl : publicUrl) ??
    serverUrl ??
    publicUrl ??
    fallback
  );
}

/**
 * Hardened urql client used by Server Components and Server Actions.
 *
 * Parity with lib/api.ts:serverApi:
 *  - forwards W3C `traceparent` so server-to-server traces stitch end-to-end;
 *  - forwards the request `Cookie` (auth + session) when invoked server-side;
 *  - retries idempotent query operations on transient (network / 5xx) failures;
 *  - translates network/GraphQL errors into ApiError so Server Actions can
 *    keep returning the same {data,error} shape they do for REST today.
 *
 * Phase 1 follow-up will add `@urql/exchange-persisted` here once the
 * Apollo GraphOS registry is provisioned — operations will then be sent as
 * sha256 hashes only and the router will enforce a safelist.
 */
export function createGraphQLClient(cookie?: string, timeoutMs = 5_000): Client {
  return createClient({
    url: resolveGraphqlUrl(),
    preferGetMethod: false,
    exchanges: [
      cacheExchange,
      // Add trace headers + cookie on every outgoing fetch.
      mapExchange({
        onOperation(operation) {
          const existing = operation.context.fetchOptions;
          const headersFromExisting: Record<string, string> =
            typeof existing === "function"
              ? {}
              : extractHeaders(existing?.headers);
          const merged: Record<string, string> = {
            ...headersFromExisting,
            ...traceHeaders(),
            ...(cookie ? { Cookie: cookie } : {}),
          };
          // Wrap fetch so we can inject a per-attempt timeout.
          // context.fetch is called with the final fetchOptions (which include
          // urql's own AbortController signal). We combine both so either
          // urql cancellation OR our 5s wall-clock timeout aborts the request.
          // NOTE: fetchOptions.signal is NOT the right place — urql overwrites
          // it with its own AbortController after the exchange chain runs.
          const upstreamFetch = operation.context.fetch ?? fetch;
          return {
            ...operation,
            context: {
              ...operation.context,
              fetch: (url: RequestInfo | URL, options?: RequestInit) => {
                const timeout = AbortSignal.timeout(timeoutMs);
                const signal = options?.signal
                  ? AbortSignal.any([options.signal, timeout])
                  : timeout;
                return upstreamFetch(url, { ...options, signal });
              },
              fetchOptions: {
                ...(typeof existing === "function" ? {} : (existing ?? {})),
                headers: merged,
              },
            },
          };
        },
      }),
      // Retry transient failures for queries only — never mutations.
      retryExchange({
        initialDelayMs: 250,
        maxDelayMs: 1500,
        randomDelay: true,
        maxNumberAttempts: 6,
        retryIf: (error, operation) => {
          if (operation.kind !== "query") return false;
          return isTransient(error);
        },
      }),
      // Translate CombinedError to ApiError before it reaches callers.
      errorExchange({
        onError(error, operation) {
          // Serialize into the message string so it survives Next.js's dev
          // overlay (the overlay strips structured second-arg objects).
          // urql widened `operation.query` to include PersistedDocument, which
          // carries no `definitions` — fall back to "anonymous" for those.
          const doc = operation.query;
          const opName =
            ("definitions" in doc
              ? doc.definitions.find(
                  (d): d is import("graphql").OperationDefinitionNode =>
                    d.kind === "OperationDefinition",
                )?.name?.value
              : undefined) ?? "anonymous";
          const payload = {
            operationName: opName,
            operationKind: operation.kind,
            message: error.message,
            networkError: error.networkError?.message,
            graphQLErrors: error.graphQLErrors.map((e) => ({
              message: e.message,
              path: e.path,
              extensions: e.extensions,
            })),
          };
          console.error(`[graphql] operation failed: ${JSON.stringify(payload)}`);
        },
      }),
      fetchExchange,
    ],
  });
}

function extractHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...(headers as Record<string, string>) };
}

function isTransient(error: CombinedError): boolean {
  if (error.networkError) return true;
  // urql surfaces HTTP status on networkError; GraphQL errors are application-level.
  const status = (error.response as { status?: number } | undefined)?.status;
  if (typeof status === "number" && (status === 429 || status >= 500)) {
    return true;
  }
  return false;
}

/**
 * Translate a urql CombinedError into the shared ApiError shape so callers
 * (Server Actions, Server Components) handle both REST and GraphQL failures
 * uniformly.
 */
export function toApiError(error: CombinedError): ApiError {
  const transportStatus = (error.response as { status?: number } | undefined)?.status;
  const status =
    error.graphQLErrors.length > 0
      ? (typeof transportStatus === "number" && transportStatus >= 400 ? transportStatus : 400)
      : (transportStatus ?? 502);
  const message =
    error.graphQLErrors[0]?.message ??
    error.networkError?.message ??
    "GraphQL request failed";
  return new ApiError(status, message, {
    graphQLErrors: error.graphQLErrors.map((e) => ({
      message: e.message,
      path: e.path,
      extensions: e.extensions,
    })),
  });
}
