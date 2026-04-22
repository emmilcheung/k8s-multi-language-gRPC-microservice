import { cacheExchange, createClient, fetchExchange } from "urql";

export function createGraphQLClient(cookie?: string) {
  return createClient({
    url: process.env.GRAPHQL_API_URL ?? `${process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"}/graphql`,
    exchanges: [cacheExchange, fetchExchange],
    preferGetMethod: false,
    fetchOptions: () => ({
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }),
  });
}
