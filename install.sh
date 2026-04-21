#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# Pesantren Absensi V2 — One-Click Installer
# Tested: Ubuntu 20.04/22.04/24.04, Debian 11/12
# Usage: curl -sSL https://raw.githubusercontent.com/rezaulin/pesantren-v2/main/install.sh | bash
# ──────────────────────────────────────────────────────────
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

# Check root
[[ $EUID -ne 0 ]] && err "Jalankan sebagai root: sudo bash install.sh"

# Config (bisa di-override via env)
REPO_URL="${REPO_URL:-https://github.com/rezaulin/pesantren-v2.git}"
INSTALL_DIR="${INSTALL_DIR:-/root/pesantren-v2}"
DB_NAME="${DB_NAME:-pesantren}"
DB_USER="${DB_USER:-pesantren}"
DB_PASS="${DB_PASS:-pesantren123}"
PORT="${PORT:-3000}"
JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32 2>/dev/null || echo 'change-me-please')}"

echo -e "${CYAN}"
echo "  ┌─────────────────────────────────────┐"
echo "  │   🕌 Pesantren Absensi V2 Installer  │"
echo "  └─────────────────────────────────────┘"
echo -e "${NC}"

# ── Step 1: System Dependencies ──
step "1/6  Install system dependencies"

apt-get update -qq

# Node.js
if command -v node &>/dev/null && node -v | grep -q "^v2[2-9]"; then
    log "Node.js $(node -v) sudah terinstall"
else
    log "Install Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    apt-get install -y nodejs >/dev/null 2>&1
    log "Node.js $(node -v) terinstall"
fi

# MariaDB
if command -v mysql &>/dev/null; then
    log "MariaDB sudah terinstall"
else
    log "Install MariaDB..."
    apt-get install -y mariadb-server >/dev/null 2>&1
    systemctl enable mariadb >/dev/null 2>&1
    systemctl start mariadb
    log "MariaDB terinstall & running"
fi

# PM2
if command -v pm2 &>/dev/null; then
    log "PM2 sudah terinstall"
else
    log "Install PM2..."
    npm install -g pm2 >/dev/null 2>&1
    log "PM2 terinstall"
fi

# Git & build tools
apt-get install -y git build-essential python3 >/dev/null 2>&1

# ── Step 2: Database Setup ──
step "2/6  Setup database MariaDB"

mysql -u root <<SQL
CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
log "Database '${DB_NAME}' & user '${DB_USER}' siap"

# ── Step 3: Clone & Install ──
step "3/6  Clone repo & install dependencies"

if [[ -d "${INSTALL_DIR}" ]]; then
    warn "Direktori ${INSTALL_DIR} sudah ada, pull update..."
    cd "${INSTALL_DIR}"
    git pull origin main 2>/dev/null || true
else
    git clone "${REPO_URL}" "${INSTALL_DIR}" >/dev/null 2>&1
    cd "${INSTALL_DIR}"
fi

log "Install npm dependencies..."
npm install --production >/dev/null 2>&1
log "Dependencies terinstall"

# ── Step 4: Config ──
step "4/6  Konfigurasi environment"

cat > "${INSTALL_DIR}/.env" <<EOF
# Database
DB_HOST=localhost
DB_USER=${DB_USER}
DB_PASS=${DB_PASS}
DB_NAME=${DB_NAME}

# Server
PORT=${PORT}
JWT_SECRET=${JWT_SECRET}
EOF

log ".env dibuat"

# ── Step 5: PM2 Setup ──
step "5/6  Setup PM2 process manager"

cd "${INSTALL_DIR}"
pm2 delete pesantren-v2 2>/dev/null || true
pm2 start server.js --name pesantren-v2 -i 1
pm2 save

# Auto-start on boot
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

log "PM2 configured (auto-start on boot)"

# ── Step 6: Nginx (optional) ──
step "6/6  Nginx reverse proxy"

if command -v nginx &>/dev/null; then
    log "Nginx sudah terinstall, skip"
else
    read -p "Install Nginx reverse proxy? [Y/n]: " install_nginx
    install_nginx=${install_nginx:-Y}
    if [[ "$install_nginx" =~ ^[Yy]$ ]]; then
        apt-get install -y nginx >/dev/null 2>&1

        cat > /etc/nginx/sites-available/pesantren <<NGINX
server {
    listen 80;
    server_name _;

    client_max_body_size 10M;

    location / {
        proxy_pass http://localhost:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX

        ln -sf /etc/nginx/sites-available/pesantren /etc/nginx/sites-enabled/
        rm -f /etc/nginx/sites-enabled/default
        nginx -t 2>/dev/null && systemctl restart nginx
        log "Nginx configured → http://IP_SERVER (port 80)"
    else
        log "Skip Nginx"
    fi
fi

# ── Done! ──
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✅ Instalasi selesai!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  🌐 URL:      ${CYAN}http://$(hostname -I | awk '{print $1}'):${PORT}${NC}"
echo -e "  🔑 Login:    ${YELLOW}admin / admin123${NC}"
echo -e "  📁 Direktori: ${INSTALL_DIR}"
echo -e "  🗄️  Database: ${DB_NAME} (user: ${DB_USER})"
echo ""
echo -e "  ${YELLOW}⚠️  Ganti password admin setelah login pertama!${NC}"
echo ""
echo -e "  Perintah berguna:"
echo -e "    pm2 status          — cek status"
echo -e "    pm2 logs pesantren-v2  — lihat log"
echo -e "    pm2 restart pesantren-v2 — restart"
echo ""
