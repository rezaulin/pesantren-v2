# Panduan Instalasi Pesantren Absensi V2

Persyaratan: Ubuntu 20.04+ / Debian 11+, minimal 1GB RAM, 10GB disk.

## One-Click Install

```bash
curl -sSL https://raw.githubusercontent.com/rezaulin/pesantren-v2/main/install.sh | bash
```

Script akan otomatis:
- Install Node.js 22, MariaDB, PM2
- Clone repo & install dependencies
- Buat database + tabel
- Setup PM2 process
- Config Nginx (opsional)

Setelah install, buka `http://IP_SERVER:3000`

**Default login:** admin / admin123

---

## Manual Install

### 1. Install Dependencies

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# MariaDB
apt install -y mariadb-server
systemctl enable mariadb
systemctl start mariadb

# PM2
npm install -g pm2
```

### 2. Setup Database

```bash
mysql -u root <<'SQL'
CREATE DATABASE IF NOT EXISTS pesantren CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'pesantren'@'localhost' IDENTIFIED BY 'pesantren123';
GRANT ALL PRIVILEGES ON pesantren.* TO 'pesantren'@'localhost';
FLUSH PRIVILEGES;
SQL
```

### 3. Clone & Install

```bash
git clone https://github.com/rezaulin/pesantren-v2.git /root/pesantren-v2
cd /root/pesantren-v2
npm install
```

### 4. Config Environment

```bash
cat > /root/pesantren-v2/.env <<'EOF'
DB_HOST=localhost
DB_USER=pesantren
DB_PASS=pesantren123
DB_NAME=pesantren
PORT=3000
JWT_SECRET=ubah-ini-dengan-random-string
EOF
```

### 5. Start Server

```bash
cd /root/pesantren-v2
pm2 start server.js --name pesantren-v2
pm2 save
pm2 startup
```

### 6. Nginx Reverse Proxy (Opsional)

```bash
apt install -y nginx

cat > /etc/nginx/sites-available/pesantren <<'NGINX'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/pesantren /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
```

---

## Management Commands

```bash
# Status
pm2 status

# Restart
pm2 restart pesantren-v2

# Logs
pm2 logs pesantren-v2

# Stop
pm2 stop pesantren-v2

# Backup database
mysqldump -u root pesantren > backup.sql

# Restore database
mysql -u root pesantren < backup.sql
```

---

## Struktur Database

17 tabel otomatis dibuat saat server pertama kali jalan:

| Tabel | Fungsi |
|-------|--------|
| users | Akun admin/ustadz/wali |
| santri | Data santri |
| kamar | Data kamar asrama |
| kelas_sekolah | Kelas formal |
| kelompok | Kelompok ngaji/kegiatan |
| santri_kelompok | Relasi santri ↔ kelompok |
| kegiatan | Daftar kegiatan |
| jadwal_umum | Jadwal ngaji/sorogan |
| jadwal_sekolah | Jadwal pelajaran |
| absensi_sesi | Sesi absensi |
| absensi | Data absensi (unified) |
| pelanggaran | Catatan pelanggaran |
| catatan_guru | Catatan ustadz |
| pengumuman | Pengumuman |
| settings | Konfigurasi app |

---

## Troubleshooting

**Port 3000 sudah dipakai:**
```bash
lsof -i :3000
# Ganti PORT di .env
```

**MariaDB tidak start:**
```bash
systemctl status mariadb
journalctl -u mariadb -n 50
```

**PM2 tidak auto-start setelah reboot:**
```bash
pm2 startup
pm2 save
```

**Reset admin password:**
```bash
mysql -u root pesantren -e "UPDATE users SET password_hash='\$2b\$10\$x' WHERE username='admin'"
# Login: admin / admin123
```
