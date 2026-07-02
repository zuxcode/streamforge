import { Hono } from "hono";
import { cors } from "hono/cors";
import { trimTrailingSlash } from "hono/trailing-slash";
import { logger as honoLogger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { poweredBy } from "hono/powered-by";
import { prettyJSON } from "hono/pretty-json";
import { showRoutes } from "hono/dev";
import { csrf } from "hono/csrf";

const app = new Hono();

/* =========================================================
 * CORS Config
 * ======================================================= */
// const origin = serveEnv.SF_COR_ORIGIN === "*"
//   ? "*"
//   : serveEnv.SF_COR_ORIGIN.split(",").map((o) => o.trim());

/* =========================================================
 * Middleware
 * ======================================================= */
app.use(honoLogger());
app.use(trimTrailingSlash());
// app.use(csrf({ origin }));
// app.use(
//   "*",
//   cors({
//     origin,
//     allowMethods: ["GET", "POST", "HEAD", "OPTIONS"],
//     credentials: serveEnv.SF_COR_ORIGIN !== "*",
//     allowHeaders: ["Content-Type", "Authorization"],
//     maxAge: 86400,
//   }),
// );

app.use("*", prettyJSON());
app.use(poweredBy({ serverName: "StreamForge" }));
app.use(secureHeaders());

/* =========================================================
 * Routes
 * ======================================================= */
// app.route("/", streamRoute);

app.get("/health", (c) =>
    c.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: process.uptime,
        runtime: "bun",
        framework: "hono",
    }));

/* =========================================================
 * Error Handling
 * ======================================================= */
app.onError((err, c) => {
    // logger.error(err, "Unhandled error");

    return c.json(
        {
            success: false,
            error: process.env.NODE_ENV === "production"
                ? "Internal Server Error"
                : err.message,
        },
        500,
    );
});

app.notFound((c) =>
    c.json(
        { error: { code: "NOT_FOUND", message: "Route not found." } },
        404,
    )
);

/* =========================================================
 * Server Startup
 * ======================================================= */
const server = Bun.serve({
    port: 3002,
    fetch: app.fetch,
});

// logger.info({
//   port: serveEnv.SERVE_PORT,
//   corsOrigins: serveEnv.SF_COR_ORIGIN,
//   serverCacheTtl: serveEnv.SERVE_CACHE_TTL,
//   nodeEnv: serveEnv.NODE_ENV,
// }, "streamforge serve service started");

/* =========================================================
 * Graceful Shutdown
 * ======================================================= */
const shutdown = async (signal: string) => {
    // logger.info(`Received ${signal}. Starting graceful shutdown...`);

    await server.stop();

    try {
        // logger.debug("Closing resources...");

        // logger.info("Shutdown complete");
        process.exit(0);
    } catch (err) {
        // logger.error(err, "Shutdown error");
        process.exit(1);
    }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/* =========================================================
 * Dev Tools
 * ======================================================= */
// if (serveEnv.NODE_ENV !== "production") {
//     showRoutes(app);
// }

// export default app;
export default {
    port: 3002,
    fetch: app.fetch,
};
