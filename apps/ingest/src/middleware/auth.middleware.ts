import { serveEnv } from "@streamforge/env";
import { payloadClient } from "@streamforge/payload";
import type { Context, Next } from "hono";

export async function authMiddleware(
    c: Context,
    next: Next,
): Promise<Response | void> {
    const client = payloadClient({
        token: serveEnv().SERVER_API_KEY,
        strategy: "apiKey",
    });

    try {
        const { user, message } = await client.me({ collection: "users" });

        if (!user) {
            return c.json({ error: message ?? "Unauthorized" }, 401);
        }

        c.set("user", user);
    } catch (err) {
        return c.json({ error: "Authentication service unavailable" }, 502);
    }

    return next();
}
