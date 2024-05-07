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
  url.pathname = url.pathname.replace('/api/0/', `/api/${dsn.projectId}/`);
  console.log('url =', url.toString());

  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('Host', url.host);
  headers.set('Content-Type', 'application/x-sentry-envelope');
  const cfConnectingIP = request.headers.get('CF-Connecting-IP');
  if (cfConnectingIP) {
    headers.set('X-Forwarded-For', cfConnectingIP);
  }

  // simply replace sentry_key with public key in the body
  const newBody = body
    .replaceAll(`"${sentryKey}"`, `"${dsn.publicKey}"`)
    // sentry-public_key=(md5)
    .replace(/(sentry-public_key=)[a-f0-9]{32}/, `$1${dsn.publicKey}`)
    // "public_key":"(md5)"
    .replace(/("public_key":")([a-f0-9]{32})(")/, `$1${dsn.publicKey}$3`);
  console.log(newBody);
  return () =>
    fetch(url.toString(), {
      method: request.method,
      headers,
      body: newBody,
    });
};

export default {
  async fetch(originalRequest: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(originalRequest.url);
    let sentryKey = url.searchParams.get('sentry_key') ?? originalRequest.headers.get('x-sentry-auth') ?? url.username;
    if (!sentryKey) {
      console.log('No sentry key found');
      return new Response('Forbidden', { status: 403 });
    }

    let request = originalRequest.clone();
    if (sentryKey.startsWith('Sentry ')) {
      console.log('Sentry key starts with Sentry =', sentryKey);
      // 'Sentry sentry_key=XXX, sentry_version=YYY, sentry_client=ZZZ'
      const sentryKeyParts = sentryKey
        .slice(7)
        .split(',')
        .map((part) => part.trim());

      const url = new URL(request.url);
      for (const part of sentryKeyParts) {
        const [key, value] = part.split('=');
        if (key === 'sentry_key') {
          sentryKey = value;
        }

        url.searchParams.set(key, value);
      }

      request = new Request(url.toString(), {
        method: request.method,
        headers: request.headers,
      });
      console.log('reconstructed URL =', request.url);
    }

    const dsns = SENTRY_DSN_MAP[sentryKey];
    if (!dsns) {
      console.log('Invalid Key:', sentryKey);
      return new Response('Forbidden (Invalid Key)', { status: 403 });
    }

    const [primary, ...rest] = dsns;

    let body: string;

    const contentEncoding = originalRequest.headers.get('content-encoding');
    if (typeof contentEncoding === 'string') {
      const decompressor = new DecompressionStream(contentEncoding as 'gzip' | 'deflate');
      const readableStream = originalRequest.body?.pipeThrough(decompressor);

      body = await new Response(readableStream)
        .arrayBuffer()
        .then((arrayBuffer) => new TextDecoder().decode(arrayBuffer));
    } else {
      body = await originalRequest.text();
    }

    if (rest.length > 0) {
      ctx.waitUntil(
        Promise.all(
          rest.map((dsn) => buildSentryIngestRequest(sentryKey, dsn, request, body)(), {
            method: originalRequest.method,
          }),
        ),
      );
    }

    const primaryResponse = await buildSentryIngestRequest(sentryKey, primary, request, body)();
    return primaryResponse;
  },
};
