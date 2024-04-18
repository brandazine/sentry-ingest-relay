export interface SentryDSN {
  host: string;
  publicKey: string;
  projectId: string;
  tracesSampleRate?: number;
  errorsSampleRate?: number;
}

export const SENTRY_DSN_MAP = Object.freeze({}) as Record<string, SentryDSN[]>;
