# Sistem Absensi Pesantren V2

Web app absensi santri berbasis Node.js + Express. Data disimpan di `data.json` (single file database).

## Fitur

- Absensi harian per kelompok (Kamar, Kegiatan, Sorogan, Bakat, Sekolah)
- Rekap absensi filter by kegiatan/kelompok/tanggal
- Manajemen santri, kamar, kelompok, kegiatan
- Pelanggaran & prestasi santri
- Dashboard statistik
- Export Excel & PDF
- Login multi-role (admin, wali, guru)
- PWA (install di HP)
- Auto-detect jadwal kegiatan hari ini

## Persyaratan Server

- **OS:** Ubuntu 20.04+ (atau Linux lain)
- **Node.js:** v18+ (direkomendasikan v22)
- **RAM:** minimal 512MB (1GB+ direkomendasikan)
- **Port:** 3000 (default, bisa diubah)

## Instalasi dari Nol

### 1. Install Node.js

```bash
# Install Node.js 22 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Verifikasi
node --version   # v22.x.x
npm --version    # 10.x.x
```

### 2. Install PM2 (Process Manager)

```bash
sudo npm install -g pm2
```

### 3. Clone Repository

```bash
cd /root
git clone https://github.com/rezaulin/pesantren-v2.git
cd pesantren-v2
```

### 4. Install Dependencies

```bash
npm install
```

> ⚠️ `canvas` butuh system dependencies. Kalau error:
> ```bash
> sudo apt install -y build-essential libcairo2-dev libjpeg-dev libpango1.0-dev libgif-dev librsvg2-dev
> npm install
> ```

### 5. Setup Data

Kalau ada backup `data.json`, copy ke folder project:

```bash
# Copy dari backup / VPS lama
cp /path/to/backup/data.json /root/pesantren-v2/data.json
```

Kalau fresh install (tanpa data lama), server akan buat `data.json` kosong otomatis.

### 6. Jalankan dengan PM2

```bash
# Start aplikasi
pm2 start server.js --name pesantren-v2

# Auto-start saat reboot
pm2 startup
pm2 save

# Cek status
pm2 list
pm2 logs pesantren-v2
```

### 7. Akses

```
http://YOUR_SERVER_IP:3000
```

Default login:
- **Username:** admin
- **Password:** admin123

> ⚠️ Ganti password default setelah login pertama!

## Konfigurasi

### Port

Default port 3000. Ubah via environment variable:

```bash
# Saat start
PORT=8080 pm2 start server.js --name pesantren-v2

# Atau di ecosystem.config.js
```

### JWT Secret

Default: `pesantren-secret-key`. Untuk production, ubah di `server.js` line 14 atau set via env:

```bash
JWT_SECRET=rahasia-baru-yang-panjang pm2 restart pesantren-v2
```

### Menautkan ke Domain

#### Langkah 1: Siapkan DNS

