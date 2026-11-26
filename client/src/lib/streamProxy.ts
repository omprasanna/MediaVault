import type { NextRequest } from 'next/server';

const FORWARDED_REQUEST_HEADERS = [
  'cookie',
  'range',
  'if-range',
  'if-none-match',
  'if-modified-since',
  'accept',
  'user-agent',
] as const;

const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
  'x-content-type-options',
] as const;

function getInternalApiBaseUrl(): string {
  return (process.env.INTERNAL_API_URL || 'http://127.0.0.1:5000').replace(/\/+$/, '');
}

/**
 * Pipes an Express streaming response directly to the browser via Web Streams
 * without buffering file or media bytes into Node.js memory.
 */
export async function pipeExpressStream(
  req: NextRequest,
  upstreamPath: string
): Promise<Response> {
  const targetUrl = `${getInternalApiBaseUrl()}${upstreamPath}`;
  const forwardHeaders = new Headers();

  for (const headerName of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(headerName);
    if (value) {
      forwardHeaders.set(headerName, value);
    }
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      redirect: 'manual',
      cache: 'no-store',
      signal: req.signal,
    });

    const responseHeaders = new Headers();
    for (const headerName of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(headerName);
      if (value) {
        responseHeaders.set(headerName, value);
      }
    }

    if (!responseHeaders.has('cache-control')) {
      responseHeaders.set('cache-control', 'no-store');
    }

    return new Response(req.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return new Response(null, { status: 499 });
    }

    return Response.json(
      {
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'Failed to reach MediaVault API server.',
        },
      },
      {
        status: 502,
        headers: {
          'cache-control': 'no-store',
        },
      }
    );
  }
}
