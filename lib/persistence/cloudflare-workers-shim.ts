/**
 * Vercel build shim. Sites/vinext replaces this module with the real
 * Cloudflare binding; on Vercel the UI falls back to device-local preferences.
 */
export const env: { DB?: D1Database } = {};

