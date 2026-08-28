# Deploying to DigitalOcean

Target: **App Platform** (container) + **PostgreSQL**. Everything below has been
verified against the actual build output except where it says otherwise.

The one thing to understand before starting: **production refuses to run
unconfigured.** With no `DATABASE_URL` this application is perfectly capable of
serving a draft room with no accounts and no authorisation — correct on a
laptop, an unsecured public application on the internet. So the container runs
`scripts/preflight.mjs` before the server and exits non-zero if anything
mandatory is missing, and `/api/health` fails a production instance for the same
reasons. A misconfigured deploy never gets promoted.

---

## 1. Create the app

```bash
doctl apps create --spec .do/app.yaml
```

Or paste the same settings in the dashboard. The spec is committed at
[`.do/app.yaml`](.do/app.yaml); every account-specific value is marked
`CHANGE ME`.

### Settings that matter

| Setting | Value | Why |
|---|---|---|
| Build | **Dockerfile**, not the Node buildpack | The build output is `vinext`'s standalone directory. The buildpack would run `npm start` against a tree it had pruned dev dependencies from, and fail at boot rather than at build. |
| `http_port` | `8080` | The server reads `$PORT` and binds `0.0.0.0`. App Platform sets `PORT`; the Dockerfile's `8080` is only the default for `docker run`. |
| Health check path | `/api/health` | Strict in production: fails unless the environment is complete, the database answers and the schema is current. |
| Health check initial delay | `30s` | The container migrates before it serves. |
| Instance | `apps-s-1vcpu-1gb` | The recommendation engine runs in the browser, so the server does SSR and route handlers only — but Node plus the bundle is not comfortable in 512 MB, and an out-of-memory restart mid-draft is the worst failure this product has. |
| Instances | `1` | A private beta. Migrations are advisory-locked, so more is safe when needed. |

### If you already created an App Platform shell

Check these four, which are the ones a default Node app gets wrong:

1. **Build method is Dockerfile.** A buildpack app must be changed, not patched.
2. **Run command is not set.** The Dockerfile's `CMD` does preflight → migrate →
   serve. An App Platform run command silently replaces all three.
3. **HTTP port is 8080**, not 3000.
4. **Health check path is `/api/health`**, not `/`. `/` returns 200 from an
   instance with no database; the health endpoint does not.

---

## 2. The database

**For the private beta: a Dev Database.** One node, no failover, ~$7/month.
Attach it as a component named `db` so `${db.DATABASE_URL}` resolves.

Move to a managed cluster (`production: true` in the spec) when any of these
becomes true: real users would notice an hour of downtime, the data is worth
point-in-time recovery, or you need more than one instance.

Either way, copy the **CA certificate** from the database's Connection Details
into `DATABASE_CA_CERT`. Without it the pool falls back to the system trust
store, which a managed provider may not be in. The alternative
(`DATABASE_SSL_INSECURE=true`) encrypts the connection against nobody in
particular, and the preflight refuses it in production.

**Pooling.** One pool per instance, capped by `DATABASE_POOL_MAX` (default 8),
created on first use rather than at import. Several instances share one
database's ceiling, so this is deliberately well below it — a dev database
allows about 22 connections, and 8 leaves room for the migration client and a
`psql` session.

---

## 3. Environment variables

Set these in the App Platform dashboard under the **web** component.

### Required — the app will not start without them

| Variable | Encrypted | Value |
|---|---|---|
| `DATABASE_URL` | yes (bound) | `${db.DATABASE_URL}` — App Platform substitutes it |
| `BETTER_AUTH_SECRET` | **yes** | 32+ random characters. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `BETTER_AUTH_URL` | no | The https origin, e.g. `https://picks.example.com`. **Must be https** — the health check fails a production instance otherwise, because session cookies would not be marked `Secure`. |
| `NODE_ENV` | no | `production`. Set by the Dockerfile; setting it again is harmless. |

### Recommended

| Variable | Encrypted | Value |
|---|---|---|
| `DATABASE_CA_CERT` | **yes** | The managed database's CA certificate, PEM |
| `ANTHROPIC_API_KEY` | **yes** | The strategist. Without it, drafts run on the deterministic engine and the UI says so. |
| `JUANCHO_STRATEGIST_MODEL` | no | `claude-opus-5` |
| `DATABASE_POOL_MAX` | no | `8` |

