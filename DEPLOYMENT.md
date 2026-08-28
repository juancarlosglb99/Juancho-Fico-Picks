# Deploying

**Private beta: one DigitalOcean Droplet.** Caddy, the app and PostgreSQL in
Docker Compose on a single $6/month machine. That is what the rest of this
document describes.

App Platform and a managed database remain a supported scaling path, and the
spec for it is still committed at [`.do/app.yaml`](.do/app.yaml) — see
[Scaling up](#scaling-up) at the end. It costs about three times as much and
buys things a twenty-person beta does not need yet.

```
internet ──▶ Caddy :80/:443 ──▶ app :8080 ──▶ postgres :5432
             (HTTPS, auto)      (no public    (no public port at all)
                                 port)
```

Two rules hold everything together:

1. **The image is built elsewhere.** A 1 GB machine running Postgres has no
   business also running a Vite build, and a build that runs out of memory
   halfway leaves you serving nothing. GitHub Actions builds it; the Droplet
   pulls it.
2. **Production refuses to run unconfigured.** With no `DATABASE_URL` this
   application serves a perfectly functional draft room with no accounts and no
   authorisation — correct on a laptop, an unsecured public application on the
   internet. The container's preflight exits non-zero, and `/api/health` fails
   a production instance for the same reasons.

---

## 1. The Droplet

| | |
|---|---|
| Type | **Basic — Regular (shared CPU)** |
| Size | **1 vCPU / 1 GB / 25 GB SSD — $6/month** |
| Image | **Ubuntu 24.04 (LTS) x64** |
| Region | Nearest your users. `NYC3` or `SFO3` for the United States |
| Options | ✅ **Monitoring** (free). ❌ Backups (+20%; we do `pg_dump` instead — see [Backups](#5-backups)) |
| Authentication | **SSH key.** Not a password |

### Is 1 GB enough? Measured, not assumed

| | Memory |
|---|---|
| App, idle | **71 MB** |
| App, after 120 concurrent requests | **120 MB** |
| PostgreSQL, tuned as configured here | ~200 MB |
| Caddy | ~25 MB |
| Docker daemon + Ubuntu | ~230 MB |
| **Total** | **~600 MB of ~960 MB usable** |

The app is small because the recommendation engine runs **in the browser** — the
server does SSR and route handlers only.

That leaves real headroom, but not a lot of it, so two things are configured
rather than hoped for: `NODE_OPTIONS=--max-old-space-size=320` caps V8 so a
heavy render cannot grow into the memory Postgres needs and get the wrong
process OOM-killed, and Postgres is tuned down from defaults that assume it owns
the machine. **Add the swap file in §2** — it costs nothing and turns a
worst-case OOM kill into a slow minute.

Move to the 2 GB Droplet when `free -m` shows swap in steady use or the app
container is being restarted by the OOM killer — not before.

---

## 2. First SSH setup

Run these once, as `root`, from the console or `ssh root@<droplet-ip>`.

```bash
# --- a user that is not root ----------------------------------------------
adduser --disabled-password --gecos "" juancho
usermod -aG sudo juancho
rsync --archive --chown=juancho:juancho ~/.ssh /home/juancho

# --- SSH: keys only -------------------------------------------------------
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#\?KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config
# DigitalOcean images sometimes re-enable passwords in a drop-in. Check.
grep -rl 'PasswordAuthentication yes' /etc/ssh/sshd_config.d/ 2>/dev/null | xargs -r sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/'
sshd -t && systemctl restart ssh

# --- firewall: 22, 80, 443 and nothing else -------------------------------
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp     # HTTP/3
ufw --force enable

# --- swap: 2 GB, so a memory spike is slow rather than fatal --------------
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
# Prefer RAM; use swap as the safety net it is.
sysctl -w vm.swappiness=10
echo 'vm.swappiness=10' >> /etc/sysctl.conf

# --- docker ----------------------------------------------------------------
apt-get update && apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker juancho

# --- unattended security updates ------------------------------------------
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades
```

Then confirm, **from your laptop, before closing the root session**:

```bash
ssh juancho@<droplet-ip> 'docker --version && free -m && sudo ufw status'
```

Note that **UFW does not filter Docker's published ports** — Docker writes its
own iptables rules. That is fine here, because the only published ports are
Caddy's 80 and 443, which UFW allows anyway. It is also why `db` has no `ports:`
entry: Postgres is unreachable from outside because it is never published, not
because a firewall rule is stopping it.

---

## 3. DNS

At your registrar, point the domain at the Droplet:

| Type | Name | Value | TTL |
|---|---|---|---|
| `A` | `@` (or `picks`) | the Droplet's IPv4 | 300 |
| `AAAA` | same | the Droplet's IPv6 *(optional)* | 300 |

```bash
dig +short picks.example.com     # must return the Droplet's IP before you start Caddy
```

Then nothing else. **Caddy obtains and renews the certificate itself** the
moment DNS resolves and ports 80/443 are open. No certbot, no cron, and nothing
in front of it — no Cloudflare proxy, which would break the HTTP-01 challenge
unless you also configure DNS-01.

If a certificate does not appear, it is almost always DNS not yet propagated or
port 80 closed. `docker compose -f docker-compose.prod.yml logs caddy` says
which. To iterate without burning Let's Encrypt rate limits, uncomment the
staging CA line in the [`Caddyfile`](Caddyfile).

---

## 4. First deployment

### 4.1 Publish the image

> **One-time step first.** The workflow file exists at
> `.github/workflows/publish-image.yml` but is **not yet committed** — pushing
> files under `.github/workflows/` needs GitHub's `workflow` OAuth scope, which
> the assistant's token does not have. Add it with your own credentials:
>
> ```bash
> git add .github/workflows/publish-image.yml
> git commit -m "Add the image publish workflow"
> git push
> ```

Push to `main`, or run **Actions → Publish image → Run workflow**. It runs lint,
types and the unit suite first, then builds and pushes to
`ghcr.io/<owner>/juancho-fico-picks`.

If the package is **private**, let the Droplet read it once:

```bash
# On GitHub: Settings → Developer settings → Personal access tokens (classic)
#            scope: read:packages
echo '<token>' | docker login ghcr.io -u <github-username> --password-stdin
```

Making the package **public** avoids that step and any storage quota. The image
contains no secrets — they all arrive as environment variables — but it does
contain the built server. Your call.

### 4.2 Put the deployment files on the Droplet

```bash
ssh juancho@<droplet-ip>
mkdir -p ~/juancho && cd ~/juancho

# Only four files are needed. The application itself is in the image.
curl -O https://raw.githubusercontent.com/<owner>/Juancho-Fico-Picks/main/docker-compose.prod.yml
curl -O https://raw.githubusercontent.com/<owner>/Juancho-Fico-Picks/main/Caddyfile
mkdir -p scripts
curl -o scripts/backup.sh https://raw.githubusercontent.com/<owner>/Juancho-Fico-Picks/main/scripts/backup.sh
curl -o .env.production.example https://raw.githubusercontent.com/<owner>/Juancho-Fico-Picks/main/.env.production.example
```

*(A private repo: `git clone` it instead, or `scp` the four files up.)*

### 4.3 Configure

```bash
cp .env.production.example .env.production
chmod 600 .env.production

# Generate the two secrets ON THE MACHINE, so they are never in your shell
# history, a chat window or a password manager's clipboard.
echo "POSTGRES_PASSWORD=$(openssl rand -base64 36)"
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 36)"

nano .env.production     # paste those, set DOMAIN, ACME_EMAIL, APP_IMAGE, ANTHROPIC_API_KEY
```

### 4.4 Start

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
docker compose -f docker-compose.prod.yml --env-file .env.production ps
```

Migrations run automatically as the app container starts — forward-only,
advisory-locked, and a failure stops the container rather than serving against a
half-built schema. There is nothing to run by hand.

Watch it come up:

```bash
docker compose -f docker-compose.prod.yml logs -f app
curl -s https://picks.example.com/api/health | jq
```

A healthy instance:

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

`schema` is three-valued on purpose: `unknown` means the migration files could
not be found, which says nothing about the database and must never read as
"current".

### 4.5 Your admin account

Access in the private beta is a person, not a payment. Registering creates an
account with **no entitlement** and a "waiting for activation" screen.

```bash
# 1. Register through the app at https://picks.example.com, like anyone else.

# 2. Activate yourself, from inside the app container:
cd ~/juancho
docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec app node scripts/account.mjs admin you@example.com
```

**That is the safe way to run the account tool, and it is the only one you
need.** The command runs inside the app container, which already holds
`DATABASE_URL` and sits on the internal network — so the database stays
unpublished, nothing is installed on the host, and no credentials pass through
your shell.

The same command for everyone else, once they have registered:

```bash
DC="docker compose -f docker-compose.prod.yml --env-file .env.production exec app node scripts/account.mjs"

$DC plan    them@example.com basic   # engine + First Seed, no AI
$DC plan    them@example.com pro     # + the AI strategist
$DC credits them@example.com 5       # 5 AI drafts
$DC show    them@example.com
```

A credit buys a **draft**, not a request: a draft that has spent one keeps
answering to the end even if the balance hits zero mid-way. **Admin** has full
access and AI, consumes no credits, and is **still logged** — every call writes
an `ai_usage` row with its cost.

### 4.6 Later deployments

```bash
cd ~/juancho
docker compose -f docker-compose.prod.yml --env-file .env.production pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
docker image prune -f
```

To roll back, set `APP_IMAGE` to the previous `sha-…` tag and run the same two
commands. Migrations are forward-only, so a rollback across a migration needs a
database restore as well.

---

## 5. Backups

**Mandatory here**, because the app and the database are on one machine. A
sidecar container takes a `pg_dump` daily at 03:00 UTC and keeps 14 days.

It takes one **immediately on start** as well — a backup job whose first run is
tomorrow morning is one nobody has ever seen work, and the first day is when a
deployment is most likely to need it.

```bash
# What exists
docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec backup ls -lh /backups

# Take one right now, before anything risky
docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec backup sh -c 'pg_dump --no-owner --no-privileges --clean --if-exists | gzip -9 > /backups/manual-$(date -u +%Y-%m-%d_%H%M).sql.gz'

# Copy one to your laptop
docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec -T backup cat /backups/juancho-2026-08-28_0300.sql.gz > ./juancho-backup.sql.gz
```

### Restoring

Verified end to end: the dump restores all tables **and** `schema_migration`, so
the app does not re-run migrations against restored data.

```bash
cd ~/juancho

# 1. Stop the app so nothing writes while you restore. Leave the database up.
docker compose -f docker-compose.prod.yml --env-file .env.production stop app

# 2. Restore. The dump is --clean --if-exists, so it drops and recreates.
docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec -T backup sh -c 'gunzip -c /backups/juancho-2026-08-28_0300.sql.gz | psql -v ON_ERROR_STOP=1'

# 3. Start it again, and confirm.
docker compose -f docker-compose.prod.yml --env-file .env.production start app
curl -s https://picks.example.com/api/health | jq .database
```

To restore from a dump on your laptop, `docker compose cp` it into the backup
container first.

### A second copy, off the machine

Not set up, because it needs paid storage. When it is worth it, the smallest
step is a nightly `rsync` of `/backups` to another host you already pay for, or
`rclone` to DigitalOcean Spaces (~$5/month for 250 GB). Until then the dumps
live on the same disk as the database they protect — which covers a bad
migration or a mistaken `DELETE`, and does **not** cover losing the Droplet.
Pull a copy down by hand before anything risky.

---

## 6. Security checklist

| | Where |
|---|---|
| SSH keys only, passwords disabled | §2, and re-check `sshd_config.d/` |
| Firewall allows only 22, 80, 443 | §2 (`ufw status`) |
| Postgres has no public port | `docker-compose.prod.yml` — `db` has no `ports:` at all |
| App has no public port | `expose: 8080` only; Caddy is the sole way in |
| HTTPS, renewed automatically | Caddy, §3 |
| Anthropic key server-side only | Env on the `app` service; never in a bundle, log or response |
| Better Auth secret server-side only | Same. Rotating it signs everybody out |
| Sign-in required in production | The preflight refuses to start without `DATABASE_URL` and `BETTER_AUTH_SECRET` |
| No insecure single-user fallback | `AI_ALLOW_WITHOUT_ACCOUNTS` is **refused** in production |
| Secrets not in the repo | `.env.production` is `chmod 600` on the Droplet and gitignored |

---

## Known issue: First Seed publishes fewer players than it did

**Investigated, and it is the source, not our importer.**

| Date | Ranked | WR | RB | QB | TE |
|---|---|---|---|---|---|
| 2026-08-13 (committed snapshot) | 213 | 87 | 73 | 27 | 26 |
| **2026-08-28 (live)** | **192** | 77 | 63 | 27 | 25 |

Our mapping loses **nothing**: 192 rows in, 192 matched, 0 unmatched — and the
same result when matching against every player Sleeper has ever known, so the
eligibility rule is not involved either. First Seed has trimmed 21 players from
the deepest skill positions, which is ordinary editorial pruning as the season
approaches.

`tests/smoke/real-first-seed.smoke.ts` asserts `matched >= 200` and therefore
fails. **The assertion has deliberately not been relaxed** — it is doing its job
by telling us the board moved.

What it means for a draft: a 12-team, 15-round draft is 180 selections, and 192
ranked skill players plus 72 K/DST from FantasyPros covers it. A **14-team or
16-round** league would run past the end of First Seed's board in the closing
rounds, where the engine has no consensus to anchor to and falls back to its own
projection order. Worth watching before running a deeper league.

---

## Operating notes

**Logs.** `docker compose -f docker-compose.prod.yml logs -f app`. The
strategist logs model and token counts, never the key or a prompt.

**Upgrading Better Auth.** Its tables are generated, and the published CLI lags
the library — generating with `@better-auth/cli@latest` against
`better-auth@1.7.2` produced a schema missing `account.issuer`, and sign-up
failed inside Kysely with an error naming neither. After any upgrade, run
`npm run db:check` against a database with the new schema; it asks the installed
library what it would still need and fails if the answer is anything at all.

**Moving Postgres off the box.** The application only ever reads `DATABASE_URL`.
Set it directly on the `app` service, drop the `db` and `backup` services, and
add `DATABASE_CA_CERT` for the managed provider's certificate. Nothing in the
application changes.

<a id="scaling-up"></a>
## Scaling up: App Platform and a managed database

[`.do/app.yaml`](.do/app.yaml) is a working App Platform specification, kept for
when the beta stops being one. It costs roughly $19/month against this $6, and
what it buys is: no machine to patch, zero-downtime deploys, a database with
failover and point-in-time recovery, and horizontal scaling.

Worth moving when any of these becomes true — and not before:

- an hour of downtime would matter to somebody
- the data is worth point-in-time recovery rather than a nightly dump
- one instance is not enough, or you want deploys with no gap
- `free -m` shows swap in steady use on the Droplet

The application is the same image either way.
