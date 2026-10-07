export const GENERIC_ACTION_ERROR = "Something went wrong. Please try again.";

/**
 * Records an unexpected failure on the server and returns the message that is
 * safe to show. Only the error's name and message are logged: never request
 * variables, tokens or invitation links.
 */
export function unexpectedFailure(action: string, error: unknown): { error: string } {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
  console.error(`${action} failed: ${detail}`);
  return { error: GENERIC_ACTION_ERROR };
}
