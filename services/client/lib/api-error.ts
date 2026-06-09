/**
 * Shared API error type. Lives in its own file so it can be imported by
 * modules (e.g. graphql-client, execute-public) that must not pull in
 * next/headers — importing lib/api.ts would do that via serverApi().
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public readonly body?: any
  ) {
    super(message);
    this.name = "ApiError";
  }
}
