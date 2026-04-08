// ---------------------------------------------------------------------------
// @streamforge/auth
//
// Token introspection client and Hono middleware for opaque access tokens
// issued by an external auth provider (Auth0, Clerk, etc.).
//
// Opaque token model:
//   - The token is a random, opaque string — it carries no verifiable claims
//   - Every token must be validated by calling the auth provider's userinfo
//     or introspection endpoint over HTTP
//   - The endpoint returns the user profile including role and subscription
//
// Performance:
//   - A naive implementation calls the auth service on every request, adding
//     latency and a hard dependency on auth service availability
//   - This package caches successful introspection results in memory with a
//     configurable TTL (default: 30 s) so repeated requests from the same
//     client hit the cache instead of the auth service
//   - A revoked token will be denied on the next cache miss (within TTL seconds)
//
// Environment variables:
//   AUTH_INTROSPECT_URL    Userinfo / introspection endpoint URL (required)
//   AUTH_INTROSPECT_TOKEN  Service token to authenticate with the auth service
//                          (optional — omit to use the user token as credential)
//   AUTH_CACHE_TTL_SEC     Result cache TTL in seconds (default: 30)
// ---------------------------------------------------------------------------

import type { Context, MiddlewareHandler, Next } from "hono";
import type {
    AuthenticatedUser,
    SubscriptionStatus,
    UserRole,
} from "@streamforge/types";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AuthError extends Error {
    public readonly code: string;
    public readonly statusCode: 401 | 403;

    constructor(code: string, message: string, statusCode: 401 | 403) {
        super(message, { cause: undefined });
        this.name = "AuthError";
        this.code = code;
        this.statusCode = statusCode;
    }
}

/** Token is missing, invalid, expired, or rejected by the auth service. */
export class UnauthenticatedError extends AuthError {
    constructor(message: string) {
        super("UNAUTHENTICATED", message, 401);
        this.name = "UnauthenticatedError";
    }
}

/** Token is valid but the user lacks the required role or subscription. */
export class UnauthorizedError extends AuthError {
    constructor(message: string) {
        super("UNAUTHORIZED", message, 403);
        this.name = "UnauthorizedError";
    }
}

// ---------------------------------------------------------------------------
// In-memory introspection cache
//
// Keyed by raw opaque token string.
// Short TTL balances latency (fewer auth service calls) against revocation
// propagation time (a revoked token is denied after at most TTL seconds).
// ---------------------------------------------------------------------------

interface CacheEntry {
    user: AuthenticatedUser;
    cachedAt: number;
}

export class TokenCache {
    private readonly store = new Map<string, CacheEntry>();
    private readonly ttlMs: number;

    constructor(ttlSeconds: number) {
        this.ttlMs = ttlSeconds * 1000;
    }

    get(token: string): AuthenticatedUser | null {
        const entry = this.store.get(token);
        if (!entry) return null;
        if (Date.now() - entry.cachedAt > this.ttlMs) {
            this.store.delete(token);
            return null;
        }
        return entry.user;
    }

    set(token: string, user: AuthenticatedUser): void {
        this.store.set(token, { user, cachedAt: Date.now() });
    }

    /** Explicitly removes a token — call on webhook-based revocation events. */
    invalidate(token: string): void {
        this.store.delete(token);
    }

    /** Removes all expired entries. Called automatically every 5 minutes. */
    evictExpired(): void {
        const now = Date.now();
        for (const [token, entry] of this.store.entries()) {
            if (now - entry.cachedAt > this.ttlMs) {
                this.store.delete(token);
            }
        }
    }

    get size(): number {
        return this.store.size;
    }
}

// ---------------------------------------------------------------------------
// Auth client config
// ---------------------------------------------------------------------------

export interface AuthClientConfig {
    /**
     * Userinfo or introspection endpoint URL.
     * Auth0:  https://YOUR_DOMAIN.auth0.com/userinfo
     * Clerk:  https://api.clerk.com/v1/me
     */
    introspectUrl: string;

    /**
     * Static service token to authenticate calls to the introspection endpoint.
     * Omit if the provider expects the user's own token as the credential
     * (OAuth 2.0 userinfo standard — Auth0, most OIDC providers).
     * Set this for providers that require a management/service API key.
     */
    introspectToken?: string;

    /** Cache TTL in seconds. Default: 30. */
    cacheTtlSeconds?: number;

    /**
     * Maps provider response field names to AuthenticatedUser fields.
     * Only needed when the provider uses non-standard names.
     * Example: { sub: "user_id", role: "https://myapp.com/role" }
     */
    claimMap?: Partial<Record<keyof AuthenticatedUser, string>>;