**Jika pakai Cloudflare:**
1. Login ke [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Pilih domain → **DNS** → **Records**
3. Tambah record:
   ```
   Type: A
   Name: pesantren  (atau subdomain yang diinginkan)
   IPv4: YOUR_SERVER_IP
   Proxy: ON (ikon awan oranye)
   TTL: Auto
   ```
4. Klik **Save**

**Jika pakai registrar lain (Namecheap, GoDaddy, dll):**
1. Login ke panel domain
2. Cari menu **DNS Management** / **DNS Records**
3. Tambah record:
   ```
   Type: A
   Host: pesantren  (atau @ untuk root domain)
   Value: YOUR_SERVER_IP
   TTL: 300
   ```

#### Langkah 2: Install Nginx

```bash
sudo apt update
sudo apt install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

#### Langkah 3: Konfigurasi Nginx

Buat file config:

```bash
sudo nano /etc/nginx/sites-available/pesantren
```

Isi:

```nginx
server {
    listen 80;
    server_name pesantren.example.com;  # GANTI dengan domain lo

    # Max upload size (untuk import Excel)
    client_max_body_size 10M;

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable config:

```bash
sudo ln -s /etc/nginx/sites-available/pesantren /etc/nginx/sites-enabled/
sudo nginx -t          # Cek syntax, harus bilang "ok"
sudo systemctl reload nginx
```

#### Langkah 4: Install SSL (HTTPS)

**Jika pakai Cloudflare (Proxy ON = orange cloud):**
```bash
# Cloudflare Flexible SSL sudah otomatis
# Tapi lebih aman pakai Full (Strict) — install cert juga:
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d pesantren.example.com
```

**Jika tanpa Cloudflare:**
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d pesantren.example.com
```

Certbot akan otomatis:
- Dapat SSL certificate dari Let's Encrypt
- Update Nginx config untuk HTTPS
- Set auto-renewal

Verifikasi auto-renewal:
```bash
sudo certbot renew --dry-run
```

#### Langkah 5: Verify

```bash
# Cek Nginx jalan
curl -I http://localhost

# Cek app lewat Nginx
curl -I http://localhost -H "Host: pesantren.example.com"

# Cek dari luar
curl -I https://pesantren.example.com
```

Buka browser: `https://pesantren.example.com`

#### Troubleshooting Domain

**DNS belum propagate:**
```bash
# Cek DNS sudah resolve ke IP bener
dig pesantren.example.com
nslookup pesantren.example.com
# Tunggu 5-30 menit, maksimal 24 jam
```

**502 Bad Gateway:**
```bash
# Pastikan app jalan
pm2 list
pm2 logs pesantren-v2

# Pastikan Nginx bisa reach port 3000
curl http://localhost:3000
```

**SSL error:**
```bash
# Cek certificate
sudo certbot certificates

# Renew manual kalau expired
sudo certbot renew
```

**Cloudflare 522 (Connection timed out):**
- Pastikan firewall buka port 80 dan 443
```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw reload
```

## Backup & Restore

### Backup Manual

```bash
# Backup data
cp /root/pesantren-v2/data.json /root/pesantren-v2/data.json.backup.$(date +%Y%m%d_%H%M%S)

# Backup ke lokal
scp root@VPS_IP:/root/pesantren-v2/data.json ./backup/
```

### Backup Otomatis (Cron)

```bash
# Tambahkan ke crontab -e
# Backup setiap jam 2 pagi, simpan 7 hari
0 2 * * * cp /root/pesantren-v2/data.json /root/backups/data.json.$(date +\%Y\%m\%d) && find /root/backups/ -name "data.json.*" -mtime +7 -delete
```

### Restore

```bash
# Stop server
pm2 stop pesantren-v2

# Copy backup
cp /root/backups/data.json.20260420 /root/pesantren-v2/data.json

# Restart
pm2 start pesantren-v2
```

## Update dari GitHub

```bash
cd /root/pesantren-v2

# Backup data dulu
cp data.json data.json.backup.$(date +%Y%m%d)

# Pull kode baru
git pull origin main

# Install dependency baru (jika ada)
npm install

# Restart
pm2 restart pesantren-v2
```

## Struktur Project

```
pesantren-v2/
├── server.js              # Backend API (Express)
├── data.json              # Database (JSON file)
├── package.json           # Dependencies
├── public/
│   ├── index.html         # Frontend (single-page app)
│   ├── manifest.json      # PWA manifest
│   ├── sw.js              # Service worker
│   ├── favicon.ico        # Favicon
│   ├── icon-192.png       # PWA icon kecil
│   └── icon-512.png       # PWA icon besar
├── migrate.js             # Script migrasi data
└── README.md              # File ini
```

## Troubleshooting

### Server nggak jalan
```bash
pm2 logs pesantren-v2 --lines 50
```

### Port 3000 sudah dipakai
```bash
sudo lsof -i :3000
sudo kill <PID>
pm2 restart pesantren-v2
```

### Data hilang / corrupt
Restore dari backup (lihat section Backup).

### Canvas error saat npm install
```bash
sudo apt install -y build-essential libcairo2-dev libjpeg-dev libpango1.0-dev libgif-dev librsvg2-dev
```

## GitHub Repos

- **Kode:** https://github.com/rezaulin/pesantren-v2
- **Deploy:** https://github.com/rezaulin/pesantren-deploy
