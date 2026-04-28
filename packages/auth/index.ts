import type { Context, MiddlewareHandler, Next } from "hono";
import type {
    AuthenticatedUser,
    SubscriptionStatus,
    UserRole,
} from "@streamforge/types";
import { verify } from "hono/jwt";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AuthError extends Error {
    public readonly code: string;
    public readonly statusCode: 401 | 403;

    constructor(code: string, message: string, statusCode: 401 | 403) {
        super(message);
        this.name = "AuthError";
        this.code = code;
        this.statusCode = statusCode;
    }
}

export class UnauthenticatedError extends AuthError {
    constructor(message: string) {
        super("UNAUTHENTICATED", message, 401);
        this.name = "UnauthenticatedError";
    }
}

export class UnauthorizedError extends AuthError {
    constructor(message: string) {
        super("UNAUTHORIZED", message, 403);
        this.name = "UnauthorizedError";
    }
}

// ---------------------------------------------------------------------------
// Cache
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

    invalidate(token: string): void {
        this.store.delete(token);
    }

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
// Config
// ---------------------------------------------------------------------------

export interface AuthClientConfig {
    /** RS256 public key or HS256 secret used to verify JWTs. */
    publicKey: string;
    cacheTtlSeconds?: number;
    claimMap?: Partial<Record<keyof AuthenticatedUser, string>>;
}

// ---------------------------------------------------------------------------
// Claim normalisation
// ---------------------------------------------------------------------------

const VALID_ROLES = new Set<string>(["admin", "user"]);
const VALID_SUBSCRIPTIONS = new Set<string>([
    "active",
    "inactive",
    "trialing",
    "past_due",
]);

export function normaliseUserProfile(
    raw: Record<string, unknown>,
    claimMap: Partial<Record<keyof AuthenticatedUser, string>> = {},
): AuthenticatedUser {
    const get = (key: keyof AuthenticatedUser) => raw[claimMap[key] ?? key];

    const id = get("id") as string;
    if (!id) {
        throw new UnauthenticatedError("Token is missing the 'id' claim.");
    }

    const email = get("email");
    if (!email || typeof email !== "string") {
        throw new UnauthenticatedError("Token is missing the 'email' claim.");
    }

    const role = get("role");
    if (!role || typeof role !== "string" || !VALID_ROLES.has(role)) {
        throw new UnauthenticatedError(
            `Unrecognised role: "${role}". Expected one of: ${
                [...VALID_ROLES].join(", ")
            }.`,
        );
    }

    const subscription = get("subscription");
    // if (
    //     !subscription || typeof subscription !== "string" ||
    //     !VALID_SUBSCRIPTIONS.has(subscription)
    // ) {
    //     throw new UnauthenticatedError(
    //         `Unrecognised subscription status: "${subscription}".`,
    //     );
    // }

    return {
        id,
        email,
        role: role as UserRole,
        subscription: subscription as SubscriptionStatus,
    };
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

export function extractBearerToken(
    authHeader: string | null | undefined,
): string | null {
    if (!authHeader) return null;
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
    return parts[1] ?? null;
}

// ---------------------------------------------------------------------------
// JWT verification
// ---------------------------------------------------------------------------

export async function verifyJwt(
    token: string,
    config: AuthClientConfig,
): Promise<AuthenticatedUser> {
    let decoded: Record<string, unknown>;

    try {
        decoded = await verify(token, config.publicKey, "HS256") as Record<
            string,
            unknown
        >;
    } catch (err) {
        console.log(err);

        const message = err instanceof Error
            ? err.message.toLowerCase()
            : String(err);
        if (message.includes("expired")) {
            throw new UnauthenticatedError("Token has expired.");
        }
        throw new UnauthenticatedError("Token verification failed.");
    }

    return normaliseUserProfile(decoded, config.claimMap ?? {});
}

// ---------------------------------------------------------------------------
// Hono context
// ---------------------------------------------------------------------------

declare module "hono" {
    interface ContextVariableMap {
        user: AuthenticatedUser;
    }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export interface CreateAuthMiddlewareOptions extends AuthClientConfig {
    optional?: boolean;
}

export function createAuthMiddleware(
    options: CreateAuthMiddlewareOptions,
): MiddlewareHandler {
    const cache = new TokenCache(options.cacheTtlSeconds ?? 30);

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

        const cached = cache.get(token);
        if (cached) {
            c.set("user", cached);
            return next();
        }

        let user: AuthenticatedUser;
        try {
            user = await verifyJwt(token, options);
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
// Guards
// ---------------------------------------------------------------------------

export function requireActiveSubscription(user: AuthenticatedUser): void {
    const allowed: SubscriptionStatus[] = ["active", "trialing"];
    if (!allowed.includes(user.subscription)) {
        throw new UnauthorizedError(
            "An active subscription is required to stream video.",
        );
    }
}

export function requireAdminRole(user: AuthenticatedUser): void {
    if (user.role !== "admin") {
        throw new UnauthorizedError("Admin role is required to upload video.");
    }
}

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
