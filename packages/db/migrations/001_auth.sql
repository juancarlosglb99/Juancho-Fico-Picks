-- Better Auth's own tables.
--
-- NOT hand-authored, and not to be hand-edited: the adapter addresses these
-- columns by exact name and case, so a well-meant rename to snake_case breaks
-- sign-in with an error that points somewhere else entirely.
--
-- Generated from the INSTALLED LIBRARY rather than from `@better-auth/cli`.
-- That distinction cost an afternoon: the published CLI lags the library - it
-- stops at 1.5.0-beta while `better-auth` is at 1.7.2 - and the schema it
-- produced was missing `account.issuer`, which the running adapter requires.
-- Sign-up failed with `column "issuer" of relation "account" does not exist`,
-- from a stack trace three layers inside Kysely.
--
-- `npm run db:check` regenerates the diff against the live database and fails
-- if the library wants anything this file does not have, which is the guard
-- that turns the next version bump into a red build instead of a broken login.
--
-- The application's own tables are in 002 and follow ordinary Postgres
-- conventions. The seam between the two is deliberate.

create table if not exists "user" (
  "id" text not null primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" boolean not null,
  "image" text,
  "createdAt" timestamptz default current_timestamp not null,
  "updatedAt" timestamptz default current_timestamp not null
);

create table if not exists "session" (
  "id" text not null primary key,
  "expiresAt" timestamptz not null,
  "token" text not null unique,
  "createdAt" timestamptz default current_timestamp not null,
  "updatedAt" timestamptz not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user" ("id") on delete cascade
);

create table if not exists "account" (
  "id" text not null primary key,
  "issuer" text not null,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz default current_timestamp not null,
  "updatedAt" timestamptz not null
);

create table if not exists "verification" (
  "id" text not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz default current_timestamp not null,
  "updatedAt" timestamptz default current_timestamp not null
);

create unique index if not exists "account_issuer_accountId_uidx"
  on "account" ("issuer", "accountId");
create index if not exists "session_userId_idx" on "session" ("userId");
create index if not exists "account_userId_idx" on "account" ("userId");
create index if not exists "verification_identifier_idx" on "verification" ("identifier");
