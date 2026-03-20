// __tests__/api-error.test.ts — Unit tests for the ApiError class.
import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api";

describe("ApiError", () => {
  it("should set name to ApiError", () => {
    const err = new ApiError(400, "Bad request");
    expect(err.name).toBe("ApiError");
  });

  it("should store the HTTP status code", () => {
    const err = new ApiError(404, "Not found");
    expect(err.status).toBe(404);
  });

  it("should store the message", () => {
    const err = new ApiError(500, "Internal Server Error");
    expect(err.message).toBe("Internal Server Error");
  });

  it("should store the optional body", () => {
    const body = { error: { code: "NOT_FOUND", message: "Not found" } };
    const err = new ApiError(404, "Not found", body);
    expect(err.body).toEqual(body);
  });

  it("should be an instance of Error", () => {
    const err = new ApiError(401, "Unauthorized");
    expect(err).toBeInstanceOf(Error);
  });

  it("should work without a body argument", () => {
    const err = new ApiError(422, "Unprocessable");
    expect(err.body).toBeUndefined();
  });
});
