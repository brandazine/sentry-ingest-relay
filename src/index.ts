import { SENTRY_DSN_MAP, type SentryDSN } from './config';

type Env = {};

const buildSentryIngestRequest = (
  sentryKey: string,
  dsn: SentryDSN,
  request: Request,
  body: string,
): (() => Promise<Response>) => {
  const url = new URL(request.url);
  url.protocol = 'https:';
  url.host = dsn.host;
  url.searchParams.set('sentry_key', dsn.publicKey);

  // required: replace app id (/api/0/envelope -> /api/{projectId}/envelope)
  url.pathname = url.pathname.replace(/\/api\/0\//, `/api/${dsn.projectId}/`);

  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.set('Host', url.host);
  headers.set('Content-Type', 'application/x-sentry-envelope');
  const cfConnectingIP = request.headers.get('CF-Connecting-IP');
  if (cfConnectingIP) {
    headers.set('X-Forwarded-For', cfConnectingIP);
  }

  // simply replace sentry_key with public key in the body
  const newBody = body.replaceAll(`"${sentryKey}"`, `"${dsn.publicKey}"`);
  return () =>
    fetch(url.toString(), {
      method: request.method,
      headers,
      body: newBody,
    });
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const sentryKey = url.searchParams.get('sentry_key');
    if (!sentryKey) {
      return new Response('Forbidden', { status: 403 });
    }

    const dsns = SENTRY_DSN_MAP[sentryKey];
    const [primary, ...rest] = dsns;

    const body = await request.text();
    if (rest.length > 0) {
      ctx.waitUntil(
        Promise.all(
          rest.map((dsn) => buildSentryIngestRequest(sentryKey, dsn, request, body)(), {
            method: request.method,
          }),
        ),
      );
    }

    const primaryResponse = await buildSentryIngestRequest(sentryKey, primary, request, body)();
    return primaryResponse;
  },
};
