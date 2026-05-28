"use client";

import { Provider, createClient, cacheExchange, fetchExchange } from "urql";
import type { ReactNode } from "react";

const GRAPHQL_FALLBACK_URL = `${
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"
}/graphql`;

const browserClient = createClient({
  url: process.env.NEXT_PUBLIC_GRAPHQL_API_URL ?? GRAPHQL_FALLBACK_URL,
  fetchOptions: { credentials: "include" },
  // Kong's /graphql route only accepts POST (GET is rejected and CORS allows
  // POST,OPTIONS only). urql defaults queries to GET, so this must be false.
  preferGetMethod: false,
  exchanges: [cacheExchange, fetchExchange],
});

export function UrqlProvider({ children }: { children: ReactNode }) {
  return <Provider value={browserClient}>{children}</Provider>;
}
