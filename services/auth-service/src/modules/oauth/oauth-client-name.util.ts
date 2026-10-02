import { CLIENT_NAME_MAX_LENGTH } from './oauth.dto';

// Control, format (bidi marks, zero-width, BOM), line and paragraph separators.
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Why `name` may not be shown as an app name, or null when it is fine. One rule
 * for DCR and CIMD: the name is rendered on the consent page, so invisible and
 * direction-changing characters could blur it with another name.
 */
export function clientNameProblem(name: unknown): string | null {
  if (typeof name !== 'string') return 'client_name must be a string';
  if (name.length > CLIENT_NAME_MAX_LENGTH) {
    return `client_name must be at most ${CLIENT_NAME_MAX_LENGTH} characters`;
  }
  if (UNSAFE_NAME_CHARS.test(name)) {
    return 'client_name contains control or formatting characters';
  }
  return null;
}
