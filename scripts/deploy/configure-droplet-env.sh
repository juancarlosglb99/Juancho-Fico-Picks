#!/usr/bin/env bash
# Creates /home/<user>/juancho/.env.production with freshly generated secrets.
#
# Run ON THE DROPLET. The two secrets are generated here and never leave the
# machine - they are not typed, not pasted, and not printed, so they exist in
# exactly one place. Re-running preserves whatever is already there: rotating
# BETTER_AUTH_SECRET signs everybody out, and rotating POSTGRES_PASSWORD while
# the database is running locks the app out of its own data.
#
# ANTHROPIC_API_KEY is deliberately NOT set here. It is a secret that already
# exists elsewhere, so it is appended separately over stdin rather than
# regenerated.
#
#   bash configure-droplet-env.sh <domain-or-ip>

set -euo pipefail

DOMAIN="${1:?usage: configure-droplet-env.sh <domain-or-ip>}"
DEPLOY_USER="${DEPLOY_USER:-juancho}"
APP_DIR="/home/${DEPLOY_USER}/juancho"
ENV_FILE="${APP_DIR}/.env.production"

install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 750 "$APP_DIR"

if [ -f "$ENV_FILE" ]; then
	echo "  .env.production already exists - leaving its secrets untouched"
	# Only the domain may change on a re-run; it is not a secret.
	sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" "$ENV_FILE"
	chmod 600 "$ENV_FILE"
	chown "${DEPLOY_USER}:${DEPLOY_USER}" "$ENV_FILE"
	exit 0
fi

# 36 bytes of base64 is 48 characters, comfortably past the 32 the preflight
# requires. `tr -d` keeps the value free of characters that would need quoting
# inside a connection string.
generate() { openssl rand -base64 36 | tr -d '\n=+/' ; }

umask 077
cat > "$ENV_FILE" <<EOF
# Generated on the Droplet $(date -u '+%Y-%m-%d %H:%M:%SZ'). Never committed.
# The two secrets below were generated here and exist nowhere else.

DOMAIN=${DOMAIN}
ACME_EMAIL=admin@${DOMAIN}

# Before a real domain: Caddy's own CA. See Caddyfile.bootstrap.
CADDYFILE=./Caddyfile.bootstrap

APP_IMAGE=juancho-fico-picks:latest

POSTGRES_USER=juancho
POSTGRES_PASSWORD=$(generate)
POSTGRES_DB=juancho

BETTER_AUTH_SECRET=$(generate)

JUANCHO_STRATEGIST_MODEL=claude-opus-5
BACKUP_RETENTION_DAYS=14

# Appended separately, over stdin, so it is never in a command line or a log:
EOF

chmod 600 "$ENV_FILE"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "$ENV_FILE"

echo "  wrote ${ENV_FILE} (600, ${DEPLOY_USER})"
echo "  POSTGRES_PASSWORD and BETTER_AUTH_SECRET generated locally, not printed"
