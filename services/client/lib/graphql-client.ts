import { cacheExchange, createClient, fetchExchange } from "urql";

export function createGraphQLClient(cookie?: string) {
  const serverUrl = process.env.GRAPHQL_API_URL;
  const publicUrl = process.env.NEXT_PUBLIC_GRAPHQL_API_URL;
  const fallback = `${process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"}/graphql`;
  const url =
    (typeof window === "undefined" ? serverUrl : publicUrl) ??
    serverUrl ??
    publicUrl ??
    fallback;

  return createClient({
    url,
    exchanges: [cacheExchange, fetchExchange],
    preferGetMethod: false,
    fetchOptions: () => ({
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }),
  });
}