### Never set in production

| Variable | Why |
|---|---|
| `AI_ALLOW_WITHOUT_ACCOUNTS` | Authorises AI spending with no account behind it. The preflight **refuses to start** if it finds this set. |
| `DATABASE_SSL_INSECURE` | Encrypts without verifying. The preflight refuses this too. |
| `AUTH_REQUIRE_EMAIL_VERIFICATION` | Not until there is an email provider. Turning it on with none configured makes production refuse to send rather than silently drop verification mail — which locks new users out. |

Everything marked **Encrypted** must be an App Platform *encrypted* variable.
None of them is ever logged, returned in a response, or included in a client
bundle; `/api/health` reports only whether each is present.

---

## 4. First deploy, and your admin account

Migrations run automatically as the container starts — forward-only,
advisory-locked, and a failure stops the container rather than serving against a
half-built schema. There is nothing to run by hand.

**The beta's access control is you.** Registering creates an account with *no
entitlement*; the person sees a "waiting for activation" screen, not the
product. You activate it.

```bash
# 1. Deploy, then register through the app at https://your-app/ like anyone else.

# 2. From your laptop, against the production database:
export DATABASE_URL='<the connection string from the DO dashboard>'

npm run account -- admin you@example.com     # full access, AI, no credits consumed
npm run account -- show  you@example.com     # confirm
```

Then for each beta user, after they register:

```bash
npm run account -- plan    them@example.com basic   # engine + First Seed, no AI
npm run account -- plan    them@example.com pro     # + the AI strategist
npm run account -- credits them@example.com 5       # 5 AI drafts
```

A credit buys a **draft**, not a request: once a draft has spent one, it keeps
answering for the whole draft even if the balance hits zero mid-way.

**Admin** has full access and AI, consumes no credits, and **is still logged** —
every call writes an `ai_usage` row with its cost, so your own usage is
measurable.

---

## 5. Verifying a deploy

```bash
curl -s https://your-app/api/health | jq
```

A healthy production instance:

```json
{
  "status": "ok",
  "environment": "production",
  "database": { "configured": true, "reachable": true, "schema": "current" },
  "auth": { "configured": true, "reason": null },
  "strategist": { "configured": true },
  "configuration": { "problems": [], "warnings": [] }
}
```

`schema` is three-valued on purpose. `unknown` means the migration files could
not be found — which says nothing about the database and must never be read as
"current".

Then, by hand:

1. **Auth** — register, sign out, sign in, request a password reset.
2. **Activation** — a fresh account sees the pending screen, not the product.
3. **Sleeper** — connect a username, pick a league, reach the Verify screen.
4. **Deterministic draft** — enter a room and confirm a recommendation appears.
   This must work whether or not the strategist is configured.
5. **AI route** — for a Basic account, confirm the card shows the quiet "part of
   Pro" line and that no credit was consumed.

---

## 6. Custom domain and HTTPS

Add the domain under **Settings → Domains**. App Platform issues and renews a
Let's Encrypt certificate automatically; there is nothing to configure and
**nothing to put in front of it**. Then update `BETTER_AUTH_URL` to the new
origin and redeploy — session cookies and any email links are scoped to it, and
the old value will silently break sign-in on the new domain.

---

## Operating notes

**Upgrading Better Auth.** Its tables are generated, and the published CLI lags
the library — generating with `@better-auth/cli@latest` against `better-auth@1.7.2`
produced a schema missing `account.issuer`, and sign-up failed inside Kysely with
an error naming neither. After any upgrade:

```bash
DATABASE_URL='...' npm run db:check
```

It asks the *installed library* what it would still need to add and fails if the
answer is anything at all. Add what it prints as a new migration.

**Logs.** `doctl apps logs <app-id> --type run --follow`. The strategist logs
model and token counts, never the key or a prompt.

**Rolling back.** App Platform keeps previous deployments; redeploy one from the
Activity tab. Migrations are forward-only — there are no `down` scripts, because
one that has never been run is not a rollback plan. Recovering the database is a
restore.

**What is not here.** No payments, no email provider, no Cloudflare. The
Cloudflare Workers toolchain this project was scaffolded with has been removed
entirely: it ran route handlers in workerd, which has no TCP sockets and so no
Postgres.
