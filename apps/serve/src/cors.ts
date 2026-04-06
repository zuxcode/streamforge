// ---------------------------------------------------------------------------
// cors.ts
//
// CORS middleware for the serve service.
// Configured via SERVE_CORS_ORIGINS — never hardcoded.
// ---------------------------------------------------------------------------

import type { Context, Next } from "hono";

export interface CorsOptions {
    origins: string[];
}

/**
 * Returns a Hono middleware that adds CORS headers to every response
 * and handles OPTIONS preflight requests.
 */
export function corsMiddleware(options: CorsOptions) {
    const { origins } = options;
    const allowAll = origins.length === 1 && origins[0] === "*";

    return async function cors(
        c: Context,
        next: Next,
    ): Promise<undefined | Response> {
        const requestOrigin = c.req.header("origin");

        // Determine the Access-Control-Allow-Origin value
        let allowOrigin: string | null = null;
        if (allowAll) {
            allowOrigin = "*";
        } else if (requestOrigin && origins.includes(requestOrigin)) {
            allowOrigin = requestOrigin;
        }

        // Handle preflight
        if (c.req.method === "OPTIONS") {
            const headers: Record<string, string> = {
                "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                "Access-Control-Allow-Headers": "Range, If-None-Match",
                "Access-Control-Max-Age": "86400",
            };
            if (allowOrigin) {
                headers["Access-Control-Allow-Origin"] = allowOrigin;
            }
            c.status(204);
            Object.entries(headers).forEach(([key, value]) => {
                c.res.headers.set(key, value);
            });
            return c.text("");
        }

        await next();

        // Append CORS headers to the actual response
        if (allowOrigin) {
            c.res.headers.set("Access-Control-Allow-Origin", allowOrigin);
            c.res.headers.set(
                "Access-Control-Allow-Methods",
                "GET, HEAD, OPTIONS",
            );
            c.res.headers.set(
                "Access-Control-Allow-Headers",
                "Range, If-None-Match",
            );
            // Expose ETag and Content-Range so the client can use them
            c.res.headers.set(
                "Access-Control-Expose-Headers",
                "ETag, Content-Range, Accept-Ranges",
            );
        }
    };
}
