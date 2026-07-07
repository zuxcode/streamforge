// ---------------------------------------------------------------------------
// cors.ts
//
// CORS middleware for the serve service.
// Configured via SERVE_CORS_ORIGINS — never hardcoded.
//
// Supported origins:
//
//   *                                    -> Allow all
//   https://example.com                  -> Exact origin
//   https://*.example.com                -> All HTTPS subdomains
//   http://*.example.com                 -> All HTTP subdomains
// ---------------------------------------------------------------------------

import type { Context, Next } from 'hono';

export interface CorsOptions {
  origins: string[];
}

function isAllowedOrigin(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.some((allowed) => {
    // Allow all
    if (allowed === '*') {
      return true;
    }

    // Wildcard origin
    //
    // Example:
    //   https://*.example.com
    //   http://*.example.com
    //
    if (allowed.includes('*.')) {
      try {
        const requestUrl = new URL(origin);
        const allowedUrl = new URL(allowed.replace('*.', 'placeholder.'));

        // Scheme must match
        if (requestUrl.protocol !== allowedUrl.protocol) {
          return false;
        }

        const suffix = allowedUrl.hostname.replace('placeholder', '');

        // Require a subdomain.
        // "*.example.com" matches:
        //   api.example.com
        //   cdn.example.com
        //
        // but NOT:
        //   example.com
        return requestUrl.hostname !== allowedUrl.hostname && requestUrl.hostname.endsWith(suffix);
      } catch {
        return false;
      }
    }

    // Exact match
    return origin === allowed;
  });
}

/**
 * Returns a Hono middleware that adds CORS headers to every response
 * and handles OPTIONS preflight requests.
 */
export function corsMiddleware(options: CorsOptions) {
  const { origins } = options;

  return async function cors(c: Context, next: Next): Promise<Response | undefined> {
    const requestOrigin = c.req.header('origin');

    let allowOrigin: string | null = null;

    if (requestOrigin && isAllowedOrigin(requestOrigin, origins)) {
      allowOrigin = origins.includes('*') ? '*' : requestOrigin;
    }

    // Handle preflight
    if (c.req.method === 'OPTIONS') {
      if (allowOrigin) {
        c.res.headers.set('Access-Control-Allow-Origin', allowOrigin);
        c.res.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        c.res.headers.set('Access-Control-Allow-Headers', 'Range, If-None-Match');
        c.res.headers.set('Access-Control-Max-Age', '86400');
      }

      c.status(204);
      return c.body(null);
    }

    await next();

    if (allowOrigin) {
      c.res.headers.set('Access-Control-Allow-Origin', allowOrigin);
      c.res.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      c.res.headers.set('Access-Control-Allow-Headers', 'Range, If-None-Match');
      c.res.headers.set('Access-Control-Expose-Headers', 'ETag, Content-Range, Accept-Ranges');

      // Recommended whenever ACAO is not always "*"
      c.res.headers.append('Vary', 'Origin');
    }
  };
}
