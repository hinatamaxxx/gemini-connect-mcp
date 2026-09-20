import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
export interface Env {
  GEMINI_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  OWNER_GOOGLE_EMAIL: string;
  PUBLIC_ORIGIN: string;
  GEMINI_MODEL: string;
  AUTH_VERSION: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  AUTH_LIMIT: RateLimit;
  GEMINI_LIMIT: RateLimit;
}
export interface OwnerProps { userId: string; email: string; scopes: string[]; version: string }
