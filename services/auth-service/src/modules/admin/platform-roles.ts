export const PLATFORM_ADMIN = 'platform_admin';
export const PLATFORM_SUPPORT = 'platform_support';

/** The only roles this module may grant or remove. */
export const PLATFORM_ROLES = [PLATFORM_ADMIN, PLATFORM_SUPPORT] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
