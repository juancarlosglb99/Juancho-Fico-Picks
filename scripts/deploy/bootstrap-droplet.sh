#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 Droplet: deploy user, SSH hardening, firewall,
# swap, Docker. Run once, as root, on the Droplet.
#
#   scp scripts/deploy/bootstrap-droplet.sh root@<ip>:/tmp/
#   ssh root@<ip> 'bash /tmp/bootstrap-droplet.sh'
#
# Long apt steps are safer run detached from the SSH session, so a dropped
# connection cannot leave dpkg half-applied:
#
#   ssh root@<ip> 'systemd-run --unit=juancho-bootstrap --collect \
#       bash /tmp/bootstrap-droplet.sh'
#   ssh root@<ip> 'journalctl -u juancho-bootstrap -f'
#
# IDEMPOTENT on purpose. A half-applied server is worse than an unconfigured
# one, and the realistic failure here is a dropped connection partway through -
# so every step checks before it acts and running it twice changes nothing.
#
# It does NOT deploy the application. That is a separate step with separate
# failure modes, and mixing them means a Docker hiccup leaves SSH half-hardened.

set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-juancho}"
SWAP_SIZE="${SWAP_SIZE:-2G}"

log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
skip() { printf '    \033[2m%s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run this as root." >&2; exit 1; }

# --------------------------------------------------------------- deploy user
log "Deploy user: ${DEPLOY_USER}"
if id -u "$DEPLOY_USER" >/dev/null 2>&1; then
	skip "already exists"
else
	adduser --disabled-password --gecos "" "$DEPLOY_USER"
	usermod -aG sudo "$DEPLOY_USER"
fi

# The key that got us here is the key that should get us back in as the
# non-root user. Without this, hardening SSH locks everybody out.
if [ -f /root/.ssh/authorized_keys ]; then
	install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh"
	install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" \
		/root/.ssh/authorized_keys "/home/${DEPLOY_USER}/.ssh/authorized_keys"
	skip "copied root's authorized_keys to ${DEPLOY_USER}"
else
	echo "    WARNING: /root/.ssh/authorized_keys is missing." >&2
	echo "    Not hardening SSH - doing so now would lock you out." >&2
	SKIP_SSH_HARDENING=1
fi

# ------------------------------------------------------------ SSH hardening
log "SSH: keys only"
if [ "${SKIP_SSH_HARDENING:-0}" = "1" ]; then
	skip "skipped, see warning above"
else
	sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
	sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
	sed -i 's/^#\?KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config
	# DigitalOcean images ship drop-ins that re-enable passwords and win by
	# being read last. Editing only sshd_config leaves passwords on.
	if [ -d /etc/ssh/sshd_config.d ]; then
		# `|| true` because grep exits 1 when it finds nothing - which is
		# exactly what happens on the SECOND run, once the drop-ins are already
		# fixed. Under `set -o pipefail` that failure propagates and kills the
		# script, so the "idempotent" script was idempotent only until it had
		# actually done its job. It cost a debugging round to notice.
		grep -rl 'PasswordAuthentication yes' /etc/ssh/sshd_config.d/ 2>/dev/null \
			| xargs -r sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' || true
	fi
	# Validate before applying: a syntax error here ends the deployment.
	sshd -t
	# RELOAD, not restart. `systemctl restart ssh` tears down the cgroup that
	# the calling SSH session lives in - which kills this script mid-run, and
	# did. A reload makes sshd re-read its configuration and leaves established
	# sessions alone.
	systemctl reload ssh
	skip "password and keyboard-interactive login disabled"
fi

# ----------------------------------------------------------------- firewall
log "Firewall: 22, 80, 443 only"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw >/dev/null
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null   # HTTP/3
ufw --force enable >/dev/null
ufw status verbose | sed 's/^/    /'

# --------------------------------------------------------------------- swap
log "Swap: ${SWAP_SIZE}"
if swapon --show | grep -q '/swapfile'; then
	skip "already active"
else
	fallocate -l "$SWAP_SIZE" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
	chmod 600 /swapfile
	mkswap /swapfile >/dev/null
	swapon /swapfile
	grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
# Prefer RAM; swap is the safety net that turns an OOM kill into a slow minute.
sysctl -qw vm.swappiness=10
grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
free -h | sed 's/^/    /'

# ------------------------------------------------------------------- docker
log "Docker"
if command -v docker >/dev/null 2>&1; then
	skip "already installed"
else
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl >/dev/null
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
	chmod a+r /etc/apt/keyrings/docker.asc
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
		> /etc/apt/sources.list.d/docker.list
	apt-get update -qq
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
		docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
usermod -aG docker "$DEPLOY_USER"
# Docker must come back after a reboot, or the site does not.
systemctl enable --now docker >/dev/null
docker --version | sed 's/^/    /'
docker compose version | sed 's/^/    /'

# ------------------------------------------------------- unattended upgrades
log "Unattended security upgrades"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades >/dev/null
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
skip "enabled"

log "Done."
cat <<EOF

    Verify from your laptop BEFORE closing this session - if the key did not
    carry over, this is the moment to find out:

      ssh ${DEPLOY_USER}@\$(curl -s ifconfig.me) 'docker ps && free -m'

    Then deploy the application: see DEPLOYMENT.md section 4.
EOF
