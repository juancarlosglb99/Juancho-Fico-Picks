'use client';

/**
 * The browser half of Better Auth.
 *
 * Talks to `/api/auth`, holds nothing of its own, and knows nothing about
 * plans. A session here is a cookie the server will verify again on every
 * request that matters - what this client believes affects what it draws and
 * nothing else.
 */
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({ basePath: '/api/auth' });

/*
 * `requestPasswordReset` rather than the older `forgetPassword`: Better Auth
 * renamed it, and the old name is gone from the typed surface in 1.7.
 */
export const { signIn, signUp, signOut, requestPasswordReset, resetPassword, useSession } =
  authClient;
