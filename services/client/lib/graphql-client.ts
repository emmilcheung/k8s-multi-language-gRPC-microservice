import { cacheExchange, createClient, fetchExchange } from "urql";

export function createGraphQLClient(cookie?: string) {
  return createClient({
    url: `${process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080"}/graphql`,
    exchanges: [cacheExchange, fetchExchange],
    fetchOptions: () => ({
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }),
  });
}
