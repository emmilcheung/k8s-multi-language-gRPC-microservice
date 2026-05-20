import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import graphqlPlugin from "@graphql-eslint/eslint-plugin";

// Banned syntax in .ts / .tsx — every GraphQL operation must live in a .graphql
// file under lib/graphql/operations/ so the codegen + persisted-query pipeline
// is the only path that puts query text on the wire. Inline gql tags or raw
// operation strings break that guarantee.
const NO_INLINE_GRAPHQL = [
  {
    selector: "TaggedTemplateExpression[tag.name='gql']",
    message:
      "Inline gql tags are forbidden. Add the operation to lib/graphql/operations/ and import the generated typed document from lib/graphql/generated.",
  },
  {
    selector:
      "Literal[value=/^\\s*(query|mutation|subscription|fragment)\\s/i]",
    message:
      "Raw GraphQL operation strings are forbidden in TypeScript. Add the operation to lib/graphql/operations/ and import the generated typed document.",
  },
  {
    selector:
      "TemplateElement[value.raw=/^\\s*(query|mutation|subscription|fragment)\\s/i]",
    message:
      "Raw GraphQL operation strings are forbidden in TypeScript. Add the operation to lib/graphql/operations/ and import the generated typed document.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "lib/graphql/generated/**",
    ".graphql-cache/**",
  ]),
  {
    files: ["**/*.ts", "**/*.tsx"],
    // E2E tests intentionally exercise the GraphQL gateway with raw queries
    // to verify federation/router behavior end-to-end; the no-inline rule
    // targets application code where every operation must be persisted.
    ignores: ["tests/e2e/**"],
    rules: {
      "no-restricted-syntax": ["error", ...NO_INLINE_GRAPHQL],
    },
  },
  {
    files: ["lib/graphql/operations/**/*.graphql"],
    languageOptions: {
      parser: graphqlPlugin.parser,
      parserOptions: {
        graphQLConfig: {
          schema: ".graphql-cache/supergraph.graphql",
          documents: "lib/graphql/operations/**/*.graphql",
        },
      },
    },
    plugins: {
      "@graphql-eslint": graphqlPlugin,
    },
    rules: {
      "@graphql-eslint/no-anonymous-operations": "error",
      "@graphql-eslint/no-deprecated": "error",
      "@graphql-eslint/no-duplicate-fields": "error",
      "@graphql-eslint/selection-set-depth": ["error", { maxDepth: 8 }],
      "@graphql-eslint/unique-operation-name": "error",
      "@graphql-eslint/known-type-names": "error",
    },
  },
]);

export default eslintConfig;
