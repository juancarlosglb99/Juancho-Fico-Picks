/**
 * The auth instance. Server only, and never reachable from a browser bundle.
 *
 * Built lazily for the same reason the database pool is: this application has
 * to start, render a draft board and answer a recommendation with no database
 * and no secret configured. Accounts are a layer over a product that works
 * without them, not a gate in front of one that does not.
 *
 * Nothing here trusts the client. A session comes from a signed cookie that
 * Better Auth verifies against a row in our own database; a plan comes from a
 * different row. There is no code path by which either arrives in a request
 * body.
 */
import { betterAuth } from 'better-auth';
import { getPool, databaseConfigured } from '../db/client';
import { resetPasswordEmail, resolveMailSender, verificationEmail } from './email';

let instance: Auth | null = null;
let configurationError: string | null = null;

/** One hour, matching what the reset email promises. */
const RESET_TOKEN_SECONDS = 60 * 60;
/** Long enough that a drafter is not signed out mid-season. */
const SESSION_SECONDS = 60 * 60 * 24 * 30;
/** How often a live session is quietly extended. */
const SESSION_REFRESH_SECONDS = 60 * 60 * 24;

export function authBaseUrl(): string {
  return (
    process.env.BETTER_AUTH_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    'http://localhost:3000'
  );
}

function authSecret(): string | null {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

/**
 * Why accounts are unavailable, if they are.
 *
 * Returned rather than thrown so a health check and a diagnostics panel can
 * report the reason instead of a stack trace.
 */
export function authUnavailableReason(): string | null {
  if (!databaseConfigured()) return 'DATABASE_URL is not set.';
  if (!authSecret()) {
    return 'BETTER_AUTH_SECRET is not set, or is shorter than 32 characters.';
  }
  return configurationError;
}

export function authConfigured(): boolean {
  return authUnavailableReason() === null;
}

export function getAuth(): Auth | null {
  if (!authConfigured()) return null;
  if (instance) return instance;

  try {
    instance = createAuth();
    configurationError = null;
    return instance;
  } catch (error) {
    configurationError =
      error instanceof Error ? error.message : 'Auth could not be initialised.';
    instance = null;
    return null;
  }
}

/*
 * Declared as its own function so the instance type can be DERIVED from the
 * options rather than widened to `Auth<BetterAuthOptions>` - Better Auth's types
 * are parameterised by the exact configuration, and a widened alias is not
 * assignable back to the narrow one.
 */
function createAuth() {
  const mail = resolveMailSender();
  return betterAuth({
    database: getPool(),
    secret: authSecret()!,
    baseURL: authBaseUrl(),
    basePath: '/api/auth',
    trustedOrigins: [authBaseUrl()],

    emailAndPassword: {
      enabled: true,
      /*
       * Off by default so a developer can sign up without an email provider.
       * A deployment that has one turns it on, and the flow is already built.
       */
      requireEmailVerification:
        process.env.AUTH_REQUIRE_EMAIL_VERIFICATION === 'true',
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: RESET_TOKEN_SECONDS,
      sendResetPassword: async ({ user, url }) => {
        await mail.send(resetPasswordEmail(user.email, url));
      },
    },

    emailVerification: {
      /*
       * Off while the beta is private. There is no email provider, and a
       * "verification" that writes a token to the server log is worse than
       * none. The flow itself is built and unchanged: turning
       * AUTH_REQUIRE_EMAIL_VERIFICATION on is the whole change when
       * registration opens to the public.
       */
      sendOnSignUp: process.env.AUTH_REQUIRE_EMAIL_VERIFICATION === 'true',
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await mail.send(verificationEmail(user.email, url));
      },
    },

    session: {
      expiresIn: SESSION_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
    },

    advanced: {
      // Set by the platform in production; http in local development.
      useSecureCookies: authBaseUrl().startsWith('https://'),
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true },
    },

    // Social login is deliberately absent: it is not free after the base
    // implementation, it needs its own consent and redirect handling, and
    // nothing in v1 wants it.
  });
}

export type Auth = ReturnType<typeof createAuth>;

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
}

/**
 * Who is making this request, according to the cookie they sent and our own
 * database. Null for anybody else, including a request carrying a forged one.
 */
export async function currentUser(request: Request): Promise<SessionUser | null> {
  const auth = getAuth();
  if (!auth) return null;
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return null;
    return {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name ?? null,
      emailVerified: Boolean(session.user.emailVerified),
    };
  } catch {
    return null;
  }
}
