/**
 * OAuth endpoints and scopes for the two providers. The owner Worker uses the
 * authorize side (it runs the browser leg); the core uses the token side (it
 * holds the client secrets).
 */
export const MICROSOFT = {
  authorizeUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  scope: 'openid email offline_access https://graph.microsoft.com/Calendars.ReadWrite',
  /** Issuer of ID tokens for personal Microsoft accounts (the "consumers" tenant). */
  issuer: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0',
} as const;

export const GOOGLE = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scope: 'openid email https://www.googleapis.com/auth/meetings.space.created',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
} as const;

/** Bumped when an RPC method or field is added; old callers keep working. */
export const CONTRACT_VERSION = 1;
