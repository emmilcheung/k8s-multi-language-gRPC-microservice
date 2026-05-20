import type { CodegenConfig } from "@graphql-codegen/cli";

/**
 * GraphQL codegen for the client.
 *
 * - `schema` is the cached supergraph SDL written by scripts/fetch-schema.ts.
 *   The client never reaches outside its package for the schema at codegen
 *   time; the cache is the only input.
 * - `documents` scans the curated operations directory. Inline `gql` tags in
 *   .ts/.tsx are forbidden by the ESLint config — every operation lives in
 *   its own .graphql file so the build pipeline is the only path that puts
 *   query text on the wire.
 * - The typed-document-node plugin emits one `${OperationName}Document`
 *   per operation, importable from lib/graphql/generated.
 *
 * Phase 1 follow-up: add @graphql-codegen/client-preset (or
 * @graphql-codegen/persisted-operations) to also emit persisted-documents.json
 * once the Apollo GraphOS registry is provisioned.
 */
const config: CodegenConfig = {
  overwrite: true,
  schema: ".graphql-cache/supergraph.graphql",
  documents: ["lib/graphql/operations/**/*.graphql"],
  ignoreNoDocuments: true,
  generates: {
    "lib/graphql/generated/index.ts": {
      plugins: ["typescript", "typescript-operations", "typed-document-node"],
      config: {
        useTypeImports: true,
        enumsAsTypes: true,
        documentMode: "documentNode",
        avoidOptionals: { field: true },
      },
    },
  },
};

export default config;
