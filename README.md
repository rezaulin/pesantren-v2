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

### Reverse Proxy (Nginx + Domain)

```nginx
server {
    server_name pesantren.example.com;

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
```

```bash
sudo apt install nginx
sudo nano /etc/nginx/sites-available/pesantren
sudo ln -s /etc/nginx/sites-available/pesantren /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# SSL (optional)
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d pesantren.example.com
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
