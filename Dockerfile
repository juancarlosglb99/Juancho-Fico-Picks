# The production image.
#
# Two stages, and the second one is deliberately almost empty. `vinext build`
# with `output: 'standalone'` emits a directory containing the server, its own
# `node_modules`, the built app and `public/` - about 44 MB. Everything else in
# this repository is build-time: Vite, Tailwind, the test suite, the regression
# corpus. None of it belongs in a running container.
#
# What is added on top of the standalone output is the small amount the
# container needs to check itself and migrate:
#
#   scripts/preflight.mjs         refuses to start if the environment is unsafe
#   scripts/migrate.mjs           applies migrations, forward-only, lock-guarded
#   packages/config/requirements.mjs   the one definition of required config
#   packages/db/ssl.mjs           the one rule about when the database needs TLS
#   packages/db/migrations/*.sql  the migrations themselves
#
# The relative paths between those five are preserved, because the scripts
# import each other by relative path and this is not the place to discover that.

# ---------------------------------------------------------------- build
FROM node:22-slim AS build
WORKDIR /src

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM node:22-slim AS runtime

# Production before anything else reads it: the preflight, the health endpoint
# and Better Auth all behave differently here, and all of them should.
ENV NODE_ENV=production
# App Platform overrides this; the default keeps `docker run` usable.
ENV PORT=8080
# The server binds 0.0.0.0 by default. Stated because a container that binds
# loopback passes every local test and is unreachable in production.
ENV HOST=0.0.0.0
ENV MIGRATIONS_DIR=/app/packages/db/migrations

WORKDIR /app

COPY --from=build /src/dist/standalone/ ./
COPY --from=build /src/packages/db/migrations/ ./packages/db/migrations/
COPY --from=build /src/packages/config/requirements.mjs ./packages/config/requirements.mjs
# The one TLS rule, imported by the pool, the migration script and the
# preflight. Without it the preflight and the migration both fail to import.
COPY --from=build /src/packages/db/ssl.mjs ./packages/db/ssl.mjs
COPY --from=build /src/scripts/preflight.mjs ./scripts/preflight.mjs
COPY --from=build /src/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=build /src/scripts/account.mjs ./scripts/account.mjs

# Node's own unprivileged user. Nothing here needs to write to the filesystem.
USER node

EXPOSE 8080

# The health endpoint is the same one App Platform is configured to poll, so a
# container that reports itself unhealthy to Docker reports it to the platform
# too rather than the two disagreeing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Three steps, in this order, and each one can stop the container.
#
#   preflight  a container with no DATABASE_URL must fail loudly rather than
#              fall back to the unsecured single-user mode development uses.
#   migrate    forward-only and guarded by an advisory lock, so it is safe to
#              run on every start and with several instances booting at once.
#              A failed migration stops the container rather than serving
#              against a half-built schema.
#   server     the standalone Node server, on $PORT, bound to 0.0.0.0.
#
# At more than a handful of instances this becomes an App Platform PRE_DEPLOY
# job instead - see DEPLOYMENT.md. For a private beta on one instance, doing it
# here keeps the deployment to a single component.
CMD ["sh", "-c", "node scripts/preflight.mjs && node scripts/migrate.mjs && node server.js"]