    /** Request timeout in ms. Default: 5000. */
    timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Profile normalisation
// ---------------------------------------------------------------------------

const VALID_ROLES = new Set<string>(["admin", "user"]);
const VALID_SUBSCRIPTIONS = new Set<string>([
    "active",
    "inactive",
    "trialing",
    "past_due",
]);

/**
 * Normalises the raw JSON from an introspection endpoint into a typed
 * AuthenticatedUser. Throws UnauthenticatedError for missing or invalid fields.
 */
export function normaliseUserProfile(
    raw: Record<string, unknown>,
    claimMap: Partial<Record<keyof AuthenticatedUser, string>> = {},
): AuthenticatedUser {
    const get = (key: keyof AuthenticatedUser) => raw[claimMap[key] ?? key];

    const sub = get("sub");
    if (!sub || typeof sub !== "string") {
        throw new UnauthenticatedError(
            "Auth service response is missing the 'sub' field.",
        );
    }

    const email = get("email");
    if (!email || typeof email !== "string") {
        throw new UnauthenticatedError(
            "Auth service response is missing the 'email' field.",
        );
    }

    const role = get("role");
    if (!role || typeof role !== "string" || !VALID_ROLES.has(role)) {
        throw new UnauthenticatedError(
            `Auth service returned an unrecognised role: "${role}". Expected one of: ${
                [...VALID_ROLES].join(", ")
            }.`,
        );
    }

    const subscription = get("subscription");
    if (
        !subscription || typeof subscription !== "string" ||
        !VALID_SUBSCRIPTIONS.has(subscription)
    ) {
        throw new UnauthenticatedError(
            `Auth service returned an unrecognised subscription status: "${subscription}".`,
        );
    }

    return {
        sub,
        email,
        role: role as UserRole,
        subscription: subscription as SubscriptionStatus,
    };
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the Bearer token from an Authorization header.
 * Returns null if the header is absent or not a Bearer scheme.
 */
export function extractBearerToken(
    authHeader: string | null | undefined,
): string | null {
    if (!authHeader) return null;
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
    return parts[1] ?? null;
}

// ---------------------------------------------------------------------------
// Introspection client
// ---------------------------------------------------------------------------

/**
 * Calls the auth provider's userinfo/introspection endpoint and returns a
 * normalised AuthenticatedUser.
 *
 * Two credential modes:
 *
 *   User-token mode (OAuth 2.0 standard — Auth0, Clerk userinfo):
 *     Authorization: Bearer <user_token>
 *     introspectToken is undefined.
 *
 *   Service-token mode (management API pattern):
 *     Authorization: Bearer <service_token>
 *     User token appended as ?token=<user_token>.
 *     introspectToken holds the service token.
 *
 * @throws UnauthenticatedError if the endpoint rejects or the response is invalid.
 */
export async function introspectToken(
    userToken: string,
    config: AuthClientConfig,
): Promise<AuthenticatedUser> {
    const timeout = config.timeoutMs ?? 5_000;
    const claimMap = config.claimMap ?? {};

    let url = config.introspectUrl;
    if (config.introspectToken) {
        const u = new URL(url);
        u.searchParams.set("token", userToken);
        url = u.toString();
    }

    const authHeader = config.introspectToken
        ? `Bearer ${config.introspectToken}`
        : `Bearer ${userToken}`;

    let response: Response;
    try {
        response = await fetch(url, {
            method: "GET",
            headers: { Authorization: authHeader, Accept: "application/json" },
            signal: AbortSignal.timeout(timeout),
        });
    } catch (err) {
        const isTimeout = err instanceof Error &&
            (err.name === "TimeoutError" || err.name === "AbortError");
        throw new UnauthenticatedError(
            isTimeout
                ? `Auth service timed out after ${timeout} ms.`
                : `Auth service is unreachable: ${
                    err instanceof Error ? err.message : String(err)
                }`,
        );
    }

    if (response.status === 401 || response.status === 403) {
        throw new UnauthenticatedError(
            "Token was rejected by the auth service — it may be invalid or revoked.",
        );
    }

    if (!response.ok) {
        throw new UnauthenticatedError(
            `Auth service returned an unexpected status: ${response.status}.`,
        );
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new UnauthenticatedError(
            "Auth service returned a non-JSON response.",
        );
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new UnauthenticatedError(
            "Auth service returned an unexpected response shape.",
        );
    }

    return normaliseUserProfile(body as Record<string, unknown>, claimMap);
}

// ---------------------------------------------------------------------------
// Hono context extension
// ---------------------------------------------------------------------------

declare module "hono" {
    interface ContextVariableMap {
        user: AuthenticatedUser;
    }
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export interface CreateAuthMiddlewareOptions extends AuthClientConfig {
    /**
     * When true, a missing or invalid token does not abort the request.
     * Downstream handlers must guard with `c.get("user")` before using it.
     * Default: false.
     */
    optional?: boolean;
}

/**
 * Returns a Hono middleware that validates opaque tokens by calling the
 * auth provider's introspection endpoint with in-memory result caching.
 *
 * Create once at startup — the cache is shared across all requests.
 */
export function createAuthMiddleware(
    options: CreateAuthMiddlewareOptions,
): MiddlewareHandler {
    const cache = new TokenCache(options.cacheTtlSeconds ?? 30);

    // Evict stale entries every 5 minutes to prevent unbounded growth
    const evictionInterval = setInterval(
        () => cache.evictExpired(),
        5 * 60 * 1000,
    );
    if (typeof evictionInterval === "object" && "unref" in evictionInterval) {
        evictionInterval.unref();
    }

    return async function authMiddleware(
        c: Context,
        next: Next,
    ): Promise<void | Response> {
        const token = extractBearerToken(c.req.header("authorization"));

        if (!token) {
            if (options.optional) return next();
            return c.json(
                {
                    error: {
                        code: "UNAUTHENTICATED",
                        message: "Authorization header is required.",
                    },
                },
                401,
            );
        }

        // Cache hit — skip the auth service call entirely
        const cached = cache.get(token);
        if (cached) {
            c.set("user", cached);
            return next();
        }

        // Cache miss — call the auth service
        let user: AuthenticatedUser;
        try {
            user = await introspectToken(token, options);
        } catch (err) {
            if (err instanceof AuthError) {
                if (options.optional) return next();
                return c.json(
                    { error: { code: err.code, message: err.message } },
                    err.statusCode,
                );
            }
            return c.json(
                {
                    error: {
                        code: "UNAUTHENTICATED",
                        message: "Token verification failed.",
                    },
                },
                401,
            );
        }

        cache.set(token, user);
        c.set("user", user);
        return next();
    };
}

// ---------------------------------------------------------------------------
// Authorization guards
// ---------------------------------------------------------------------------

/**
 * Asserts the user has an active or trialing subscription.
 * @throws UnauthorizedError (403) otherwise.
 */
export function requireActiveSubscription(user: AuthenticatedUser): void {
    const allowed: SubscriptionStatus[] = ["active", "trialing"];
    if (!allowed.includes(user.subscription)) {
        throw new UnauthorizedError(
            "An active subscription is required to stream video.",
        );
    }
}

/**
 * Asserts the user has the admin role.
 * @throws UnauthorizedError (403) otherwise.
 */
export function requireAdminRole(user: AuthenticatedUser): void {
    if (user.role !== "admin") {
        throw new UnauthorizedError("Admin role is required to upload video.");
    }
}

/**
 * Converts an AuthError thrown by a guard into a Hono JSON response.
 *
 * Usage:
 *   try { requireAdminRole(c.get("user")); }
 *   catch (err) { return authErrorResponse(c, err); }
 */
export function authErrorResponse(c: Context, err: unknown): Response {
    if (err instanceof AuthError) {
        return c.json(
            { error: { code: err.code, message: err.message } },
            err.statusCode,
        );
    }
    return c.json(
        {
            error: {
                code: "INTERNAL_ERROR",
                message: "An unexpected error occurred.",
            },
        },
        500,
    );
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

export function loadAuthConfig(): AuthClientConfig {
    const introspectUrl = process.env["AUTH_INTROSPECT_URL"];
    if (!introspectUrl) {
        throw new Error("[streamforge/auth] AUTH_INTROSPECT_URL is required.");
    }

    const cacheTtlRaw = process.env["AUTH_CACHE_TTL_SEC"];
    const cacheTtlSeconds = cacheTtlRaw ? parseInt(cacheTtlRaw, 10) : 30;
    if (isNaN(cacheTtlSeconds) || cacheTtlSeconds < 0) {
        throw new Error(
            `[streamforge/auth] AUTH_CACHE_TTL_SEC must be a non-negative integer, got: "${cacheTtlRaw}"`,
        );
    }

    return {
        introspectUrl,
        introspectToken: process.env["AUTH_INTROSPECT_TOKEN"],
        cacheTtlSeconds,
        timeoutMs: 5_000,
    };
}
