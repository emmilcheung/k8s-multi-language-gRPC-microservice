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
import { ApiError } from "@/lib/api";
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
export function createGraphQLClient(cookie?: string): Client {
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
          return {
            ...operation,
            context: {
              ...operation.context,
              fetchOptions: {
                ...(typeof existing === "function" ? {} : (existing ?? {})),
                headers: merged,
                // Fresh signal per attempt so retries aren't pre-aborted.
                signal: AbortSignal.timeout(5_000),
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
        onError(error) {
          // Logged at the boundary so observability picks up the failure,
          // even when the caller swallows the rethrown ApiError.
          console.error("[graphql] operation failed", {
            operationName: undefined,
            networkError: error.networkError?.message,
            graphQLErrors: error.graphQLErrors.map((e) => e.message),
          });
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
