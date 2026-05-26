import { describe, expect, it } from "vitest";
import { GraphQLError } from "graphql";
import { CombinedError } from "urql";
import { toApiError } from "@/lib/graphql-client";

describe("toApiError", () => {
  it("maps GraphQL application errors to a non-2xx status even when transport returned 200", () => {
    const error = new CombinedError({
      response: { status: 200 } as Response,
      graphQLErrors: [
        new GraphQLError("Subgraph errors redacted", {
          path: ["createPayment", "status"],
        }),
      ],
    });

    const apiError = toApiError(error);

    expect(apiError.status).toBe(400);
    expect(apiError.message).toBe("Subgraph errors redacted");
    expect(apiError.body).toEqual({
      graphQLErrors: [
        {
          message: "Subgraph errors redacted",
          path: ["createPayment", "status"],
          extensions: {},
        },
      ],
    });
  });
});
