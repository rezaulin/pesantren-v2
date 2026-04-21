const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const ExcelJS = require('exceljs');
const compression = require('compression');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'pesantren-secret-key';

app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// Multer - memory storage, max 5MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── MariaDB Connection Pool ────────────────────────────
const pool = mysql.createPool({
  host: 'localhost', user: 'pesantren', password: 'pesantren2026',
  database: 'pesantren', waitForConnections: true, connectionLimit: 20, dateStrings: true
});

// ── In-Memory DB (loaded from MariaDB) ─────────────────
let db = {};
function nextId(arr) { return arr.length ? Math.max(...arr.map(x => x.id)) + 1 : 1; }

async function loadFromDB() {
  const tables = {
    users: 'SELECT * FROM users',
    kamar: 'SELECT * FROM kamar',
    kelas_sekolah: 'SELECT * FROM kelas_sekolah',
    santri: 'SELECT * FROM santri',
    kegiatan: 'SELECT * FROM kegiatan',
    kelompok: 'SELECT * FROM kelompok',
    santri_kelompok: 'SELECT * FROM santri_kelompok',
    absensi_sesi: 'SELECT * FROM absensi_sesi',
    absensi: 'SELECT * FROM absensi',
    absen_malam: 'SELECT * FROM absen_malam',
    absen_sekolah: 'SELECT * FROM absen_sekolah',
    pelanggaran: 'SELECT * FROM pelanggaran',
    catatan_guru: 'SELECT * FROM catatan_guru',
    jadwal_umum: 'SELECT * FROM jadwal_umum',
    jadwal_sekolah: 'SELECT * FROM jadwal_sekolah',
    pengumuman: 'SELECT * FROM pengumuman'
  };
  for (const [table, sql] of Object.entries(tables)) {
    try { db[table] = await pool.execute(sql).then(([r]) => r); }
    catch(e) { db[table] = []; console.error(`Load ${table} error:`, e.message); }
  }
  // Settings
  const [sRows] = await pool.execute('SELECT * FROM settings LIMIT 1');
  db.settings = sRows[0] || { app_name: 'Pesantren', alamat_lembaga: '', kepala_nama: '', nama_kota: '', logo: null };
}

// ── Save helpers (write to MariaDB + sync in-memory) ──
async function saveDB() { /* no-op: each endpoint writes directly */ }

function toDatetime(iso) {
  if (!iso) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  return iso.slice(0, 19).replace('T', ' ');
}

// Generic: insert into table + add to in-memory array
async function dbInsert(table, data, arr) {
  const keys = Object.keys(data);
  const vals = Object.values(data);
  const ph = keys.map(() => '?').join(', ');
  const [result] = await pool.execute(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${ph})`, vals);
  const row = { id: result.insertId, ...data };
  arr.push(row);
  return row;
}

// Generic: update table + update in-memory
async function dbUpdate(table, id, data, arr) {
  const keys = Object.keys(data);
  const vals = Object.values(data);
  const set = keys.map(k => `${k} = ?`).join(', ');
  await pool.execute(`UPDATE ${table} SET ${set} WHERE id = ?`, [...vals, id]);
  const idx = arr.findIndex(x => x.id == id);
  if (idx >= 0) Object.assign(arr[idx], data);
}

// Generic: delete from table + remove from in-memory
async function dbDelete(table, id, arr) {
  await pool.execute(`DELETE FROM ${table} WHERE id = ?`, [id]);
  const idx = arr.findIndex(x => x.id == id);
  if (idx >= 0) arr.splice(idx, 1);
}

// Reload specific table from DB
async function dbReload(table) {
  const [rows] = await pool.execute(`SELECT * FROM ${table}`);
  db[table] = rows;
}

// ── Server startup ─────────────────────────────────────
async function startServer() {
  await loadFromDB();
  console.log('Database loaded from MariaDB');
  // Ensure admin exists
  if (!db.users.find(u => u.username === 'admin')) {
    const hash = bcrypt.hashSync('admin123', 10);
    await pool.execute('INSERT INTO users (username, password_hash, role, nama) VALUES (?, ?, ?, ?)', ['admin', hash, 'admin', 'Administrator']);
    await loadFromDB();
    console.log('Default admin: admin / admin123');
  }
  // Backfill: auto-create kelompok untuk kegiatan yang belum punya
  for (const k of db.kegiatan) {
    if (k.kategori === 'pokok') {
      const existing = db.kelompok.find(kl => kl.tipe === k.nama);
      if (!existing) {
        await dbInsert('kelompok', { nama: k.nama, tipe: k.nama, kegiatan_nama: k.nama }, db.kelompok);
      }
    } else {
      const existing = db.kelompok.find(kl => kl.nama === k.nama && kl.tipe === 'KEGIATAN');
      if (!existing) {
        await dbInsert('kelompok', { nama: k.nama, tipe: 'KEGIATAN', kegiatan_nama: k.nama }, db.kelompok);
      }
    }
  }

  // Ensure kelompok Sekolah exists
  if (!db.kelompok.find(k => k.tipe === 'SEKOLAH')) {
    await dbInsert('kelompok', { nama: 'Sekolah', tipe: 'SEKOLAH', kegiatan_nama: 'Sekolah' }, db.kelompok);
    console.log('Auto-created kelompok Sekolah');
  }

  app.listen(PORT, () => console.log(`Server jalan di http://localhost:${PORT}`));
}

// ── Jadwal Helper ──────────────────────────────────────
const HARI = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
function getWaktuWIB() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
}
function getHariIni() { return HARI[getWaktuWIB().getDay()]; }
function getJamSekarang() {
  const d = getWaktuWIB();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function cekJadwalValid(jamMulai, jamSelesai) {
  const now = getJamSekarang();
  const toleransi = addMinutes(jamSelesai, 60); // molor 1 jam
  return now >= jamMulai && now <= toleransi;
}
function addMinutes(jam, menit) {
  const [h, m] = jam.split(':').map(Number);
  const total = h * 60 + m + menit;
  return `${String(Math.floor(total / 60) % 24).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
}

// ── Auth ───────────────────────────────────────────────
function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'Token tidak ada' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ message: 'Token tidak valid' }); }
}
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Hanya admin' });
  next();
}

// ── Auth Routes ────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ message: 'Username/password salah' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, nama: user.nama }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, nama: user.nama } });
});
app.get('/api/me', authenticate, (req, res) => {
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ message: 'User tidak ditemukan' });
  res.json({ id: user.id, username: user.username, role: user.role, nama: user.nama });
});

// ── Dashboard ──────────────────────────────────────────
app.get('/api/dashboard', authenticate, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  // Wali: dashboard khusus anak-anaknya
  if (req.user.role === 'wali') {
    const anakList = db.santri.filter(s => s.wali_user_id === req.user.id);
    const anakIds = anakList.map(s => s.id);
    const absensiToday = db.absensi.filter(a => anakIds.includes(a.santri_id) && a.tanggal === today);
    const hadir = absensiToday.filter(a => a.status === 'H').length;
    const izin = absensiToday.filter(a => a.status === 'I' || a.status === 'S').length;
    const alfa = absensiToday.filter(a => a.status === 'A').length;
    // Rekap per kegiatan untuk semua anak
    const allAbsensi = db.absensi.filter(a => anakIds.includes(a.santri_id));
    const rekapKegiatan = {};
    allAbsensi.forEach(a => {
      const kg = db.kegiatan.find(k => k.id === a.kegiatan_id);
      const nama = kg ? kg.nama : 'Lainnya';
      if (!rekapKegiatan[nama]) rekapKegiatan[nama] = { H: 0, I: 0, S: 0, A: 0 };
      rekapKegiatan[nama][a.status]++;
    });
    return res.json({
      role: 'wali',
      anak: anakList.map(s => {
        const k = db.kamar.find(x => x.id === s.kamar_id);
        const anakAbsensi = db.absensi.filter(a => a.santri_id === s.id);
        return {
          id: s.id, nama: s.nama, kamar_nama: k ? k.nama : '-',
          kelas_diniyyah: s.kelas_diniyyah, kelompok_ngaji: s.kelompok_ngaji,
          total_hadir: anakAbsensi.filter(a => a.status === 'H').length,
          total_izin: anakAbsensi.filter(a => a.status === 'I').length,
          total_sakit: anakAbsensi.filter(a => a.status === 'S').length,
          total_alfa: anakAbsensi.filter(a => a.status === 'A').length,
        };
      }),
      hadir_hari_ini: hadir, izin_sakit: izin, alfa,
      rekap_kegiatan: rekapKegiatan,
      pengumuman: db.pengumuman.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5)
    });
  }
  // Admin/ustadz: dashboard biasa
  const hadir = db.absensi.filter(a => a.tanggal === today && a.status === 'H').length;
  const izin = db.absensi.filter(a => a.tanggal === today && (a.status === 'I' || a.status === 'S')).length;
  const alfaAbsensi = db.absensi.filter(a => a.tanggal === today && a.status === 'A');
  const alfa = alfaAbsensi.length;
  const alfaList = alfaAbsensi.map(a => {
    const s = db.santri.find(x => x.id === a.santri_id);
    const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
    const kg = db.kegiatan.find(x => x.id === a.kegiatan_id);
    return { nama: s ? s.nama : '-', kamar: k ? k.nama : '-', kegiatan: kg ? kg.nama : '-' };
  });
  res.json({
    total_santri: db.santri.filter(s => s.status === 'aktif').length,
    total_kamar: db.kamar.length,
    hadir_hari_ini: hadir,
    izin_sakit: izin,
    alfa: alfa,
    alfa_list: alfaList,
    pengumuman: db.pengumuman.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 3)
  });
});

// ── Wali Endpoints ─────────────────────────────────────
app.get('/api/wali/anak', authenticate, (req, res) => {
  if (req.user.role !== 'wali') return res.status(403).json({ message: 'Hanya wali santri' });
  const anakList = db.santri.filter(s => s.wali_user_id === req.user.id);
  res.json(anakList.map(s => {
    const k = db.kamar.find(x => x.id === s.kamar_id);
    return { ...s, kamar_nama: k ? k.nama : '-' };
  }));
});
app.get('/api/wali/rekap', authenticate, (req, res) => {
  if (req.user.role !== 'wali') return res.status(403).json({ message: 'Hanya wali santri' });
  const anakIds = db.santri.filter(s => s.wali_user_id === req.user.id).map(s => s.id);
  let list = db.absensi.filter(a => anakIds.includes(a.santri_id));
  if (req.query.santri_id) list = list.filter(a => a.santri_id == req.query.santri_id);
  if (req.query.dari) list = list.filter(a => a.tanggal >= req.query.dari);
  if (req.query.sampai) list = list.filter(a => a.tanggal <= req.query.sampai);
  if (req.query.kegiatan_id) list = list.filter(a => a.kegiatan_id == req.query.kegiatan_id);
  res.json(list.map(a => {
    const s = db.santri.find(x => x.id === a.santri_id);
    const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
    const kg = db.kegiatan.find(x => x.id === a.kegiatan_id);
    return { tanggal: a.tanggal, nama: s ? s.nama : '-', kamar_nama: k ? k.nama : '-', kegiatan_nama: kg ? kg.nama : '-', status: a.status, keterangan: a.keterangan };
  }).sort((a, b) => b.tanggal.localeCompare(a.tanggal)));
});

// ── Users ──────────────────────────────────────────────
app.get('/api/users', authenticate, requireAdmin, (req, res) => {
  res.json(db.users.map(u => ({ id: u.id, username: u.username, nama: u.nama, role: u.role, created_at: u.created_at })));
});
app.post('/api/users', authenticate, requireAdmin, async (req, res) => {
  const { username, password, role, nama } = req.body;
  if (!username || !password || !nama) return res.status(400).json({ message: 'Semua field wajib' });
  if (db.users.find(u => u.username === username)) return res.status(400).json({ message: 'Username sudah ada' });
  const user = { username, password_hash: bcrypt.hashSync(password, 10), role: role || 'ustadz', nama, created_at: toDatetime() };
  const row = await dbInsert('users', user, db.users);
  res.json({ message: 'User ditambahkan', user: { id: row.id, username: row.username, nama: row.nama, role: row.role } });
});
app.put('/api/users/:id', authenticate, requireAdmin, async (req, res) => {
  const user = db.users.find(u => u.id == req.params.id);
  if (!user) return res.status(404).json({ message: 'User tidak ditemukan' });
  const { username, password, role, nama } = req.body;
  const updates = {};
  if (username) updates.username = username;
  if (nama) updates.nama = nama;
  if (role) updates.role = role;
  if (password) updates.password_hash = bcrypt.hashSync(password, 10);
  if (Object.keys(updates).length) await dbUpdate('users', user.id, updates, db.users);
  res.json({ message: 'User diupdate' });
});
app.delete('/api/users/:id', authenticate, requireAdmin, async (req, res) => {
  if (req.user.id == req.params.id) return res.status(400).json({ message: 'Tidak bisa hapus diri sendiri' });
  await dbDelete('users', parseInt(req.params.id), db.users);
  res.json({ message: 'User dihapus' });
});

// ── Kamar ──────────────────────────────────────────────
app.get('/api/kamar', authenticate, (req, res) => {
  res.json(db.kamar.map(k => ({
    ...k, jumlah_santri: db.santri.filter(s => s.kamar_id === k.id && s.status === 'aktif').length
  })));
});
app.post('/api/kamar', authenticate, requireAdmin, async (req, res) => {
  const { nama, kapasitas, pengurus } = req.body;
  if (!nama) return res.status(400).json({ message: 'Nama wajib' });
  const k = { nama, kapasitas: kapasitas || 10, pengurus: pengurus || '' };
  const row = await dbInsert('kamar', k, db.kamar); res.json(row);
});
app.put('/api/kamar/:id', authenticate, requireAdmin, async (req, res) => {
  const k = db.kamar.find(x => x.id == req.params.id);
  if (!k) return res.status(404).json({ message: 'Kamar tidak ditemukan' });
  const { id, ...updates } = req.body;
  if (Object.keys(updates).length) await dbUpdate('kamar', k.id, updates, db.kamar);
  res.json({ message: 'Kamar diupdate' });
});
app.delete('/api/kamar/:id', authenticate, requireAdmin, async (req, res) => {
  await dbDelete('kamar', parseInt(req.params.id), db.kamar);
  res.json({ message: 'Kamar dihapus' });
});

// ── Kelas Sekolah ────────────────────────────────────────
app.get('/api/kelas-sekolah', authenticate, (req, res) => {
  if (!db.kelas_sekolah) db.kelas_sekolah = [];
  res.json(db.kelas_sekolah.map(k => ({
    ...k, jumlah_santri: db.santri.filter(s => s.kelas_sekolah === k.nama && s.status === 'aktif').length
  })));
});
app.post('/api/kelas-sekolah', authenticate, requireAdmin, async (req, res) => {
  const { nama } = req.body;
  if (!nama) return res.status(400).json({ message: 'Nama kelas wajib' });
  if (!db.kelas_sekolah) db.kelas_sekolah = [];
  if (db.kelas_sekolah.find(k => k.nama.toLowerCase() === nama.toLowerCase())) {
    return res.status(400).json({ message: 'Kelas sudah ada' });
  }
  const k = { nama, created_at: toDatetime() };
  const row = await dbInsert('kelas_sekolah', k, db.kelas_sekolah); res.json(row);
});
app.put('/api/kelas-sekolah/:id', authenticate, requireAdmin, async (req, res) => {
  if (!db.kelas_sekolah) db.kelas_sekolah = [];
  const k = db.kelas_sekolah.find(x => x.id == req.params.id);
  if (!k) return res.status(404).json({ message: 'Kelas tidak ditemukan' });
  const oldNama = k.nama;
  if (req.body.nama && req.body.nama !== oldNama) {
    await pool.execute('UPDATE santri SET kelas_sekolah = ? WHERE kelas_sekolah = ?', [req.body.nama, oldNama]);
    db.santri.forEach(s => { if (s.kelas_sekolah === oldNama) s.kelas_sekolah = req.body.nama; });
  }
  const { id, ...updates } = req.body;
  if (Object.keys(updates).length) await dbUpdate('kelas_sekolah', k.id, updates, db.kelas_sekolah);
  res.json({ message: 'Kelas diupdate' });
});
app.delete('/api/kelas-sekolah/:id', authenticate, requireAdmin, async (req, res) => {
  if (!db.kelas_sekolah) db.kelas_sekolah = [];
  const k = db.kelas_sekolah.find(x => x.id == req.params.id);
  if (k) {
    await pool.execute('UPDATE santri SET kelas_sekolah = ? WHERE kelas_sekolah = ?', ['', k.nama]);
    db.santri.forEach(s => { if (s.kelas_sekolah === k.nama) s.kelas_sekolah = ''; });
    await dbDelete('kelas_sekolah', k.id, db.kelas_sekolah);
  }
  res.json({ message: 'Kelas dihapus' });
});
app.post('/api/kelas-sekolah/pindah', authenticate, requireAdmin, async (req, res) => {
  const { santri_ids, kelas_nama } = req.body;
  if (!santri_ids || !santri_ids.length) return res.status(400).json({ message: 'Pilih santri dulu' });
  let count = 0;
  for (const sid of santri_ids) {
    const s = db.santri.find(x => x.id === sid);
    if (s) { 
      await pool.execute('UPDATE santri SET kelas_sekolah = ? WHERE id = ?', [kelas_nama || '', sid]);
      s.kelas_sekolah = kelas_nama || ''; count++; 
    }
  }
  res.json({ message: count + ' santri dipindahkan ke ' + (kelas_nama || '-') });
});

// ── Santri ─────────────────────────────────────────────
app.get('/api/santri', authenticate, (req, res) => {
  let list = db.santri;
  if (req.query.kamar_id) list = list.filter(s => s.kamar_id == req.query.kamar_id);
  if (req.query.kelas_diniyyah) list = list.filter(s => s.kelas_diniyyah === req.query.kelas_diniyyah);
  if (req.query.kelompok_ngaji) list = list.filter(s => s.kelompok_ngaji === req.query.kelompok_ngaji);
  if (req.query.kelas_sekolah) list = list.filter(s => s.kelas_sekolah === req.query.kelas_sekolah);
  if (req.query.jenis_bakat) list = list.filter(s => s.jenis_bakat === req.query.jenis_bakat);
  if (req.query.kelompok_ngaji_malam) list = list.filter(s => s.kelompok_ngaji_malam === req.query.kelompok_ngaji_malam);
  const mapped = list.map(s => {
    const k = db.kamar.find(x => x.id === s.kamar_id);
    return { ...s, kamar_nama: k ? k.nama : '-' };
  });
  // Pagination
  if (req.query.page) {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const total = mapped.length;
    const data = mapped.slice((page - 1) * limit, page * limit);
    return res.json({ data, total, page, limit, pages: Math.ceil(total / limit) });
  }
  res.json(mapped);
});
app.post('/api/santri', authenticate, requireAdmin, async (req, res) => {
  const { nama, kamar_id, status, kelas_diniyyah, kelompok_ngaji, jenis_bakat, kelas_sekolah, kelompok_ngaji_malam, wali_user_id, extra, alamat } = req.body;
  if (!nama || !kamar_id) return res.status(400).json({ message: 'Nama & kamar wajib' });
  const s = {
    id: nextId(db.santri), nama, kamar_id: parseInt(kamar_id), status: status || 'aktif',
    kelas_diniyyah: kelas_diniyyah || '', kelompok_ngaji: kelompok_ngaji || '',
    jenis_bakat: jenis_bakat || '', kelas_sekolah: kelas_sekolah || '',
    kelompok_ngaji_malam: kelompok_ngaji_malam || '',
    alamat: alamat || '',
    extra: extra || {},
    wali_user_id: wali_user_id ? parseInt(wali_user_id) : null,
    extra: req.body.extra || {},
    created_at: new Date().toISOString()
  };
  const row = await dbInsert('santri', s, db.santri); res.json(row);
});
app.put('/api/santri/:id', authenticate, requireAdmin, async (req, res) => {
  const s = db.santri.find(x => x.id == req.params.id);
  if (!s) return res.status(404).json({ message: 'Santri tidak ditemukan' });
  const fields = ['nama', 'status', 'kelas_diniyyah', 'kelompok_ngaji', 'jenis_bakat', 'kelas_sekolah', 'kelompok_ngaji_malam', 'alamat'];
  const updates = {};
  fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (req.body.kamar_id) updates.kamar_id = parseInt(req.body.kamar_id);
  if (req.body.wali_user_id !== undefined) updates.wali_user_id = req.body.wali_user_id ? parseInt(req.body.wali_user_id) : null;
  if (req.body.extra !== undefined) updates.extra = JSON.stringify(req.body.extra);
  if (Object.keys(updates).length) await dbUpdate('santri', s.id, updates, db.santri);
  res.json({ message: 'Santri diupdate' });
});
app.delete('/api/santri/:id', authenticate, requireAdmin, async (req, res) => {
  await dbDelete('santri', parseInt(req.params.id), db.santri);
  res.json({ message: 'Santri dihapus' });
});

// Import Santri from Excel
app.post('/api/santri/import-excel', authenticate, requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'File Excel wajib diupload' });
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return res.status(400).json({ message: 'Sheet kosong' });

    // Read header row to find column indices
    const headerRow = sheet.getRow(1);
    let colNama = -1, colAlamat = -1, colWali = -1;
    headerRow.eachCell((cell, colNum) => {
      const h = String(cell.value || '').toLowerCase().trim();
      if (h.includes('nama')) colNama = colNum;
      else if (h.includes('alamat')) colAlamat = colNum;
      else if (h.includes('wali')) colWali = colNum;
    });
    // Fallback: if no header found, assume A=nama, B=alamat, C=wali
    if (colNama === -1) { colNama = 1; colAlamat = 2; colWali = 3; }

    const results = [];
    const usernameCount = {}; // track duplicate usernames

    // Process each data row (skip header)
    const startRow = (colNama === 1 && colAlamat === 2 && colWali === 3 && String(headerRow.getCell(1).value || '').toLowerCase().includes('nama')) ? 2 : (colNama === 1 ? 2 : 1);
    
    for (let rowNum = startRow; rowNum <= sheet.rowCount; rowNum++) {
      const row = sheet.getRow(rowNum);
      const namaSantri = String(row.getCell(colNama).value || '').trim();
      const alamat = String(row.getCell(colAlamat).value || '').trim();
      const namaWali = String(row.getCell(colWali).value || '').trim();

      if (!namaSantri) continue; // skip empty rows

      // Generate username from wali name
      let baseUsername = 'wali_' + namaWali.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!usernameCount[baseUsername]) usernameCount[baseUsername] = 0;
      usernameCount[baseUsername]++;
      let username = usernameCount[baseUsername] === 1 ? baseUsername : baseUsername + '_' + usernameCount[baseUsername];

      // Ensure uniqueness against existing users
      while (db.users.find(u => u.username === username)) {
        usernameCount[baseUsername]++;
        username = baseUsername + '_' + usernameCount[baseUsername];
      }

      // Create wali user in DB
      const waliUserData = {
        username,
        password_hash: bcrypt.hashSync('wali123', 10),
        role: 'wali',
        nama: namaWali || '-',
        created_at: toDatetime()
      };
      const waliUser = await dbInsert('users', waliUserData, db.users);

      // Create santri in DB
      const santriData = {
        nama: namaSantri,
        kamar_id: null,
        status: 'aktif',
        kelas_diniyyah: '',
        kelompok_ngaji: '',
        jenis_bakat: '',
        kelas_sekolah: '',
        kelompok_ngaji_malam: '',
        alamat: alamat,
        wali_user_id: waliUser.id,
        wali_nama: namaWali || '-',
        extra: JSON.stringify({}),
        created_at: toDatetime()
      };
      const santri = await dbInsert('santri', santriData, db.santri);

      results.push({
        nama: namaSantri,
        alamat: alamat,
        wali: namaWali,
        username: waliUser.username,
        password: 'wali123'
      });
    }
    res.json({ message: `Berhasil import ${results.length} santri`, data: results });
  } catch (err) {
    console.error('Import Excel error:', err);
    res.status(500).json({ message: 'Gagal memproses file Excel: ' + err.message });
  }
});

// ── Kegiatan ───────────────────────────────────────────
app.get('/api/kegiatan', authenticate, (req, res) => {
  res.json(db.kegiatan);
});
app.post('/api/kegiatan', authenticate, requireAdmin, async (req, res) => {
  const { nama, kategori, urutan_tampil } = req.body;
  if (!nama) return res.status(400).json({ message: 'Nama kegiatan wajib' });
  const kData = { nama, kategori: kategori || 'pokok', urutan_tampil: urutan_tampil || 0, created_at: toDatetime() };
  const k = await dbInsert('kegiatan', kData, db.kegiatan);
  if (k.kategori === 'pokok') {
    if (!db.kelompok.find(kl => kl.nama === nama && kl.tipe === nama)) {
      await dbInsert('kelompok', { nama, tipe: nama, kegiatan_nama: nama, created_at: toDatetime() }, db.kelompok);
    }
  } else {
    if (!db.kelompok.find(kl => kl.nama === nama && kl.tipe === 'KEGIATAN')) {
      await dbInsert('kelompok', { nama, tipe: 'KEGIATAN', kegiatan_nama: nama, created_at: toDatetime() }, db.kelompok);
    }
  }
  res.json(k);
});
app.put('/api/kegiatan/:id', authenticate, requireAdmin, async (req, res) => {
  const k = db.kegiatan.find(x => x.id == req.params.id);
  if (!k) return res.status(404).json({ message: 'Kegiatan tidak ditemukan' });
  const oldNama = k.nama;
  const oldKategori = k.kategori;
  const updates = {};
  if (req.body.nama) updates.nama = req.body.nama;
  if (req.body.kategori !== undefined) updates.kategori = req.body.kategori;
  if (req.body.urutan_tampil !== undefined) updates.urutan_tampil = parseInt(req.body.urutan_tampil) || 0;
  if (Object.keys(updates).length) await dbUpdate('kegiatan', k.id, updates, db.kegiatan);
  // Sync kelompok: rename tipe/kegiatan_nama
  if (req.body.nama && req.body.nama !== oldNama) {
    if (oldKategori === 'pokok') {
      for (const kl of db.kelompok.filter(kl => kl.tipe === oldNama)) {
        await dbUpdate('kelompok', kl.id, { tipe: k.nama, kegiatan_nama: k.nama }, db.kelompok);
      }
    } else {
      for (const kl of db.kelompok.filter(kl => kl.tipe === 'KEGIATAN' && kl.kegiatan_nama === oldNama)) {
        const u = { kegiatan_nama: k.nama };
        if (kl.nama === oldNama) u.nama = k.nama;
        await dbUpdate('kelompok', kl.id, u, db.kelompok);
      }
    }
  }
  res.json({ message: 'Kegiatan diupdate' });
});
app.delete('/api/kegiatan/:id', authenticate, requireAdmin, async (req, res) => {
  const k = db.kegiatan.find(x => x.id == req.params.id);
  if (k) {
    let kelompokIds;
    if (k.kategori === 'pokok') {
      kelompokIds = db.kelompok.filter(kl => kl.tipe === k.nama).map(kl => kl.id);
    } else {
      kelompokIds = db.kelompok.filter(kl => kl.tipe === 'KEGIATAN' && kl.kegiatan_nama === k.nama).map(kl => kl.id);
    }
    if (kelompokIds.length) {
      for (const kid of kelompokIds) {
        await dbDelete('kelompok', kid, db.kelompok);
      }
      for (const sk of db.santri_kelompok.filter(sk => kelompokIds.includes(sk.kelompok_id))) {
        await dbDelete('santri_kelompok', sk.id || sk.santri_id + '-' + sk.kelompok_id, db.santri_kelompok);
      }
    }
  }
  await dbDelete('kegiatan', parseInt(req.params.id), db.kegiatan);
  res.json({ message: 'Kegiatan dihapus' });
});

// ── Jadwal Umum (Sorogan, Ngaji, Bakat, dst) ──────────
app.get('/api/jadwal-umum', authenticate, (req, res) => {
  let list = db.jadwal_umum;
  if (req.query.kelompok_id) list = list.filter(j => j.kelompok_id == req.query.kelompok_id);
  if (req.query.ustadz_username) list = list.filter(j => j.ustadz_username === req.query.ustadz_username);
  res.json(list.map(j => {
    const u = db.users.find(x => x.username === j.ustadz_username);
    const kl = db.kelompok.find(x => x.id === j.kelompok_id);
    const kg = kl ? db.kegiatan.find(x => x.nama === kl.kegiatan_nama) : null;
    return { ...j, ustadz_nama: u ? u.nama : j.ustadz_username, kelompok_nama: kl ? kl.nama : '-', kegiatan_nama: kg ? kg.nama : (kl ? kl.kegiatan_nama : '-') };
  }));
});
app.post('/api/jadwal-umum', authenticate, requireAdmin, async (req, res) => {
  const { kelompok_id, ustadz_username, hari, jam_mulai, jam_selesai } = req.body;
  if (!kelompok_id || !ustadz_username || !hari || !jam_mulai || !jam_selesai)
    return res.status(400).json({ message: 'Semua field wajib diisi' });
  const jData = { kelompok_id: parseInt(kelompok_id), ustadz_username, hari, jam_mulai, jam_selesai, created_at: toDatetime() };
  const j = await dbInsert('jadwal_umum', jData, db.jadwal_umum); res.json(j);
});
app.put('/api/jadwal-umum/:id', authenticate, requireAdmin, async (req, res) => {
  const j = db.jadwal_umum.find(x => x.id == req.params.id);
  if (!j) return res.status(404).json({ message: 'Jadwal tidak ditemukan' });
  const updates = {};
  if (req.body.kelompok_id) updates.kelompok_id = parseInt(req.body.kelompok_id);
  if (req.body.ustadz_username) updates.ustadz_username = req.body.ustadz_username;
  if (req.body.hari) updates.hari = req.body.hari;
  if (req.body.jam_mulai) updates.jam_mulai = req.body.jam_mulai;
  if (req.body.jam_selesai) updates.jam_selesai = req.body.jam_selesai;
  if (Object.keys(updates).length) await dbUpdate('jadwal_umum', j.id, updates, db.jadwal_umum);
  res.json({ message: 'Jadwal diupdate' });
});
app.delete('/api/jadwal-umum/:id', authenticate, requireAdmin, async (req, res) => {
  await dbDelete('jadwal_umum', parseInt(req.params.id), db.jadwal_umum);
  res.json({ message: 'Jadwal dihapus' });
});

// ── Jadwal Sekolah ─────────────────────────────────────
app.get('/api/jadwal-sekolah', authenticate, (req, res) => {
  let list = db.jadwal_sekolah;
  if (req.query.kelas) list = list.filter(j => j.kelas === req.query.kelas);
  if (req.query.ustadz_username) list = list.filter(j => j.ustadz_username === req.query.ustadz_username);
  res.json(list.map(j => {
    const u = db.users.find(x => x.username === j.ustadz_username);
    return { ...j, ustadz_nama: u ? u.nama : j.ustadz_username };
  }));
});
app.post('/api/jadwal-sekolah', authenticate, requireAdmin, async (req, res) => {
  const { kelas, mata_pelajaran, ustadz_username, hari, jam_mulai, jam_selesai } = req.body;
  if (!kelas || !mata_pelajaran || !ustadz_username || !hari || !jam_mulai || !jam_selesai)
    return res.status(400).json({ message: 'Semua field wajib diisi' });
  const jData = { kelas, mata_pelajaran, ustadz_username, hari, jam_mulai, jam_selesai, created_at: toDatetime() };
  const j = await dbInsert('jadwal_sekolah', jData, db.jadwal_sekolah); res.json(j);
});
app.put('/api/jadwal-sekolah/:id', authenticate, requireAdmin, async (req, res) => {
  const j = db.jadwal_sekolah.find(x => x.id == req.params.id);
  if (!j) return res.status(404).json({ message: 'Jadwal tidak ditemukan' });
  const updates = {};
  if (req.body.kelas) updates.kelas = req.body.kelas;
  if (req.body.mata_pelajaran) updates.mata_pelajaran = req.body.mata_pelajaran;
  if (req.body.ustadz_username) updates.ustadz_username = req.body.ustadz_username;
  if (req.body.hari) updates.hari = req.body.hari;
  if (req.body.jam_mulai) updates.jam_mulai = req.body.jam_mulai;
  if (req.body.jam_selesai) updates.jam_selesai = req.body.jam_selesai;
  if (Object.keys(updates).length) await dbUpdate('jadwal_sekolah', j.id, updates, db.jadwal_sekolah);
  res.json({ message: 'Jadwal diupdate' });
});
app.delete('/api/jadwal-sekolah/:id', authenticate, requireAdmin, async (req, res) => {
  await dbDelete('jadwal_sekolah', parseInt(req.params.id), db.jadwal_sekolah);
  res.json({ message: 'Jadwal dihapus' });
});

// ── Jadwal Aktif (untuk ustadz buka absen) ─────────────
app.get('/api/jadwal-aktif', authenticate, (req, res) => {
  const hari = getHariIni();
  const jamNow = getJamSekarang();
  const isAdmin = req.user.role === 'admin';
  const today = getWaktuWIB().toISOString().slice(0, 10);

  // JADWAL UMUM
  let jadwalUmum = db.jadwal_umum.filter(j => j.hari === hari);
  if (!isAdmin) jadwalUmum = jadwalUmum.filter(j => j.ustadz_username === req.user.username);

  const umumResult = jadwalUmum.map(j => {
    const kl = db.kelompok.find(x => x.id === j.kelompok_id);
    const kg = kl ? db.kegiatan.find(x => x.nama === kl.kegiatan_nama) : null;
    let status = 'belum_waktunya';
    if (cekJadwalValid(j.jam_mulai, j.jam_selesai)) {
      // Cek apakah sudah absen
      const sudahAbsen = db.absensi_sesi.some(s =>
        s.ustadz_username === req.user.username &&
        s.kelompok_id === j.kelompok_id &&
        s.tanggal === today
      );
      status = sudahAbsen ? 'sudah_absen' : 'siap_absen';
    } else if (jamNow > addMinutes(j.jam_selesai, 60)) {
      status = 'sudah_lewat';
    }
    return {
      ...j,
      jenis: 'umum',
      kegiatan_nama: kg ? kg.nama : (kl ? kl.kegiatan_nama : '-'),
      kelompok_nama: kl ? kl.nama : '-',
      status
    };
  });

  // JADWAL SEKOLAH
  let jadwalSekolah = db.jadwal_sekolah.filter(j => j.hari === hari);
  if (!isAdmin) jadwalSekolah = jadwalSekolah.filter(j => j.ustadz_username === req.user.username);

  const sekolahResult = jadwalSekolah.map(j => {
    let status = 'belum_waktunya';
    if (cekJadwalValid(j.jam_mulai, j.jam_selesai)) {
      const sudahAbsen = db.absensi_sesi.some(s =>
        s.ustadz_username === req.user.username &&
        s.kegiatan_nama === 'Sekolah' &&
        s.kelas_sekolah === j.kelas &&
        s.mata_pelajaran === j.mata_pelajaran &&
        s.tanggal === today
      );
      status = sudahAbsen ? 'sudah_absen' : 'siap_absen';
    } else if (jamNow > addMinutes(j.jam_selesai, 60)) {
      status = 'sudah_lewat';
    }
    return { ...j, jenis: 'sekolah', status };
  });

  res.json({ hari, jam_sekarang: jamNow, jadwal: [...umumResult, ...sekolahResult].sort((a, b) => a.jam_mulai.localeCompare(b.jam_mulai)) });
});

// ── Kelompok (Many-to-Many Groups) ─────────────────────
app.get('/api/kelompok', authenticate, (req, res) => {
  let list = db.kelompok;
  if (req.query.tipe) list = list.filter(k => k.tipe === req.query.tipe);
  res.json(list.map(k => ({
    ...k,
    jumlah_anggota: db.santri_kelompok.filter(sk => sk.kelompok_id === k.id && sk.status === 'aktif').length
  })));
});
app.post('/api/kelompok', authenticate, requireAdmin, async (req, res) => {
  const { nama, tipe, kegiatan_nama } = req.body;
  if (!nama || !tipe) return res.status(400).json({ message: 'Nama & tipe wajib' });
  if (db.kelompok.find(k => k.nama.toLowerCase() === nama.toLowerCase() && k.tipe === tipe && (k.kegiatan_nama || '') === (kegiatan_nama || '')))
    return res.status(400).json({ message: 'Kelompok dengan nama & tipe ini sudah ada' });
  const kData = { nama, tipe, kegiatan_nama: kegiatan_nama || null, created_at: toDatetime() };
  const k = await dbInsert('kelompok', kData, db.kelompok); res.json(k);
});
app.put('/api/kelompok/:id', authenticate, requireAdmin, async (req, res) => {
  const k = db.kelompok.find(x => x.id == req.params.id);
  if (!k) return res.status(404).json({ message: 'Kelompok tidak ditemukan' });
  const updates = {};
  if (req.body.nama) updates.nama = req.body.nama;
  if (req.body.tipe) updates.tipe = req.body.tipe;
  if (req.body.kegiatan_nama !== undefined) updates.kegiatan_nama = req.body.kegiatan_nama || null;
  if (Object.keys(updates).length) await dbUpdate('kelompok', k.id, updates, db.kelompok);
  res.json({ message: 'Kelompok diupdate' });
});
app.delete('/api/kelompok/:id', authenticate, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  // Soft-delete: set semua anggota jadi inactive
  for (const sk of db.santri_kelompok.filter(sk => sk.kelompok_id === id)) {
    await pool.execute('UPDATE santri_kelompok SET status = ? WHERE santri_id = ? AND kelompok_id = ?', ['inactive', sk.santri_id, id]);
    sk.status = 'inactive';
  }
  await dbDelete('kelompok', id, db.kelompok);
  res.json({ message: 'Kelompok dihapus (anggota di-set inactive)' });
});

// Get all unique tipe values (built-in + dynamic from kegiatan pokok)
app.get('/api/kelompok-tipes', authenticate, (req, res) => {
  const builtIn = [
    { value: 'KAMAR', label: '🏠 Kamar', color: '#3b82f6', kategori: 'built-in' },
    { value: 'SOROGAN', label: '📖 Sorogan', color: '#8b5cf6', kategori: 'built-in' },
    { value: 'BAKAT', label: '🎨 Bakat', color: '#ec4899', kategori: 'built-in' },
    { value: 'SOROGAN_MALAM', label: '🌙 Sorogan Malam', color: '#6366f1', kategori: 'built-in' },
  ];
  // Dynamic tipe dari kegiatan pokok
  const pokokKegiatan = db.kegiatan.filter(k => k.kategori === 'pokok');
  const dynamicTipes = pokokKegiatan.map(k => ({
    value: k.nama, label: '📚 ' + k.nama, color: '#0d9488', kategori: 'pokok'
  }));
  // Tambahan (sub-grup system)
  const tambahan = [{ value: 'KEGIATAN', label: '📋 Kegiatan Tambahan', color: '#0d9488', kategori: 'tambahan' }];
  res.json([...builtIn, ...dynamicTipes, ...tambahan]);
});

// ── Santri Kelompok (Pivot/Membership) ─────────────────
app.get('/api/santri-kelompok', authenticate, (req, res) => {
  let list = db.santri_kelompok;
  if (req.query.santri_id) list = list.filter(sk => sk.santri_id == req.query.santri_id);
  if (req.query.kelompok_id) list = list.filter(sk => sk.kelompok_id == req.query.kelompok_id);
  if (req.query.status) list = list.filter(sk => sk.status === req.query.status);
  // Filter by kelompok tipe
  if (req.query.tipe) {
    const kelompokIds = db.kelompok.filter(k => k.tipe === req.query.tipe).map(k => k.id);
    list = list.filter(sk => kelompokIds.includes(sk.kelompok_id));
  }
  res.json(list.map(sk => {
    const s = db.santri.find(x => x.id === sk.santri_id);
    const k = db.kelompok.find(x => x.id === sk.kelompok_id);
    return {
      ...sk,
      santri_nama: s ? s.nama : '-',
      santri_nis: s ? s.nis || '' : '',
      kelompok_nama: k ? k.nama : '-',
      kelompok_tipe: k ? k.tipe : '-'
    };
  }));
});
app.post('/api/santri-kelompok', authenticate, requireAdmin, async (req, res) => {
  const { santri_id, kelompok_id } = req.body;
  if (!santri_id || !kelompok_id) return res.status(400).json({ message: 'santri_id & kelompok_id wajib' });
  const existing = db.santri_kelompok.find(sk => sk.santri_id == santri_id && sk.kelompok_id == kelompok_id && sk.status === 'aktif');
  if (existing) return res.status(400).json({ message: 'Santri sudah anggota kelompok ini' });
  const skData = { santri_id: parseInt(santri_id), kelompok_id: parseInt(kelompok_id), status: 'aktif', created_at: toDatetime() };
  const sk = await dbInsert('santri_kelompok', skData, db.santri_kelompok); res.json(sk);
});
// Bulk add: masukkan banyak santri ke 1 kelompok
app.post('/api/santri-kelompok/bulk', authenticate, requireAdmin, async (req, res) => {
  const { kelompok_id, santri_ids } = req.body;
  if (!kelompok_id || !santri_ids || !Array.isArray(santri_ids))
    return res.status(400).json({ message: 'kelompok_id & santri_ids (array) wajib' });
  let added = 0;
  for (const sid of santri_ids) {
    const existing = db.santri_kelompok.find(sk => sk.santri_id == sid && sk.kelompok_id == kelompok_id && sk.status === 'aktif');
    if (!existing) {
      await dbInsert('santri_kelompok', { santri_id: parseInt(sid), kelompok_id: parseInt(kelompok_id), status: 'aktif', created_at: toDatetime() }, db.santri_kelompok);
      added++;
    }
  }
  res.json({ message: `${added} santri ditambahkan`, added });
});
app.put('/api/santri-kelompok/deactivate', authenticate, requireAdmin, async (req, res) => {
  const { santri_id, kelompok_id } = req.body;
  if (!santri_id || !kelompok_id) return res.status(400).json({ message: 'santri_id & kelompok_id wajib' });
  const sk = db.santri_kelompok.find(x => x.santri_id == santri_id && x.kelompok_id == kelompok_id && x.status === 'aktif');
  if (!sk) return res.status(404).json({ message: 'Relasi tidak ditemukan' });
  await pool.execute('UPDATE santri_kelompok SET status = ? WHERE santri_id = ? AND kelompok_id = ?', ['inactive', santri_id, kelompok_id]);
  sk.status = 'inactive';
  res.json({ message: 'Anggota di-nonaktifkan (history tetap tersimpan)' });
});
app.delete('/api/santri-kelompok', authenticate, requireAdmin, async (req, res) => {
  const { santri_id, kelompok_id } = req.query;
  if (!santri_id || !kelompok_id) return res.status(400).json({ message: 'santri_id & kelompok_id wajib' });
  await pool.execute('DELETE FROM santri_kelompok WHERE santri_id = ? AND kelompok_id = ?', [santri_id, kelompok_id]);
  db.santri_kelompok = db.santri_kelompok.filter(sk => !(sk.santri_id == santri_id && sk.kelompok_id == kelompok_id));
  res.json({ message: 'Relasi dihapus permanen' });
});

// ── Absensi (Unified) ──────────────────────────────────────────
app.get('/api/absensi', authenticate, (req, res) => {
  let list = db.absensi;
  if (req.query.tanggal) list = list.filter(a => a.tanggal === req.query.tanggal);
  // Filter by kelompok_id (new unified system)
  if (req.query.kelompok_id) list = list.filter(a => a.kelompok_id == req.query.kelompok_id);
  // Filter by sesi_id (untuk bedain pagi/siang)
  if (req.query.sesi_id) list = list.filter(a => a.sesi_id == req.query.sesi_id);
  // Filter by kelompok tipe (e.g., ?kelompok_tipe=SEKOLAH) — also match kegiatan_nama
  if (req.query.kelompok_tipe) {
    const kelompokIds = db.kelompok.filter(k => k.tipe === req.query.kelompok_tipe || k.kegiatan_nama === req.query.kelompok_tipe).map(k => k.id);
    list = list.filter(a => kelompokIds.includes(a.kelompok_id));
  }
  // Backward compat: filter by kegiatan_id
  if (req.query.kegiatan_id) list = list.filter(a => a.kegiatan_id == req.query.kegiatan_id);
  // Filter by santri attributes
  const santriFilters = ['kamar_id', 'kelas_diniyyah', 'kelompok_ngaji', 'kelompok_ngaji_malam', 'jenis_bakat', 'kelas_sekolah'];
  santriFilters.forEach(f => {
    if (req.query[f]) {
      const santriIds = db.santri.filter(s => String(s[f]) === String(req.query[f])).map(s => s.id);
      list = list.filter(a => santriIds.includes(a.santri_id));
    }
  });
  // Filter by extra field
  if (req.query.extra_key && req.query.extra_val) {
    const santriIds = db.santri.filter(s => s.extra && s.extra[req.query.extra_key] === req.query.extra_val).map(s => s.id);
    list = list.filter(a => santriIds.includes(a.santri_id));
  }
  res.json(list.map(a => {
    const s = db.santri.find(x => x.id === a.santri_id);
    const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
    const kg = db.kegiatan.find(x => x.id === a.kegiatan_id);
    const kl = db.kelompok.find(x => x.id === a.kelompok_id);
    const u = db.users.find(x => x.id === a.recorded_by);
    return { ...a, santri_nama: s ? s.nama : '-', kamar_nama: k ? k.nama : '-', kegiatan_nama: kg ? kg.nama : '-', kelompok_nama: kl ? kl.nama : '-', kelompok_tipe: kl ? kl.tipe : '-', recorded_by_nama: u ? u.nama : '-' };
  }));
});
// ── Absensi by Kelompok (get santri yang bisa di-absen untuk kelompok tertentu) ──
app.get('/api/absensi/kelompok/:kelompok_id', authenticate, (req, res) => {
  const kelompokId = parseInt(req.params.kelompok_id);
  const kelompok = db.kelompok.find(k => k.id === kelompokId);
  if (!kelompok) return res.status(404).json({ message: 'Kelompok tidak ditemukan' });
  const tanggal = req.query.tanggal || new Date().toISOString().slice(0, 10);
  const sesiId = req.query.sesi_id ? parseInt(req.query.sesi_id) : null;
  // Ambil santri anggota kelompok (aktif)
  const anggota = db.santri_kelompok.filter(sk => sk.kelompok_id === kelompokId && sk.status === 'aktif');
  const santriList = anggota.map(sk => {
    const s = db.santri.find(x => x.id === sk.santri_id);
    if (!s) return null;
    // Cari absensi existing untuk tanggal + sesi ini
    let existing = db.absensi.find(a => a.santri_id === s.id && a.kelompok_id === kelompokId && a.tanggal === tanggal);
    if (sesiId) existing = db.absensi.find(a => a.santri_id === s.id && a.kelompok_id === kelompokId && a.tanggal === tanggal && a.sesi_id === sesiId);
    return {
      santri_id: s.id, nama: s.nama, kamar_id: s.kamar_id,
      status: existing ? existing.status : null,
      keterangan: existing ? existing.keterangan || '' : '',
      absensi_id: existing ? existing.id : null
    };
  }).filter(Boolean);
  res.json({ kelompok, tanggal, sesi_id: sesiId, santri: santriList });
});
app.post('/api/absensi/bulk', authenticate, async (req, res) => {
  try {
  if (req.user.role === 'wali') return res.status(403).json({ message: 'Wali tidak bisa mengubah absensi' });
  const { tanggal, kelompok_id, items } = req.body;
  if (!tanggal || !items || !items.length) return res.status(400).json({ message: 'Data tidak lengkap (tanggal, items wajib)' });
  const finalKelompokId = kelompok_id ? parseInt(kelompok_id) : null;
  if (!finalKelompokId) return res.status(400).json({ message: 'kelompok_id wajib' });

  // ── Validasi: sudah diabsen? ──
  const existing = db.absensi.find(a => a.kelompok_id === finalKelompokId && a.tanggal === tanggal);
  if (existing) {
    const kl = db.kelompok.find(k => k.id === finalKelompokId);
    return res.status(409).json({ message: `Sudah diabsen hari ini (${kl ? kl.nama : 'kelompok ' + finalKelompokId})`, already_done: true });
  }

  // ── Validasi Jadwal (untuk ustadz, bukan admin) ──
  const todayWIB = getWaktuWIB().toISOString().slice(0, 10);
  if (req.user.role !== 'admin' && tanggal === todayWIB) {
    const hari = getHariIni();
    const jadwalMatch = db.jadwal_umum.find(j =>
      j.kelompok_id === finalKelompokId && j.ustadz_username === req.user.username && j.hari === hari
    );
    if (!jadwalMatch) return res.status(403).json({ message: 'Anda tidak memiliki jadwal untuk kelompok ini hari ini' });
    if (!cekJadwalValid(jadwalMatch.jam_mulai, jadwalMatch.jam_selesai))
      return res.status(403).json({ message: `Di luar jam jadwal (${jadwalMatch.jam_mulai}-${jadwalMatch.jam_selesai}, toleransi 1 jam)` });
  }

  // ── Buat sesi baru di MariaDB ──
  const newSesi = await dbInsert('absensi_sesi', { ustadz_username: req.user.username, kelompok_id: finalKelompokId, tanggal }, db.absensi_sesi);

  // ── Insert absensi ke MariaDB ──
  for (const item of items) {
    await dbInsert('absensi', {
      santri_id: item.santri_id, kelompok_id: finalKelompokId, sesi_id: newSesi.id,
      tanggal, status: item.status, keterangan: item.keterangan || '',
      recorded_by: req.user.id
    }, db.absensi);
  }

  res.json({ message: 'Absensi tersimpan' });
  } catch(e) { console.error('absensi/bulk error:', e); res.status(500).json({ message: 'Server error' }); }
});

// ── Absen Malam (Tabel Terpisah) ───────────────────────
app.get('/api/absen-malam', authenticate, (req, res) => {
  // Read from unified absensi table
  const kelompok = db.kelompok.find(k => k.nama === 'Absen Malam' || k.nama === 'Ngaji Malam');
  const kelompokId = kelompok ? kelompok.id : null;
  let list = kelompokId ? db.absensi.filter(a => a.kelompok_id === kelompokId) : (db.absen_malam || []);
  if (req.query.tanggal) list = list.filter(a => a.tanggal === req.query.tanggal);
  if (req.query.kamar_id) {
    const santriIds = db.santri.filter(s => s.kamar_id == req.query.kamar_id).map(s => s.id);
    list = list.filter(a => santriIds.includes(a.santri_id));
  }
  res.json(list.map(a => {
    const s = db.santri.find(x => x.id === a.santri_id);
    const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
    return { ...a, nama: s ? s.nama : '-', kamar_nama: k ? k.nama : '-' };
  }));
});

app.post('/api/absen-malam/bulk', authenticate, async (req, res) => {
  if (req.user.role === 'wali') return res.status(403).json({ message: 'Wali tidak bisa mengubah absensi' });
  if (!db.absensi_sesi) db.absensi_sesi = [];
  const { tanggal, items } = req.body;
  if (!tanggal || !items) return res.status(400).json({ message: 'Data tidak lengkap (tanggal, items wajib)' });
  const kelompok = db.kelompok.find(k => k.nama === 'Absen Malam' || k.nama === 'Ngaji Malam');
  const kelompokId = kelompok ? kelompok.id : null;
  // ── Sesi: replace jika sudah ada ──
  const oldSesiMalam = db.absensi_sesi.find(s => s.ustadz_username === req.user.username && (s.kegiatan_nama === 'Absen Malam' || (kelompokId && s.kelompok_id === kelompokId)) && s.tanggal === tanggal);
  if (oldSesiMalam) {
    if (kelompokId) {
      await pool.execute('DELETE FROM absensi WHERE kelompok_id = ? AND tanggal = ? AND recorded_by = ?', [kelompokId, tanggal, req.user.id]);
      db.absensi = db.absensi.filter(a => !(a.kelompok_id === kelompokId && a.tanggal === tanggal && a.recorded_by === req.user.id));
    }
    if (!db.absen_malam) db.absen_malam = [];
    db.absen_malam = db.absen_malam.filter(a => !(a.tanggal === tanggal && a.recorded_by === req.user.id));
    oldSesiMalam.created_at = toDatetime();
  } else {
    const sesiData = { ustadz_username: req.user.username, kegiatan_id: 0, kelompok_id: kelompokId, kegiatan_nama: 'Absen Malam', tanggal, created_at: toDatetime() };
    const newSesi = await dbInsert('absensi_sesi', sesiData, db.absensi_sesi);
  }
  // Insert ke unified absensi
  for (const item of items) {
    await dbInsert('absensi', {
      santri_id: item.santri_id, kegiatan_id: null, kelompok_id: kelompokId, sesi_id: null,
      tanggal, status: item.status, keterangan: item.keterangan || '', recorded_by: req.user.id, created_at: toDatetime()
    }, db.absensi);
  }
  res.json({ message: 'Absen malam tersimpan (unified)' });
});

// ── Absen Sekolah (Tabel Terpisah) ─────────────────────
app.get('/api/absen-sekolah', authenticate, (req, res) => {
  // Read from unified absensi table
  const kelompok = db.kelompok.find(k => k.tipe === 'SEKOLAH');
  const kelompokId = kelompok ? kelompok.id : null;
  let list = kelompokId ? db.absensi.filter(a => a.kelompok_id === kelompokId) : (db.absen_sekolah || []);
  if (req.query.tanggal) list = list.filter(a => a.tanggal === req.query.tanggal);
  if (req.query.kelas_sekolah) {
    const santriIds = db.santri.filter(s => s.kelas_sekolah === req.query.kelas_sekolah).map(s => s.id);
    list = list.filter(a => santriIds.includes(a.santri_id));
  }
  res.json(list.map(a => {
    const s = db.santri.find(x => x.id === a.santri_id);
    const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
    return { ...a, nama: s ? s.nama : '-', kelas_sekolah: s ? s.kelas_sekolah || '-' : '-', kamar_nama: k ? k.nama : '-' };
  }));
});

app.post('/api/absen-sekolah/bulk', authenticate, async (req, res) => {
  if (req.user.role === 'wali') return res.status(403).json({ message: 'Wali tidak bisa mengubah absensi' });
  if (!db.absensi_sesi) db.absensi_sesi = [];
  const { tanggal, items, kelas, mata_pelajaran } = req.body;
  if (!tanggal || !items) return res.status(400).json({ message: 'Data tidak lengkap (tanggal, items wajib)' });

  // ── Validasi Jadwal Sekolah (untuk ustadz, bukan admin) ──
  const todayWIB2 = getWaktuWIB().toISOString().slice(0, 10);
  if (req.user.role !== 'admin' && tanggal === todayWIB2 && kelas && mata_pelajaran) {
    const hari = getHariIni();
    const jadwalMatch = db.jadwal_sekolah.find(j =>
      j.kelas === kelas && j.mata_pelajaran === mata_pelajaran && j.ustadz_username === req.user.username && j.hari === hari
    );
    if (!jadwalMatch) return res.status(403).json({ message: 'Anda tidak memiliki jadwal untuk pelajaran ini' });
    if (!cekJadwalValid(jadwalMatch.jam_mulai, jadwalMatch.jam_selesai))
      return res.status(403).json({ message: `Di luar jam jadwal (${jadwalMatch.jam_mulai}-${jadwalMatch.jam_selesai}, toleransi 1 jam)` });
  }

  const kelompok = db.kelompok.find(k => k.tipe === 'SEKOLAH');
  const kelompokId = kelompok ? kelompok.id : null;
  // ── Sesi: replace jika sudah ada ──
  const oldSesiSekolah = db.absensi_sesi.find(s => s.ustadz_username === req.user.username && (s.kegiatan_nama === 'Sekolah' || (kelompokId && s.kelompok_id === kelompokId)) && s.tanggal === tanggal && (!mata_pelajaran || s.mata_pelajaran === mata_pelajaran));
  if (oldSesiSekolah) {
    if (kelompokId) {
      let delSql = 'DELETE FROM absensi WHERE kelompok_id = ? AND tanggal = ? AND recorded_by = ?';
      const delParams = [kelompokId, tanggal, req.user.id];
      if (mata_pelajaran) { delSql += ' AND mata_pelajaran = ?'; delParams.push(mata_pelajaran); }
      await pool.execute(delSql, delParams);
      db.absensi = db.absensi.filter(a => !(a.kelompok_id === kelompokId && a.tanggal === tanggal && a.recorded_by === req.user.id && (!mata_pelajaran || a.mata_pelajaran === mata_pelajaran)));
    }
    if (!db.absen_sekolah) db.absen_sekolah = [];
    db.absen_sekolah = db.absen_sekolah.filter(a => !(a.tanggal === tanggal && a.recorded_by === req.user.id && (!mata_pelajaran || a.mata_pelajaran === mata_pelajaran)));
    oldSesiSekolah.created_at = toDatetime();
  } else {
    const sesiData = { ustadz_username: req.user.username, kegiatan_id: 0, kelompok_id: kelompokId, kegiatan_nama: 'Sekolah', kelas_sekolah: kelas || null, mata_pelajaran: mata_pelajaran || null, tanggal, created_at: toDatetime() };
    await dbInsert('absensi_sesi', sesiData, db.absensi_sesi);
  }
  // Insert ke unified absensi
  for (const item of items) {
    await dbInsert('absensi', {
      santri_id: item.santri_id, kegiatan_id: null, kelompok_id: kelompokId, sesi_id: null,
      tanggal, status: item.status, keterangan: item.keterangan || '', recorded_by: req.user.id, created_at: toDatetime()
    }, db.absensi);
  }
  res.json({ message: 'Absen sekolah tersimpan (unified)' });
});

// ── Rekap ──────────────────────────────────────────────
app.get('/api/rekap', authenticate, (req, res) => {
  // Rekap by kelompok_tipe (unified - recommended)
  if (req.query.kelompok_tipe) {
    // Match by tipe ATAU kegiatan_nama (kelompok bisa punya tipe="KEGIATAN" atau tipe=nama_kegiatan)
    const kelompokIds = db.kelompok.filter(k => k.tipe === req.query.kelompok_tipe || k.kegiatan_nama === req.query.kelompok_tipe).map(k => k.id);
    let list = db.absensi.filter(a => kelompokIds.includes(a.kelompok_id));
    if (req.query.dari) list = list.filter(a => a.tanggal >= req.query.dari);
    if (req.query.sampai) list = list.filter(a => a.tanggal <= req.query.sampai);
    if (req.query.kelompok_id) list = list.filter(a => a.kelompok_id == req.query.kelompok_id);
    return res.json(list.map(a => {
      const s = db.santri.find(x => x.id === a.santri_id);
      const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
      const kl = db.kelompok.find(x => x.id === a.kelompok_id);
      const isSekolah = kl && kl.tipe === 'SEKOLAH';
      const kegNama = kl ? (kl.kegiatan_nama || (kl.tipe === 'KEGIATAN' ? kl.nama : kl.tipe)) : '-';
      return { tanggal: a.tanggal, nama: s ? s.nama : '-', kamar_nama: k ? k.nama : '-', kelompok_nama: isSekolah ? (s ? (s.kelas_sekolah || '-') : '-') : (kl ? kl.nama : '-'), kegiatan_nama: kegNama, status: a.status, keterangan: a.keterangan };
    }).sort((a, b) => b.tanggal.localeCompare(a.tanggal)));
  }
  // Rekap by kelompok_id (unified)
  if (req.query.kelompok_id && !req.query.tipe) {
    let list = db.absensi.filter(a => a.kelompok_id == req.query.kelompok_id);
    if (req.query.dari) list = list.filter(a => a.tanggal >= req.query.dari);
    if (req.query.sampai) list = list.filter(a => a.tanggal <= req.query.sampai);
    const kl = db.kelompok.find(k => k.id == req.query.kelompok_id);
    return res.json(list.map(a => {
      const s = db.santri.find(x => x.id === a.santri_id);
      const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
      return { tanggal: a.tanggal, nama: s ? s.nama : '-', kamar_nama: k ? k.nama : '-', kelompok_nama: kl ? kl.nama : '-', kegiatan_nama: kl ? kl.nama : '-', status: a.status, keterangan: a.keterangan };
    }).sort((a, b) => b.tanggal.localeCompare(a.tanggal)));
  }
  // Rekap Absen Malam - backward compat (reads from unified absensi)
  if (req.query.tipe === 'absen_malam') {
    let list = db.absen_malam || [];
    if (req.query.dari) list = list.filter(a => a.tanggal >= req.query.dari);
    if (req.query.sampai) list = list.filter(a => a.tanggal <= req.query.sampai);
    const santriFilters = ['kamar_id', 'kelompok_ngaji_malam'];
    santriFilters.forEach(f => {
      if (req.query[f]) {
        const santriIds = db.santri.filter(s => String(s[f]) === String(req.query[f])).map(s => s.id);
        list = list.filter(a => santriIds.includes(a.santri_id));
      }
    });
    return res.json(list.map(a => {
      const s = db.santri.find(x => x.id === a.santri_id);
      const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
      return { tanggal: a.tanggal, nama: s ? s.nama : '-', kamar_nama: k ? k.nama : '-', kegiatan_nama: 'Absen Malam', status: a.status, keterangan: a.keterangan };
    }).sort((a, b) => b.tanggal.localeCompare(a.tanggal)));
  }
  // Rekap Absen Sekolah - from unified absensi table
  if (req.query.tipe === 'absen_sekolah') {
    const sk = db.kelompok.find(k => k.tipe === 'SEKOLAH');
    let list = sk ? db.absensi.filter(a => a.kelompok_id === sk.id) : [];
    if (req.query.dari) list = list.filter(a => a.tanggal >= req.query.dari);
    if (req.query.sampai) list = list.filter(a => a.tanggal <= req.query.sampai);
    if (req.query.kelas_sekolah) {
      const santriIds = db.santri.filter(s => s.kelas_sekolah === req.query.kelas_sekolah).map(s => s.id);
      list = list.filter(a => santriIds.includes(a.santri_id));
    }
    return res.json(list.map(a => {
      const s = db.santri.find(x => x.id === a.santri_id);
      const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
      return { tanggal: a.tanggal, nama: s ? s.nama : '-', kamar_nama: k ? k.nama : '-', kelompok_nama: s ? (s.kelas_sekolah || '-') : '-', kegiatan_nama: 'Sekolah', status: a.status, keterangan: a.keterangan || '' };
    }).sort((a, b) => b.tanggal.localeCompare(a.tanggal)));
  }
  // Rekap Absensi biasa - GABUNGAN semua (absensi + absen_malam + absen_sekolah)
  // Convert absen_malam to unified format
  let malamList = (db.absen_malam || []).map(a => {
    const s = db.santri.find(x => x.id === a.santri_id);
    const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
    return { tanggal: a.tanggal, nama: s ? s.nama : '-', kamar_nama: k ? k.nama : '-', kelompok_nama: '-', kegiatan_nama: 'Absen Malam', status: a.status, keterangan: a.keterangan || '' };
  });
  // Convert absen_sekolah to unified format
  let sekolahList = (db.absen_sekolah || []).map(a => {
    const s = db.santri.find(x => x.id === a.santri_id);
    const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
    return { tanggal: a.tanggal, nama: s ? s.nama : '-', kamar_nama: k ? k.nama : '-', kelompok_nama: s ? (s.kelas_sekolah || '-') : '-', kegiatan_nama: 'Sekolah', status: a.status, keterangan: a.keterangan || '' };
  });
  // Main absensi
  const sekolahKelompok = db.kelompok.find(k => k.tipe === 'SEKOLAH');
  let list = db.absensi.map(a => {
    const s = db.santri.find(x => x.id === a.santri_id);
    const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
    const kg = db.kegiatan.find(x => x.id === a.kegiatan_id);
    const kl = db.kelompok.find(x => x.id === a.kelompok_id);
    // For Sekolah: kelompok_nama = kelas, kegiatan_nama = Sekolah
    const isSekolah = sekolahKelompok && a.kelompok_id === sekolahKelompok.id;
    const kegNama = isSekolah ? 'Sekolah' : (kg ? kg.nama : (kl ? (kl.kegiatan_nama || (kl.tipe === 'KEGIATAN' ? kl.nama : kl.tipe)) : '-'));
    return { tanggal: a.tanggal, nama: s ? s.nama : '-', kamar_nama: k ? k.nama : '-', kelompok_nama: isSekolah ? (s ? (s.kelas_sekolah || '-') : '-') : (kl ? kl.nama : '-'), kegiatan_nama: kegNama, status: a.status, keterangan: a.keterangan || '' };
  });
  // Merge all
  let allList = [...list, ...malamList, ...sekolahList];
  // Apply date filter
  if (req.query.dari) allList = allList.filter(a => a.tanggal >= req.query.dari);
  if (req.query.sampai) allList = allList.filter(a => a.tanggal <= req.query.sampai);
  // Apply kamar filter
  if (req.query.kamar_id) {
    const kamarNama = (db.kamar.find(k => k.id == req.query.kamar_id) || {}).nama;
    if (kamarNama) allList = allList.filter(a => a.kamar_nama === kamarNama);
  }
  res.json(allList.sort((a, b) => b.tanggal.localeCompare(a.tanggal)));
});

// ── Pengumuman ─────────────────────────────────────────
app.get('/api/pengumuman', authenticate, (req, res) => {
  res.json(db.pengumuman.map(p => {
    const u = db.users.find(x => x.id === p.created_by);
    return { ...p, created_by_nama: u ? u.nama : 'Admin' };
  }).sort((a, b) => b.created_at.localeCompare(a.created_at)));
});
app.post('/api/pengumuman', authenticate, requireAdmin, async (req, res) => {
  const { judul, isi } = req.body;
  if (!judul || !isi) return res.status(400).json({ message: 'Judul & isi wajib' });
  const pData = { judul, isi, created_by: req.user.id, created_at: toDatetime() };
  const p = await dbInsert('pengumuman', pData, db.pengumuman); res.json(p);
});
app.delete('/api/pengumuman/:id', authenticate, requireAdmin, async (req, res) => {
  await dbDelete('pengumuman', parseInt(req.params.id), db.pengumuman);
  res.json({ message: 'Pengumuman dihapus' });
});

// ── Pelanggaran ──────────────────────────────────────────
app.get('/api/pelanggaran', authenticate, (req, res) => {
  let list = db.pelanggaran || [];
  if (req.query.santri_id) list = list.filter(p => p.santri_id == req.query.santri_id);
  if (req.query.dari) list = list.filter(p => p.tanggal >= req.query.dari);
  if (req.query.sampai) list = list.filter(p => p.tanggal <= req.query.sampai);
  res.json(list.map(p => {
    const s = db.santri.find(x => x.id === p.santri_id);
    return { ...p, santri_nama: s ? s.nama : '-' };
  }).sort((a, b) => b.tanggal.localeCompare(a.tanggal)));
});
app.post('/api/pelanggaran', authenticate, requireAdmin, async (req, res) => {
  const { santri_id, tanggal, jenis, keterangan, sanksi } = req.body;
  if (!santri_id || !tanggal || !jenis) return res.status(400).json({ message: 'Santri, tanggal & jenis wajib' });
  if (!db.pelanggaran) db.pelanggaran = [];
  const pData = { santri_id: parseInt(santri_id), tanggal, jenis, keterangan: keterangan || '', sanksi: sanksi || '', created_at: toDatetime() };
  const p = await dbInsert('pelanggaran', pData, db.pelanggaran); res.json(p);
});
app.put('/api/pelanggaran/:id', authenticate, requireAdmin, async (req, res) => {
  if (!db.pelanggaran) return res.status(404).json({ message: 'Tidak ditemukan' });
  const p = db.pelanggaran.find(x => x.id == req.params.id);
  if (!p) return res.status(404).json({ message: 'Tidak ditemukan' });
  const updates = {};
  ['tanggal', 'jenis', 'keterangan', 'sanksi'].forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (req.body.santri_id) updates.santri_id = parseInt(req.body.santri_id);
  if (Object.keys(updates).length) await dbUpdate('pelanggaran', p.id, updates, db.pelanggaran);
  res.json({ message: 'Pelanggaran diupdate' });
});
app.delete('/api/pelanggaran/:id', authenticate, requireAdmin, async (req, res) => {
  if (!db.pelanggaran) return res.status(404).json({ message: 'Tidak ditemukan' });
  await dbDelete('pelanggaran', parseInt(req.params.id), db.pelanggaran);
  res.json({ message: 'Pelanggaran dihapus' });
});

// ── Catatan Guru ────────────────────────────────────────
app.get('/api/catatan', authenticate, (req, res) => {
  let list = db.catatan_guru || [];
  // Wali: only see notes for their children
  if (req.user.role === 'wali') {
    const anakIds = db.santri.filter(s => s.wali_user_id === req.user.id).map(s => s.id);
    list = list.filter(c => anakIds.includes(c.santri_id));
  }
  if (req.query.santri_id) list = list.filter(c => c.santri_id == req.query.santri_id);
  if (req.query.kategori) list = list.filter(c => c.kategori === req.query.kategori);
  if (req.query.dari) list = list.filter(c => c.tanggal >= req.query.dari);
  if (req.query.sampai) list = list.filter(c => c.tanggal <= req.query.sampai);
  res.json(list.map(c => {
    const s = db.santri.find(x => x.id === c.santri_id);
    const u = db.users.find(x => x.id === c.created_by);
    return { ...c, santri_nama: s ? s.nama : '-', guru_nama: u ? u.nama : '-' };
  }).sort((a, b) => b.tanggal.localeCompare(a.tanggal)));
});
app.post('/api/catatan', authenticate, async (req, res) => {
  if (req.user.role === 'wali') return res.status(403).json({ message: 'Wali tidak bisa membuat catatan' });
  const { santri_id, tanggal, judul, isi, kategori } = req.body;
  if (!santri_id || !tanggal || !isi) return res.status(400).json({ message: 'Santri, tanggal & isi wajib' });
  if (!db.catatan_guru) db.catatan_guru = [];
  const cData = {
    santri_id: parseInt(santri_id), tanggal,
    judul: judul || '', isi, kategori: kategori || 'lainnya',
    created_by: req.user.id, created_at: toDatetime()
  };
  const c = await dbInsert('catatan_guru', cData, db.catatan_guru); res.json(c);
});
app.put('/api/catatan/:id', authenticate, async (req, res) => {
  if (req.user.role === 'wali') return res.status(403).json({ message: 'Wali tidak bisa mengubah catatan' });
  if (!db.catatan_guru) return res.status(404).json({ message: 'Tidak ditemukan' });
  const c = db.catatan_guru.find(x => x.id == req.params.id);
  if (!c) return res.status(404).json({ message: 'Tidak ditemukan' });
  const updates = {};
  ['santri_id', 'tanggal', 'judul', 'isi', 'kategori'].forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (req.body.santri_id) updates.santri_id = parseInt(req.body.santri_id);
  if (Object.keys(updates).length) await dbUpdate('catatan_guru', c.id, updates, db.catatan_guru);
  res.json({ message: 'Catatan diupdate' });
});
app.delete('/api/catatan/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Hanya admin' });
  if (!db.catatan_guru) return res.status(404).json({ message: 'Tidak ditemukan' });
  await dbDelete('catatan_guru', parseInt(req.params.id), db.catatan_guru);
  res.json({ message: 'Catatan dihapus' });
});

// ── Download All Raport (Excel) ──────────────────────────
app.get('/api/raport/download-all', authenticate, async (req, res) => {
  const appName = (db.settings && db.settings.app_name) || 'Pesantren';
  let santriList = db.santri.filter(s => s.status === 'aktif');
  if (!santriList.length) return res.status(404).json({ message: 'Tidak ada santri aktif' });

  function getKegiatanLabel(kl) {
    if (!kl) return '-';
    if (kl.tipe === 'SEKOLAH') return 'Absen Sekolah';
    if (kl.kegiatan_nama) return kl.kegiatan_nama + ' (' + kl.nama + ')';
    return kl.tipe.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + ' (' + kl.nama + ')';
  }

  // Collect all unique kegiatan labels
  const allKegiatan = new Set();
  const santriRekap = {};
  santriList.forEach(s => {
    let absensiList = db.absensi.filter(a => a.santri_id === s.id);
    if (req.query.dari) absensiList = absensiList.filter(a => a.tanggal >= req.query.dari);
    if (req.query.sampai) absensiList = absensiList.filter(a => a.tanggal <= req.query.sampai);
    const rekap = {};
    absensiList.forEach(a => {
      const kl = db.kelompok.find(k => k.id === a.kelompok_id);
      if (!kl) return;
      const label = getKegiatanLabel(kl);
      allKegiatan.add(label);
      if (!rekap[label]) rekap[label] = { H: 0, I: 0, S: 0, A: 0 };
      rekap[label][a.status]++;
    });
    // Absen Malam
    let absenMalamList = (db.absen_malam || []).filter(a => a.santri_id === s.id);
    if (req.query.dari) absenMalamList = absenMalamList.filter(a => a.tanggal >= req.query.dari);
    if (req.query.sampai) absenMalamList = absenMalamList.filter(a => a.tanggal <= req.query.sampai);
    if (absenMalamList.length) {
      rekap['Absen Malam'] = { H: 0, I: 0, S: 0, A: 0 };
      absenMalamList.forEach(a => rekap['Absen Malam'][a.status]++);
      allKegiatan.add('Absen Malam');
    }
    santriRekap[s.id] = { santri: s, rekap };
  });

  const kegiatanList = Array.from(allKegiatan).sort();

  // Buat Excel
  const wb = new ExcelJS.Workbook();
  wb.creator = appName;

  // Sheet 1: Rekap Semua Santri
  const ws = wb.addWorksheet('Rekap Semua');
  ws.mergeCells('A1:' + String.fromCharCode(65 + kegiatanList.length * 4) + '1');
  ws.getCell('A1').value = appName + ' - REKAP RAPOR SEMUA SANTRI';
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A1').alignment = { horizontal: 'center' };

  // Header row
  let col = 1;
  ws.getCell(3, col++).value = 'No';
  ws.getCell(3, col++).value = 'Nama Santri';
  ws.getCell(3, col++).value = 'Asrama';
  kegiatanList.forEach(k => {
    ws.getCell(3, col++).value = k + ' (H)';
    ws.getCell(3, col++).value = k + ' (I)';
    ws.getCell(3, col++).value = k + ' (S)';
    ws.getCell(3, col++).value = k + ' (A)';
  });
  ws.getCell(3, col++).value = 'Total H';
  ws.getCell(3, col++).value = 'Total I';
  ws.getCell(3, col++).value = 'Total S';
  ws.getCell(3, col++).value = 'Total A';
  // Style header
  for (let c = 1; c < col; c++) {
    ws.getCell(3, c).font = { bold: true, size: 8 };
    ws.getCell(3, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
    ws.getCell(3, c).alignment = { horizontal: 'center', wrapText: true };
  }

  // Data rows
  let row = 4;
  santriList.forEach((s, idx) => {
    const kamar = db.kamar.find(k => k.id === s.kamar_id);
    const { rekap } = santriRekap[s.id];
    let c = 1;
    ws.getCell(row, c++).value = idx + 1;
    ws.getCell(row, c++).value = s.nama;
    ws.getCell(row, c++).value = kamar ? kamar.nama : '-';
    let totalH = 0, totalI = 0, totalS = 0, totalA = 0;
    kegiatanList.forEach(k => {
      const r = rekap[k] || { H: 0, I: 0, S: 0, A: 0 };
      ws.getCell(row, c++).value = r.H;
      ws.getCell(row, c++).value = r.I;
      ws.getCell(row, c++).value = r.S;
      ws.getCell(row, c++).value = r.A;
      totalH += r.H; totalI += r.I; totalS += r.S; totalA += r.A;
    });
    ws.getCell(row, c++).value = totalH;
    ws.getCell(row, c++).value = totalI;
    ws.getCell(row, c++).value = totalS;
    ws.getCell(row, c++).value = totalA;
    row++;
  });

  // Column widths
  ws.getColumn(1).width = 5;
  ws.getColumn(2).width = 20;
  ws.getColumn(3).width = 15;
  for (let c = 4; c < col; c++) ws.getColumn(c).width = 8;

  // Per-santri sheets
  santriList.forEach(s => {
    const kamar = db.kamar.find(k => k.id === s.kamar_id);
    const { rekap } = santriRekap[s.id];
    const sheetName = s.nama.substring(0, 31); // Excel max 31 chars
    const ws2 = wb.addWorksheet(sheetName);
    ws2.mergeCells('A1:F1'); ws2.getCell('A1').value = appName; ws2.getCell('A1').font = { bold: true, size: 12 }; ws2.getCell('A1').alignment = { horizontal: 'center' };
    ws2.getCell('A3').value = 'Nama'; ws2.getCell('A3').font = { bold: true }; ws2.getCell('B3').value = ': ' + s.nama;
    ws2.getCell('A4').value = 'Asrama'; ws2.getCell('A4').font = { bold: true }; ws2.getCell('B4').value = ': ' + (kamar ? kamar.nama : '-');
    ws2.getCell('A6').value = 'Kegiatan'; ws2.getCell('B6').value = 'H'; ws2.getCell('C6').value = 'I'; ws2.getCell('D6').value = 'S'; ws2.getCell('E6').value = 'A'; ws2.getCell('F6').value = 'Total';
    ['A6','B6','C6','D6','E6','F6'].forEach(c => { ws2.getCell(c).font = { bold: true }; });
    let r = 7;
    Object.entries(rekap).forEach(([keg, v]) => {
      ws2.getCell('A' + r).value = keg;
      ws2.getCell('B' + r).value = v.H;
      ws2.getCell('C' + r).value = v.I;
      ws2.getCell('D' + r).value = v.S;
      ws2.getCell('E' + r).value = v.A;
      ws2.getCell('F' + r).value = v.H + v.I + v.S + v.A;
      r++;
    });
    ws2.getColumn(1).width = 30;
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=raport-semua-santri.xlsx');
  await wb.xlsx.write(res);
  res.end();
});

// ── Raport Santri ───────────────────────────────────────

// ── Raport Santri ───────────────────────────────────────
app.get('/api/raport/:santri_id', authenticate, (req, res) => {
  const santri = db.santri.find(s => s.id == req.params.santri_id);
  if (!santri) return res.status(404).json({ message: 'Santri tidak ditemukan' });
  const kamar = db.kamar.find(k => k.id === santri.kamar_id);
  let absensiList = db.absensi.filter(a => a.santri_id === santri.id);
  if (req.query.dari) absensiList = absensiList.filter(a => a.tanggal >= req.query.dari);
  if (req.query.sampai) absensiList = absensiList.filter(a => a.tanggal <= req.query.sampai);
  let pelanggaranList = (db.pelanggaran || []).filter(p => p.santri_id === santri.id);
  if (req.query.dari) pelanggaranList = pelanggaranList.filter(p => p.tanggal >= req.query.dari);
  if (req.query.sampai) pelanggaranList = pelanggaranList.filter(p => p.tanggal <= req.query.sampai);
  let catatanList = (db.catatan_guru || []).filter(c => c.santri_id === santri.id);
  if (req.query.dari) catatanList = catatanList.filter(c => c.tanggal >= req.query.dari);
  if (req.query.sampai) catatanList = catatanList.filter(c => c.tanggal <= req.query.sampai);
  // Helper: dapat label kegiatan dari kelompok
  function getKegiatanLabel(kl) {
    if (kl.tipe === 'SEKOLAH') return 'Absen Sekolah';
    if (kl.tipe === 'KAMAR') return 'Kamar (' + kl.nama + ')';
    if (kl.kegiatan_nama) return kl.kegiatan_nama + ' (' + kl.nama + ')';
    const tipeLabel = kl.tipe.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return tipeLabel + ' (' + kl.nama + ')';
  }

  // ── Group absensi berdasarkan kelompok (tampilkan kegiatan yang punya data absensi) ──
  const rekap = {};
  absensiList.forEach(a => {
    const kl = db.kelompok.find(k => k.id === a.kelompok_id);
    if (!kl) return;
    const label = getKegiatanLabel(kl);
    if (!rekap[label]) rekap[label] = { H: 0, I: 0, S: 0, A: 0, detail: [] };
    rekap[label][a.status] = (rekap[label][a.status] || 0) + 1;
    rekap[label].detail.push({ tanggal: a.tanggal, status: a.status, keterangan: a.keterangan });
  });

  // ── Tambah Absen Malam dari tabel terpisah ──
  let absenMalamList = (db.absen_malam || []).filter(a => a.santri_id === santri.id);
  if (req.query.dari) absenMalamList = absenMalamList.filter(a => a.tanggal >= req.query.dari);
  if (req.query.sampai) absenMalamList = absenMalamList.filter(a => a.tanggal <= req.query.sampai);
  if (absenMalamList.length) {
    rekap['Absen Malam'] = { H: 0, I: 0, S: 0, A: 0, detail: [] };
    absenMalamList.forEach(a => {
      rekap['Absen Malam'][a.status] = (rekap['Absen Malam'][a.status] || 0) + 1;
      rekap['Absen Malam'].detail.push({ tanggal: a.tanggal, status: a.status, keterangan: a.keterangan });
    });
  }
  res.json({
    santri: { ...santri, kamar_nama: kamar ? kamar.nama : '-' },
    periode: { dari: req.query.dari || '-', sampai: req.query.sampai || '-' },
    rekap,
    pelanggaran: pelanggaranList.sort((a, b) => b.tanggal.localeCompare(a.tanggal)),
    catatan_guru: catatanList.map(c => {
      const u = db.users.find(x => x.id === c.created_by);
      return { ...c, guru_nama: u ? u.nama : '-' };
    }).sort((a, b) => b.tanggal.localeCompare(a.tanggal))
  });
});

// ── Export Raport Excel (Per Santri) ────────────────────
app.get('/api/raport/:santri_id/excel', authenticate, async (req, res) => {
  const santri = db.santri.find(s => s.id == req.params.santri_id);
  if (!santri) return res.status(404).json({ message: 'Santri tidak ditemukan' });
  const kamar = db.kamar.find(k => k.id === santri.kamar_id);
  let absensiList = db.absensi.filter(a => a.santri_id === santri.id);
  if (req.query.dari) absensiList = absensiList.filter(a => a.tanggal >= req.query.dari);
  if (req.query.sampai) absensiList = absensiList.filter(a => a.tanggal <= req.query.sampai);
  function getKegiatanLabel(kl) {
    if (!kl) return '-';
    if (kl.tipe === 'SEKOLAH') return 'Absen Sekolah';
    if (kl.kegiatan_nama) return kl.kegiatan_nama + ' (' + kl.nama + ')';
    return kl.tipe.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + ' (' + kl.nama + ')';
  }
  const rekap = {};
  absensiList.forEach(a => {
    const kl = db.kelompok.find(k => k.id === a.kelompok_id);
    if (!kl) return;
    const label = getKegiatanLabel(kl);
    if (!rekap[label]) rekap[label] = { H: 0, I: 0, S: 0, A: 0 };
    rekap[label][a.status]++;
  });
  // Absen Malam
  let absenMalamList = (db.absen_malam || []).filter(a => a.santri_id === santri.id);
  if (req.query.dari) absenMalamList = absenMalamList.filter(a => a.tanggal >= req.query.dari);
  if (req.query.sampai) absenMalamList = absenMalamList.filter(a => a.tanggal <= req.query.sampai);
  if (absenMalamList.length) { rekap['Absen Malam'] = { H: 0, I: 0, S: 0, A: 0 }; absenMalamList.forEach(a => rekap['Absen Malam'][a.status]++); }
  // Buat Excel
  const appName = (db.settings && db.settings.app_name) || 'Pesantren';
  const wb = new ExcelJS.Workbook();
  wb.creator = appName;
  const ws = wb.addWorksheet('Raport');
  // Header
  ws.mergeCells('A1:F1'); ws.getCell('A1').value = appName; ws.getCell('A1').font = { bold: true, size: 14 }; ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.mergeCells('A2:F2'); ws.getCell('A2').value = 'RAPOR SANTRI'; ws.getCell('A2').font = { bold: true, size: 12 }; ws.getCell('A2').alignment = { horizontal: 'center' };
  // Info santri
  ws.getCell('A4').value = 'Nama Santri'; ws.getCell('A4').font = { bold: true }; ws.getCell('B4').value = ': ' + santri.nama;
  ws.getCell('A5').value = 'Asrama'; ws.getCell('A5').font = { bold: true }; ws.getCell('B5').value = ': ' + (kamar ? kamar.nama : '-');
  ws.getCell('A6').value = 'Periode'; ws.getCell('A6').font = { bold: true }; ws.getCell('B6').value = ': ' + (req.query.dari || '-') + ' s/d ' + (req.query.sampai || '-');
  // Tabel rekap
  ws.getCell('A8').value = 'Kegiatan'; ws.getCell('B8').value = 'Hadir'; ws.getCell('C8').value = 'Izin'; ws.getCell('D8').value = 'Sakit'; ws.getCell('E8').value = 'Alpa'; ws.getCell('F8').value = 'Total';
  ['A8','B8','C8','D8','E8','F8'].forEach(c => { ws.getCell(c).font = { bold: true }; ws.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } }; });
  let row = 9;
  Object.entries(rekap).forEach(([keg, r]) => {
    const total = r.H + r.I + r.S + r.A;
    ws.getCell('A' + row).value = keg;
    ws.getCell('B' + row).value = r.H;
    ws.getCell('C' + row).value = r.I;
    ws.getCell('D' + row).value = r.S;
    ws.getCell('E' + row).value = r.A;
    ws.getCell('F' + row).value = total;
    row++;
  });
  // Total
  const totalH = Object.values(rekap).reduce((s, r) => s + r.H, 0);
  const totalI = Object.values(rekap).reduce((s, r) => s + r.I, 0);
  const totalS = Object.values(rekap).reduce((s, r) => s + r.S, 0);
  const totalA = Object.values(rekap).reduce((s, r) => s + r.A, 0);
  ws.getCell('A' + row).value = 'TOTAL'; ws.getCell('A' + row).font = { bold: true };
  ws.getCell('B' + row).value = totalH; ws.getCell('C' + row).value = totalI; ws.getCell('D' + row).value = totalS; ws.getCell('E' + row).value = totalA;
  ws.getCell('F' + row).value = totalH + totalI + totalS + totalA; ws.getCell('F' + row).font = { bold: true };
  // Column widths
  ws.columns = [{ width: 30 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=raport-' + santri.nama.replace(/\s+/g, '-') + '.xlsx');
  await wb.xlsx.write(res);
  res.end();
});

// ── Export Raport PDF (4-Zone Layout) ───────────────────
app.get('/api/raport/:santri_id/pdf', authenticate, (req, res) => {
  const santri = db.santri.find(s => s.id == req.params.santri_id);
  if (!santri) return res.status(404).json({ message: 'Santri tidak ditemukan' });
  const kamar = db.kamar.find(k => k.id === santri.kamar_id);
  // Absensi rekap — berdasarkan kelompok yang ada datanya
  let absensiList = db.absensi.filter(a => a.santri_id === santri.id);
  if (req.query.dari) absensiList = absensiList.filter(a => a.tanggal >= req.query.dari);
  if (req.query.sampai) absensiList = absensiList.filter(a => a.tanggal <= req.query.sampai);
  function getKegiatanLabel(kl) {
    if (kl.tipe === 'SEKOLAH') return 'Absen Sekolah';
    if (kl.tipe === 'KAMAR') return 'Kamar (' + kl.nama + ')';
    if (kl.kegiatan_nama) return kl.kegiatan_nama + ' (' + kl.nama + ')';
    const tipeLabel = kl.tipe.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return tipeLabel + ' (' + kl.nama + ')';
  }
  const rekap = {};
  absensiList.forEach(a => {
    const kl = db.kelompok.find(k => k.id === a.kelompok_id);
    if (!kl) return;
    const label = getKegiatanLabel(kl);
    if (!rekap[label]) rekap[label] = { H: 0, I: 0, S: 0, A: 0 };
    rekap[label][a.status]++;
  });
  // Absen Malam
  let absenMalamList = (db.absen_malam || []).filter(a => a.santri_id === santri.id);
  if (req.query.dari) absenMalamList = absenMalamList.filter(a => a.tanggal >= req.query.dari);
  if (req.query.sampai) absenMalamList = absenMalamList.filter(a => a.tanggal <= req.query.sampai);
  if (absenMalamList.length) {
    rekap['Absen Malam'] = { H: 0, I: 0, S: 0, A: 0 };
    absenMalamList.forEach(a => rekap['Absen Malam'][a.status]++);
  }
  // Pelanggaran & Catatan
  let pelanggaranList = (db.pelanggaran || []).filter(p => p.santri_id === santri.id);
  if (req.query.dari) pelanggaranList = pelanggaranList.filter(p => p.tanggal >= req.query.dari);
  if (req.query.sampai) pelanggaranList = pelanggaranList.filter(p => p.tanggal <= req.query.sampai);
  let catatanList = (db.catatan_guru || []).filter(c => c.santri_id === santri.id);
  if (req.query.dari) catatanList = catatanList.filter(c => c.tanggal >= req.query.dari);
  if (req.query.sampai) catatanList = catatanList.filter(c => c.tanggal <= req.query.sampai);
  // Wali & Settings
  const wali = santri.wali_user_id ? db.users.find(u => u.id === santri.wali_user_id) : null;
  const appName = (db.settings && db.settings.app_name) || 'Pesantren';
  const kepalaNama = (db.settings && db.settings.kepala_nama) || '';
  const alamatLembaga = (db.settings && db.settings.alamat_lembaga) || '';
  const namaKota = (db.settings && db.settings.nama_kota) || '';
  const logoData = (db.settings && db.settings.logo) || '';
  // Periode label
  const bulanNama = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const sampaiDate = req.query.sampai ? new Date(req.query.sampai) : new Date();
  const periodeLabel = bulanNama[sampaiDate.getMonth() + 1] + ' ' + sampaiDate.getFullYear();
  // Totals
  const totalH = Object.values(rekap).reduce((s, r) => s + r.H, 0);
  const totalI = Object.values(rekap).reduce((s, r) => s + r.I, 0);
  const totalS = Object.values(rekap).reduce((s, r) => s + r.S, 0);
  const totalA = Object.values(rekap).reduce((s, r) => s + r.A, 0);
  const totalAll = totalH + totalI + totalS + totalA;
  // Build PDF
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=raport-' + santri.nama.replace(/\s+/g, '-') + '.pdf');
  doc.pipe(res);
  const L = 40, R = 555, W = R - L;
  let yy = 40;
  // Wali display
  const waliDisplay = (wali && wali.nama && wali.nama !== '-') ? wali.nama : '......................................';
  const kepalaDisplay = (kepalaNama && kepalaNama !== '-') ? kepalaNama : '......................................';
  // Tempat & tanggal cetak
  const namaBulan = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const tglCetak = new Date();
  const tglStr = (namaKota ? namaKota + ', ' : '') + tglCetak.getDate() + ' ' + namaBulan[tglCetak.getMonth() + 1] + ' ' + tglCetak.getFullYear();
  // ── ZONA 1: KOP SURAT (3 kolom: 15%-70%-15%) ──
  const logoW = 75; // 15% of ~515 = ~75
  const textX = L + logoW;
  const textW = W - logoW * 2;
  // Logo kiri
  if (logoData && logoData.startsWith('data:')) {
    try {
      const base64 = logoData.split(',')[1];
      const buf = Buffer.from(base64, 'base64');
      doc.image(buf, L, yy, { width: 50, height: 50 });
    } catch (e) {}
  }
  // Teks tengah - hierarki
  doc.fontSize(14).font('Helvetica-Bold').text(appName, textX, yy, { width: textW, align: 'center' });
  yy += 18;
  doc.fontSize(11).font('Helvetica-Bold').text('LAPORAN BULANAN PERKEMBANGAN SANTRI', textX, yy, { width: textW, align: 'center' });
  yy += 14;
  doc.fontSize(8).font('Helvetica').text(alamatLembaga || '', textX, yy, { width: textW, align: 'center' });
  yy += 14;
  // Garis ganda penuh
  doc.moveTo(L, yy + 4).lineTo(R, yy + 4).lineWidth(1.5).stroke();
  doc.moveTo(L, yy + 7).lineTo(R, yy + 7).lineWidth(0.5).stroke();
  yy += 16;
  // ── ZONA 2: IDENTITAS (6 kolom titik dua sejajar) ──
  doc.fontSize(9);
  const lbl1X = L, col1X = L + 85, val1X = L + 95;
  const lbl2X = 320, col2X = 320 + 85, val2X = 320 + 95;
  const dataW = 135;
  // Baris 1
  doc.font('Helvetica-Bold').text('Nama Santri', lbl1X, yy, { width: 85 });
  doc.text(':', col1X, yy);
  doc.font('Helvetica').text(santri.nama, val1X, yy, { width: dataW });
  doc.font('Helvetica-Bold').text('Kelas Diniyyah', lbl2X, yy);
  doc.text(':', col2X, yy);
  doc.font('Helvetica').text(santri.kelas_diniyyah || '-', val2X, yy, { width: dataW });
  yy += 14;
  // Baris 2
  doc.font('Helvetica-Bold').text('Asrama', lbl1X, yy, { width: 85 });
  doc.text(':', col1X, yy);
  doc.font('Helvetica').text(kamar ? kamar.nama : '-', val1X, yy, { width: dataW });
  doc.font('Helvetica-Bold').text('Periode', lbl2X, yy);
  doc.text(':', col2X, yy);
  doc.font('Helvetica').text(periodeLabel, val2X, yy, { width: dataW });
  yy += 14;
  // Baris 3
  doc.font('Helvetica-Bold').text('Alamat', lbl1X, yy, { width: 85 });
  doc.text(':', col1X, yy);
  doc.font('Helvetica').text(santri.alamat || '-', val1X, yy, { width: dataW });
  doc.font('Helvetica-Bold').text('Orang Tua', lbl2X, yy);
  doc.text(':', col2X, yy);
  doc.font('Helvetica').text(waliDisplay, val2X, yy, { width: dataW });
  yy += 18;
  // Garis bawah identitas (penuh)
  doc.moveTo(L, yy - 4).lineTo(R, yy - 4).lineWidth(0.5).stroke();
  yy += 8;
  // ── ZONA 3A: REKAP ABSENSI ──
  doc.fontSize(10).font('Helvetica-Bold').text('A. Rekap Absensi', L, yy);
  doc.moveTo(L, doc.y + 2).lineTo(L + 110, doc.y + 2).lineWidth(1).stroke();
  yy = doc.y + 8;
  const colW2 = [140, 55, 55, 55, 55, 55];
  const headers2 = ['Kegiatan', 'Hadir', 'Izin', 'Sakit', 'Alpa', 'Total'];
  // Header bar
  doc.rect(L, yy - 3, colW2.reduce((a, b) => a + b, 0), 14).fill('#f0f0f0').fillColor('#000');
  doc.fontSize(8).font('Helvetica-Bold');
  let xx = L;
  headers2.forEach((h, i) => { doc.text(h, xx, yy, { width: colW2[i], align: i > 0 ? 'center' : 'left' }); xx += colW2[i]; });
  yy += 14;
  doc.moveTo(L, yy - 2).lineTo(L + colW2.reduce((a, b) => a + b, 0), yy - 2).lineWidth(0.5).stroke();
  doc.font('Helvetica').fontSize(8).fillColor('#000');
  Object.entries(rekap).forEach(([keg, r]) => {
    const t = r.H + r.I + r.S + r.A;
    xx = L;
    [keg, String(r.H), String(r.I), String(r.S), String(r.A), String(t)].forEach((cell, i) => {
      doc.text(cell, xx, yy, { width: colW2[i], align: i > 0 ? 'center' : 'left' });
      xx += colW2[i];
    });
    yy += 14;
  });
  // Garis atas TOTAL
  doc.moveTo(L, yy - 2).lineTo(L + colW2.reduce((a, b) => a + b, 0), yy - 2).lineWidth(1).stroke();
  doc.font('Helvetica-Bold');
  xx = L;
  ['TOTAL', String(totalH), String(totalI), String(totalS), String(totalA), String(totalAll)].forEach((cell, i) => {
    doc.text(cell, xx, yy, { width: colW2[i], align: i > 0 ? 'center' : 'left' });
    xx += colW2[i];
  });
  yy += 22;
  // ── ZONA 3B: KEDISIPLINAN ──
  doc.fontSize(10).font('Helvetica-Bold').text('B. Catatan Kedisiplinan', L, yy);
  doc.moveTo(L, doc.y + 2).lineTo(L + 130, doc.y + 2).lineWidth(1).stroke();
  yy = doc.y + 8;
  if (pelanggaranList.length) {
    doc.fontSize(8);
    pelanggaranList.forEach((p, i) => {
      if (yy > 710) { doc.addPage(); yy = 40; }
      doc.font('Helvetica-Bold').text((i + 1) + '. [' + p.tanggal + '] ' + p.jenis, L, yy, { width: W });
      yy += 12;
      doc.font('Helvetica').text((p.keterangan || '-') + (p.sanksi ? ' — Sanksi: ' + p.sanksi : ''), L + 15, yy, { width: W - 15 });
      yy += 14;
    });
  } else {
    doc.fontSize(9).font('Helvetica').text('Alhamdulillah, tidak ada catatan pelanggaran bulan ini.', L, yy, { width: W });
    yy += 14;
  }
  yy += 14;
  // ── ZONA 3C: PERKEMBANGAN ──
  doc.fontSize(10).font('Helvetica-Bold').text('C. Laporan Perkembangan', L, yy);
  doc.moveTo(L, doc.y + 2).lineTo(L + 135, doc.y + 2).lineWidth(1).stroke();
  yy = doc.y + 8;
  if (catatanList.length) {
    catatanList.forEach((c) => {
      if (yy > 680) { doc.addPage(); yy = 40; }
      const guru = db.users.find(u => u.id === c.created_by);
      // Kotak narasi
      const boxY = yy - 3;
      doc.font('Helvetica-Bold').fontSize(8).text('[' + c.tanggal + '] ' + (c.judul || c.kategori) + ' — ' + (guru ? guru.nama : '-'), L + 5, yy, { width: W - 10 });
      yy = doc.y + 2;
      doc.font('Helvetica').fontSize(8).text(c.isi, L + 5, yy, { width: W - 10 });
      const boxH = Math.max(doc.y - boxY + 8, 45);
      doc.rect(L, boxY - 2, W, boxH).stroke('#cccccc');
      yy = doc.y + 12;
    });
  } else {
    doc.rect(L, yy - 2, W, 35).stroke('#cccccc');
    doc.fontSize(8).font('Helvetica').text('Belum ada catatan perkembangan untuk periode ini.', L, yy + 8, { width: W, align: 'center', color: '#aaa' });
    yy += 42;
  }
  yy += 14;
  // ── ZONA 4: PENGESAHAN ──
  if (yy > 660) { doc.addPage(); yy = 40; }
  const sigW = W / 3;
  doc.fontSize(9).font('Helvetica');
  // Kiri: Orang Tua
  doc.text('Orang Tua / Wali', L, yy, { width: sigW, align: 'center' });
  // Tengah: Wali Kelas
  doc.text('Wali Kelas', L + sigW, yy, { width: sigW, align: 'center' });
  // Kanan: Tempat/tanggal + Kepala Yayasan
  doc.fontSize(8).text(tglStr, L + sigW * 2, yy, { width: sigW, align: 'center' });
  yy += 12;
  doc.fontSize(9).text('Kepala Yayasan', L + sigW * 2, yy, { width: sigW, align: 'center' });
  yy += 40;
  // Garis tanda tangan + nama
  doc.font('Helvetica-Bold').fontSize(9);
  // Wali - check kosong
  doc.text(waliDisplay, L, yy, { width: sigW, align: 'center' });
  doc.moveTo(L + 20, yy - 2).lineTo(L + sigW - 20, yy - 2).stroke();
  // Wali Kelas - kosong
  doc.moveTo(L + sigW + 20, yy - 2).lineTo(L + sigW * 2 - 20, yy - 2).stroke();
  // Kepala Yayasan
  doc.text(kepalaDisplay, L + sigW * 2, yy, { width: sigW, align: 'center' });
  doc.moveTo(L + sigW * 2 + 20, yy - 2).lineTo(R - 20, yy - 2).stroke();
  doc.end();
});

// ── Settings ──────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  res.json(db.settings || { app_name: 'Pesantren Absensi', logo: '' });
});
app.put('/api/settings', authenticate, requireAdmin, async (req, res) => {
  const updates = { ...db.settings, ...req.body };
  delete updates.id;
  const fields = Object.keys(updates);
  const vals = Object.values(updates);
  const set = fields.map(f => `${f} = ?`).join(', ');
  await pool.execute(`UPDATE settings SET ${set} WHERE id = 1`, vals);
  db.settings = { ...db.settings, ...req.body };
  res.json({ message: 'Pengaturan disimpan', settings: db.settings });
});
app.post('/api/settings/logo', authenticate, requireAdmin, async (req, res) => {
  const { logo } = req.body;
  if (!logo) return res.status(400).json({ message: 'Logo wajib' });
  await pool.execute('UPDATE settings SET logo = ? WHERE id = 1', [logo]);
  db.settings.logo = logo;
  res.json({ message: 'Logo diupdate' });
});
app.post('/api/settings/background', authenticate, requireAdmin, async (req, res) => {
  const { background } = req.body;
  if (!background) return res.status(400).json({ message: 'Background wajib' });
  await pool.execute('UPDATE settings SET background = ? WHERE id = 1', [background]);
  db.settings.background = background;
  res.json({ message: 'Background diupdate' });
});
app.post('/api/settings/dashboard-bg', authenticate, requireAdmin, async (req, res) => {
  const { dashboard_bg } = req.body;
  if (!dashboard_bg) return res.status(400).json({ message: 'Background dashboard wajib' });
  await pool.execute('UPDATE settings SET dashboard_bg = ? WHERE id = 1', [dashboard_bg]);
  db.settings.dashboard_bg = dashboard_bg;
  res.json({ message: 'Background dashboard diupdate' });
});
app.post('/api/settings/delete', authenticate, requireAdmin, async (req, res) => {
  const { field } = req.body;
  const allowed = ['logo', 'background', 'dashboard_bg'];
  if (!allowed.includes(field)) return res.status(400).json({ message: 'Field tidak valid' });
  await pool.execute(`UPDATE settings SET ${field} = NULL WHERE id = 1`);
  delete db.settings[field];
  res.json({ message: field + ' dihapus' });
});

// File upload endpoints (multer)
app.post('/api/settings/logo-file', authenticate, requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'File tidak ada' });
  const logoData = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
  await pool.execute('UPDATE settings SET logo = ? WHERE id = 1', [logoData]);
  db.settings.logo = logoData;
  res.json({ message: 'Logo diupload' });
});
app.post('/api/settings/bg-file', authenticate, requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'File tidak ada' });
  const bgData = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
  await pool.execute('UPDATE settings SET background = ? WHERE id = 1', [bgData]);
  db.settings.background = bgData;
  res.json({ message: 'Background login diupload' });
});
app.post('/api/settings/dash-bg-file', authenticate, requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'File tidak ada' });
  const dashBgData = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
  await pool.execute('UPDATE settings SET dashboard_bg = ? WHERE id = 1', [dashBgData]);
  db.settings.dashboard_bg = dashBgData;
  res.json({ message: 'Background menu diupload' });
});

// ── Export PDF ──────────────────────────────────────────
app.get('/api/export/pdf', authenticate, (req, res) => {
  let list = db.absensi;
  if (req.query.dari) list = list.filter(a => a.tanggal >= req.query.dari);
  if (req.query.sampai) list = list.filter(a => a.tanggal <= req.query.sampai);
  if (req.query.kelompok_id) list = list.filter(a => a.kelompok_id == req.query.kelompok_id);
  if (req.query.kelompok_tipe) {
    const kelIds = db.kelompok.filter(k => k.tipe === req.query.kelompok_tipe || k.kegiatan_nama === req.query.kelompok_tipe).map(k => k.id);
    list = list.filter(a => kelIds.includes(a.kelompok_id));
  }
  const santriFilters = ['kamar_id', 'kelas_diniyyah', 'kelompok_ngaji', 'kelompok_ngaji_malam', 'jenis_bakat', 'kelas_sekolah'];
  santriFilters.forEach(f => {
    if (req.query[f]) {
      const santriIds = db.santri.filter(s => String(s[f]) === String(req.query[f])).map(s => s.id);
      list = list.filter(a => santriIds.includes(a.santri_id));
    }
  });

  function getKegiatanLabel(kl) {
    if (!kl) return '-';
    if (kl.tipe === 'SEKOLAH') return 'Absen Sekolah';
    if (kl.kegiatan_nama) return kl.kegiatan_nama + ' (' + kl.nama + ')';
    return kl.tipe.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + ' (' + kl.nama + ')';
  }

  const data = list.map(a => {
    const s = db.santri.find(x => x.id === a.santri_id);
    const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
    const kl = db.kelompok.find(x => x.id === a.kelompok_id);
    return { tanggal: a.tanggal, nama: s ? s.nama : '-', kamar: k ? k.nama : '-', kegiatan: getKegiatanLabel(kl), status: a.status, keterangan: a.keterangan };
  }).sort((a, b) => b.tanggal.localeCompare(a.tanggal));

  const statusMap = { H: 'Hadir', I: 'Izin', S: 'Sakit', A: 'Alfa' };

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=rekap-absensi.pdf');
  doc.pipe(res);

  // Header
  const appName = (db.settings && db.settings.app_name) || 'Pesantren';
  doc.fontSize(18).font('Helvetica-Bold').text('REKAP ABSENSI SANTRI', { align: 'center' });
  doc.fontSize(10).font('Helvetica').text(appName, { align: 'center' });
  doc.moveDown(0.5);
  const filterText = [];
  if (req.query.dari) filterText.push(`Dari: ${req.query.dari}`);
  if (req.query.sampai) filterText.push(`Sampai: ${req.query.sampai}`);
  if (req.query.kelompok_tipe) filterText.push(`Kegiatan: ${req.query.kelompok_tipe}`);
  if (filterText.length) doc.fontSize(9).text(filterText.join(' | '), { align: 'center' });
  doc.moveDown(1);

  // Table header
  const colWidths = [70, 120, 80, 110, 60, 100];
  const headers = ['Tanggal', 'Santri', 'Kamar', 'Kegiatan', 'Status', 'Keterangan'];
  let y = doc.y;
  doc.fontSize(8).font('Helvetica-Bold');
  let x = 40;
  headers.forEach((h, i) => { doc.text(h, x, y, { width: colWidths[i] }); x += colWidths[i]; });
  doc.moveTo(40, y + 15).lineTo(550, y + 15).stroke();
  y += 20;

  // Table rows
  doc.font('Helvetica').fontSize(8);
  data.forEach((row, idx) => {
    if (y > 750) { doc.addPage(); y = 40; }
    x = 40;
    const rowData = [row.tanggal, row.nama, row.kamar, row.kegiatan, statusMap[row.status] || row.status, row.keterangan || '-'];
    rowData.forEach((cell, i) => { doc.text(String(cell), x, y, { width: colWidths[i] }); x += colWidths[i]; });
    y += 16;
  });

  // Summary
  doc.moveDown(2);
  doc.fontSize(9).font('Helvetica-Bold').text('Ringkasan:', 40, y + 20);
  const hadir = data.filter(r => r.status === 'H').length;
  const izin = data.filter(r => r.status === 'I').length;
  const sakit = data.filter(r => r.status === 'S').length;
  const alfa = data.filter(r => r.status === 'A').length;
  doc.font('Helvetica').text(`Hadir: ${hadir} | Izin: ${izin} | Sakit: ${sakit} | Alfa: ${alfa} | Total: ${data.length}`, 40);

  doc.end();
});

// ── Export Rekap Absensi Excel ──────────────────────────
app.get('/api/export/excel', authenticate, async (req, res) => {
  const appName = (db.settings && db.settings.app_name) || 'Pesantren';
  const alamatLembaga = (db.settings && db.settings.alamat_lembaga) || '';
  const logoData = (db.settings && db.settings.logo) || '';
  const bulanNama = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

  // ── Ambil data rekap ──
  let list = db.absensi;
  if (req.query.dari) list = list.filter(a => a.tanggal >= req.query.dari);
  if (req.query.sampai) list = list.filter(a => a.tanggal <= req.query.sampai);
  if (req.query.kelompok_id) list = list.filter(a => a.kelompok_id == req.query.kelompok_id);
  if (req.query.kelompok_tipe) {
    const kelIds = db.kelompok.filter(k => k.tipe === req.query.kelompok_tipe || k.kegiatan_nama === req.query.kelompok_tipe).map(k => k.id);
    list = list.filter(a => kelIds.includes(a.kelompok_id));
  }
  const santriFilters = ['kamar_id', 'kelas_diniyyah', 'kelompok_ngaji', 'kelompok_ngaji_malam', 'jenis_bakat', 'kelas_sekolah'];
  santriFilters.forEach(f => {
    if (req.query[f]) {
      const santriIds = db.santri.filter(s => String(s[f]) === String(req.query[f])).map(s => s.id);
      list = list.filter(a => santriIds.includes(a.santri_id));
    }
  });

  function getKegiatanLabel(kl) {
    if (!kl) return '-';
    if (kl.tipe === 'SEKOLAH') return 'Absen Sekolah';
    if (kl.kegiatan_nama) return kl.kegiatan_nama + ' (' + kl.nama + ')';
    return kl.tipe.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + ' (' + kl.nama + ')';
  }

  // ── Pivot: per santri, per kegiatan, hitung H/I/S/A ──
  const pivot = {};
  const kegiatanSet = new Set();
  list.forEach(a => {
    const s = db.santri.find(x => x.id === a.santri_id);
    if (!s) return;
    const kl = db.kelompok.find(x => x.id === a.kelompok_id);
    const namaKeg = getKegiatanLabel(kl);
    kegiatanSet.add(namaKeg);
    if (!pivot[s.id]) pivot[s.id] = { nama: s.nama, kamar: '', data: {} };
    const k = db.kamar.find(x => x.id === s.kamar_id);
    pivot[s.id].kamar = k ? k.nama : '-';
    if (!pivot[s.id].data[namaKeg]) pivot[s.id].data[namaKeg] = { H: 0, I: 0, S: 0, A: 0 };
    pivot[s.id].data[namaKeg][a.status]++;
  });

  const kegiatanList = Array.from(kegiatanSet).sort();
  const santriRows = Object.values(pivot).sort((a, b) => a.nama.localeCompare(b.nama));

  // ── Buat Excel ──
  const wb = new ExcelJS.Workbook();
  wb.creator = appName;

  // ── Sheet 1: Rekap Formal ──
  const ws = wb.addWorksheet('Rekap Absensi', {
    properties: { defaultColWidth: 12 }
  });

  // Logo (jika ada)
  if (logoData && logoData.startsWith('data:')) {
    try {
      const base64 = logoData.split(',')[1];
      const ext = logoData.split(';')[0].split('/')[1];
      const imageId = wb.addImage({ base64, extension: ext === 'svg' ? 'png' : ext });
      ws.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 60, height: 60 } });
    } catch (e) {}
  }

  // ── KOP SURAT ──
  ws.mergeCells('C1:J1');
  ws.getCell('C1').value = appName;
  ws.getCell('C1').font = { bold: true, size: 16 };
  ws.getCell('C1').alignment = { horizontal: 'center' };

  ws.mergeCells('C2:J2');
  ws.getCell('C2').value = 'REKAPITULASI ABSENSI SANTRI';
  ws.getCell('C2').font = { bold: true, size: 12 };
  ws.getCell('C2').alignment = { horizontal: 'center' };

  ws.mergeCells('C3:J3');
  ws.getCell('C3').value = alamatLembaga;
  ws.getCell('C3').font = { size: 10 };
  ws.getCell('C3').alignment = { horizontal: 'center' };

  // ── Periode ──
  const dariDate = req.query.dari ? new Date(req.query.dari) : new Date();
  const sampaiDate = req.query.sampai ? new Date(req.query.sampai) : new Date();
  const periodeLabel = 'Periode: ' + dariDate.getDate() + ' ' + bulanNama[dariDate.getMonth() + 1] + ' ' + dariDate.getFullYear() + ' - ' + sampaiDate.getDate() + ' ' + bulanNama[sampaiDate.getMonth() + 1] + ' ' + sampaiDate.getFullYear();

  ws.mergeCells('A5:J5');
  ws.getCell('A5').value = periodeLabel;
  ws.getCell('A5').font = { italic: true, size: 10 };
  ws.getCell('A5').alignment = { horizontal: 'center' };

  // ── Header tabel (baris 7) ──
  const headerRow = 7;
  const headers = ['No', 'Nama Santri', 'Kamar'];
  kegiatanList.forEach(k => { headers.push(k); });
  headers.push('Total H', 'Total I', 'Total S', 'Total A', 'Total');

  const headerRowObj = ws.getRow(headerRow);
  headers.forEach((h, i) => {
    const cell = headerRowObj.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E86C1' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin' }, bottom: { style: 'thin' },
      left: { style: 'thin' }, right: { style: 'thin' }
    };
  });
  headerRowObj.height = 25;

  // ── Data rows ──
  santriRows.forEach((s, idx) => {
    const row = ws.getRow(headerRow + 1 + idx);
    const r = idx + 1;
    row.getCell(1).value = r;
    row.getCell(1).alignment = { horizontal: 'center' };
    row.getCell(2).value = s.nama;
    row.getCell(3).value = s.kamar;

    let totalH = 0, totalI = 0, totalS = 0, totalA = 0;
    kegiatanList.forEach((k, ki) => {
      const d = s.data[k] || { H: 0, I: 0, S: 0, A: 0 };
      const total = d.H + d.I + d.S + d.A;
      row.getCell(4 + ki).value = total;
      row.getCell(4 + ki).alignment = { horizontal: 'center' };
      totalH += d.H; totalI += d.I; totalS += d.S; totalA += d.A;
    });

    const colOffset = 4 + kegiatanList.length;
    row.getCell(colOffset).value = totalH; row.getCell(colOffset).alignment = { horizontal: 'center' };
    row.getCell(colOffset + 1).value = totalI; row.getCell(colOffset + 1).alignment = { horizontal: 'center' };
    row.getCell(colOffset + 2).value = totalS; row.getCell(colOffset + 2).alignment = { horizontal: 'center' };
    row.getCell(colOffset + 3).value = totalA; row.getCell(colOffset + 3).alignment = { horizontal: 'center' };
    row.getCell(colOffset + 4).value = totalH + totalI + totalS + totalA;
    row.getCell(colOffset + 4).alignment = { horizontal: 'center' };
    row.getCell(colOffset + 4).font = { bold: true };

    // Border semua sel
    for (let c = 1; c <= headers.length; c++) {
      row.getCell(c).border = {
        top: { style: 'thin' }, bottom: { style: 'thin' },
        left: { style: 'thin' }, right: { style: 'thin' }
      };
    }
    // Alternating color
    if (idx % 2 === 0) {
      for (let c = 1; c <= headers.length; c++) {
        row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
      }
    }
  });

  // ── Sheet 2: Raw Data ──
  const ws2 = wb.addWorksheet('Raw Data');
  ws2.addRow(['Tanggal', 'Nama Santri', 'Kamar', 'Kegiatan', 'Status', 'Keterangan']);
  const rawHeader = ws2.getRow(1);
  rawHeader.font = { bold: true };
  rawHeader.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E86C1' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });

  list.sort((a, b) => b.tanggal.localeCompare(a.tanggal)).forEach(a => {
    const s = db.santri.find(x => x.id === a.santri_id);
    const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
    const kg = db.kegiatan.find(x => x.id === a.kegiatan_id);
    ws2.addRow([
      a.tanggal,
      s ? s.nama : '-',
      k ? k.nama : '-',
      kg ? kg.nama : '-',
      a.status,
      a.keterangan || ''
    ]);
  });

  // ── Kirim file ──
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=rekap-absensi.xlsx');
  await wb.xlsx.write(res);
  res.end();
});

// ── Cleanup Orphan Absensi ─────────────────────────────
app.post('/api/maintenance/cleanup-absensi', authenticate, requireAdmin, async (req, res) => {
  const validKegiatanIds = new Set(db.kegiatan.map(k => k.id));
  const before = db.absensi.length;
  // Delete orphan absensi from MariaDB
  const orphanIds = db.absensi.filter(a => !validKegiatanIds.has(a.kegiatan_id)).map(a => a.id);
  if (orphanIds.length) {
    const ph = orphanIds.map(() => '?').join(',');
    await pool.execute(`DELETE FROM absensi WHERE id IN (${ph})`, orphanIds);
  }
  db.absensi = db.absensi.filter(a => validKegiatanIds.has(a.kegiatan_id));
  const removed = before - db.absensi.length;
  res.json({ message: `Bersihkan ${removed} data absensi orphan`, removed, remaining: db.absensi.length });
});

// ── Rekap Ustadz (Session-based) ────────────────────────
app.get('/api/rekap-ustadz', authenticate, (req, res) => {
  const users = db.users.filter(u => u.role !== 'wali');
  if (!db.absensi_sesi) db.absensi_sesi = [];
  let sesiList = db.absensi_sesi;
  if (req.query.dari) sesiList = sesiList.filter(s => s.tanggal >= req.query.dari);
  if (req.query.sampai) sesiList = sesiList.filter(s => s.tanggal <= req.query.sampai);
  if (req.query.user_id) {
    const targetUser = db.users.find(u => u.id == req.query.user_id);
    if (targetUser) sesiList = sesiList.filter(s => s.ustadz_username === targetUser.username);
  }
  const result = users.map(u => {
    const userSesi = sesiList.filter(s => s.ustadz_username === u.username);
    // Per kegiatan breakdown
    const perKegiatan = {};
    userSesi.forEach(s => {
      let namaKeg = 'Lainnya';
      if (s.kegiatan_nama) namaKeg = s.kegiatan_nama;
      else { const kg = db.kegiatan.find(k => k.id === s.kegiatan_id); if (kg) namaKeg = kg.nama; }
      // Fallback: resolve dari kelompok
      if (namaKeg === 'Lainnya' && s.kelompok_id) {
        const kl = db.kelompok.find(k => k.id === s.kelompok_id);
        if (kl) {
          if (kl.tipe === 'KEGIATAN') namaKeg = kl.kegiatan_nama || kl.nama;
          else namaKeg = kl.tipe + ': ' + kl.nama;
        }
      }
      if (!perKegiatan[namaKeg]) perKegiatan[namaKeg] = 0;
      perKegiatan[namaKeg]++;
    });
    // Per tanggal
    const perTanggal = {};
    userSesi.forEach(s => {
      if (!perTanggal[s.tanggal]) perTanggal[s.tanggal] = 0;
      perTanggal[s.tanggal]++;
    });
    const total = userSesi.length;
    const aktifDays = Object.keys(perTanggal).length;
    return {
      user_id: u.id, nama: u.nama, username: u.username, role: u.role,
      total_sesi: total, aktif_days: aktifDays, per_kegiatan: perKegiatan
    };
  }).filter(r => r.total_sesi > 0 || !req.query.user_id);
  res.json(result.sort((a, b) => b.total_sesi - a.total_sesi));
});

// ── Rekap Ustadz PDF (Pivot Table) ──────────────────────
app.get('/api/rekap-ustadz/pdf', authenticate, (req, res) => {
  const appName = (db.settings && db.settings.app_name) || 'Pesantren';
  const kepalaNama = (db.settings && db.settings.kepala_nama) || '';
  const alamatLembaga = (db.settings && db.settings.alamat_lembaga) || '';
  const namaKota = (db.settings && db.settings.nama_kota) || '';
  const logoData = (db.settings && db.settings.logo) || '';

  // ── Filter sesi berdasarkan periode ──
  if (!db.absensi_sesi) db.absensi_sesi = [];
  let sesiList = db.absensi_sesi;
  if (req.query.dari) sesiList = sesiList.filter(s => s.tanggal >= req.query.dari);
  if (req.query.sampai) sesiList = sesiList.filter(s => s.tanggal <= req.query.sampai);

  // ── BAGIAN 1: DETEKSI KEGIATAN AKTIF DI PERIODE INI ──
  const kegiatanAktifSet = new Map(); // Map<id_or_nama, {nama, kategori, urutan}>
  sesiList.forEach(s => {
    let namaKeg = null, kategoriKeg = 'tambahan', urutanKeg = 0;
    if (s.kegiatan_id && s.kegiatan_id > 0) {
      const kg = db.kegiatan.find(k => k.id === s.kegiatan_id);
      if (kg) {
        namaKeg = kg.nama;
        kategoriKeg = kg.kategori || 'tambahan';
        urutanKeg = kg.urutan_tampil || 0;
      }
    } else if (s.kegiatan_nama) {
      namaKeg = s.kegiatan_nama;
      // Cek apakah ada di master kegiatan
      const kg = db.kegiatan.find(k => k.nama === s.kegiatan_nama);
      if (kg) {
        kategoriKeg = kg.kategori || 'tambahan';
        urutanKeg = kg.urutan_tampil || 0;
      }
    }
    if (namaKeg && !kegiatanAktifSet.has(namaKeg)) {
      kegiatanAktifSet.set(namaKeg, { nama: namaKeg, kategori: kategoriKeg, urutan: urutanKeg });
    }
  });

  // ── BAGIAN 1.2: SORTING KOLOM (Pokok dulu, lalu Tambahan) ──
  const kegiatanList = Array.from(kegiatanAktifSet.values()).sort((a, b) => {
    if (a.kategori !== b.kategori) return a.kategori === 'pokok' ? -1 : 1;
    return a.urutan - b.urutan;
  });

  // ── BAGIAN 1.3: GROUPING PER USTADZ ──
  const users = db.users.filter(u => u.role !== 'wali');
  const pivotData = users.map(u => {
    const userSesi = sesiList.filter(s => s.ustadz_username === u.username);
    if (userSesi.length === 0) return null;
    const perKegiatan = {};
    kegiatanList.forEach(k => { perKegiatan[k.nama] = 0; });
    userSesi.forEach(s => {
      let namaKeg = s.kegiatan_nama;
      if (!namaKeg && s.kegiatan_id) {
        const kg = db.kegiatan.find(k => k.id === s.kegiatan_id);
        if (kg) namaKeg = kg.nama;
      }
      if (namaKeg && perKegiatan[namaKeg] !== undefined) perKegiatan[namaKeg]++;
    });
    return { nama: u.nama, per_kegiatan: perKegiatan, total: userSesi.length };
  }).filter(Boolean).sort((a, b) => b.total - a.total);

  if (pivotData.length === 0) {
    return res.status(404).json({ message: 'Tidak ada data untuk periode ini' });
  }

  // ── BAGIAN 2: KOP SURAT (3 kolom: 15%-70%-15%) ──
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=rekap-ustadz.pdf');
  doc.pipe(res);

  const pageW = 841.89; // A4 landscape width
  const pageH = 595.28; // A4 landscape height
  const M = 30;
  const L = M, R = pageW - M, W = R - L;
  let yy = M;
  const logoW = W * 0.15;
  const textW = W * 0.70;
  const textX = L + logoW;

  // Logo kiri
  if (logoData && logoData.startsWith('data:')) {
    try {
      const base64 = logoData.split(',')[1];
      const buf = Buffer.from(base64, 'base64');
      doc.image(buf, L + 10, yy, { width: 50, height: 50 });
    } catch (e) {}
  }
  // Teks tengah
  doc.fontSize(14).font('Helvetica-Bold').text(appName, textX, yy, { width: textW, align: 'center' });
  yy += 17;
  doc.fontSize(11).font('Helvetica-Bold').text('REKAPITULASI KEHADIRAN MENGAJAR USTADZ', textX, yy, { width: textW, align: 'center' });
  yy += 15;
  doc.fontSize(8).font('Helvetica').text(alamatLembaga || '', textX, yy, { width: textW, align: 'center' });
  yy += 16;
  // Garis ganda
  doc.moveTo(L, yy).lineTo(R, yy).lineWidth(1.5).stroke();
  doc.moveTo(L, yy + 3).lineTo(R, yy + 3).lineWidth(0.5).stroke();
  yy += 12;

  // ── BAGIAN 2.2: SUB-HEADER PERIODE ──
  const bulanNama = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const dariDate = req.query.dari ? new Date(req.query.dari) : new Date();
  const sampaiDate = req.query.sampai ? new Date(req.query.sampai) : new Date();
  const periodeLabel = 'Periode: ' + dariDate.getDate() + ' ' + bulanNama[dariDate.getMonth() + 1] + ' ' + dariDate.getFullYear() + ' - ' + sampaiDate.getDate() + ' ' + bulanNama[sampaiDate.getMonth() + 1] + ' ' + sampaiDate.getFullYear();
  doc.fontSize(9).font('Helvetica').text(periodeLabel, L, yy, { width: W, align: 'center' });
  yy += 18;

  // ── BAGIAN 3: TABEL ELASTIS ──
  const colNo = W * 0.05;
  const colNama = W * 0.20;
  const colTotal = W * 0.08;
  const sisaW = W - colNo - colNama - colTotal;
  const colKeg = kegiatanList.length > 0 ? sisaW / kegiatanList.length : sisaW;
  const colWidths = [colNo, colNama, ...kegiatanList.map(() => colKeg), colTotal];
  const headers = ['No', 'Nama Ustadz', ...kegiatanList.map(k => k.nama), 'Total'];

  // Fungsi untuk render header tabel (repeat di halaman baru)
  function renderTableHeader(yPos) {
    const rowH = 28;
    // Background header
    doc.rect(L, yPos, W, rowH).fill('#f0f0f0').fillColor('#000');
    // Border
    doc.lineWidth(0.5).strokeColor('#333');
    doc.rect(L, yPos, W, rowH).stroke();

    let xx = L;
    headers.forEach((h, i) => {
      // Garis vertikal antar kolom
      if (i > 0) doc.moveTo(xx, yPos).lineTo(xx, yPos + rowH).stroke();
      // Cek apakah perlu rotate (jika kolom terlalu kecil)
      if (i >= 2 && i < headers.length - 1 && colKeg < 35) {
        // Rotate 90°
        doc.save();
        doc.translate(xx + colWidths[i] / 2, yPos + rowH / 2);
        doc.rotate(-90);
        doc.fontSize(7).font('Helvetica-Bold').text(h, -40, -3, { width: 80, align: 'center' });
        doc.restore();
      } else {
        doc.fontSize(7).font('Helvetica-Bold').text(h, xx + 2, yPos + 4, {
          width: colWidths[i] - 4, align: i === 1 ? 'left' : 'center', lineBreak: false
        });
      }
      xx += colWidths[i];
    });
    return yPos + rowH;
  }

  yy = renderTableHeader(yy);

  // ── BAGIAN 3.2: DATA ROWS ──
  doc.font('Helvetica').fontSize(8);
  pivotData.forEach((row, idx) => {
    const rowH = 22;
    // Check if need new page
    if (yy + rowH > pageH - 80) {
      doc.addPage();
      yy = M;
      // Repeat header
      yy = renderTableHeader(yy);
    }
    // Alternating row color
    if (idx % 2 === 0) {
      doc.rect(L, yy, W, rowH).fill('#fafafa').fillColor('#000');
    }
    // Border
    doc.lineWidth(0.3).strokeColor('#ccc');
    doc.rect(L, yy, W, rowH).stroke();

    let xx = L;
    const rowData = [
      String(idx + 1),
      row.nama,
      ...kegiatanList.map(k => {
        const val = row.per_kegiatan[k.nama] || 0;
        return val === 0 ? '-' : String(val);
      }),
      String(row.total)
    ];
    rowData.forEach((cell, i) => {
      if (i > 0) doc.moveTo(xx, yy).lineTo(xx, yy + rowH).stroke();
      doc.fontSize(8).font(i === 1 ? 'Helvetica' : 'Helvetica').text(cell, xx + 3, yy + 4, {
        width: colWidths[i] - 6, align: i <= 1 ? (i === 0 ? 'center' : 'left') : 'center', lineBreak: false
      });
      xx += colWidths[i];
    });
    yy += rowH;
  });

  // ── BAGIAN 4: AREA PENANDA TANGANAN ──
  yy += 20;
  if (yy > pageH - 120) {
    doc.addPage();
    yy = M + 40;
  }
  const tglCetak = new Date();
  const tglStr = (namaKota ? namaKota + ', ' : '') + tglCetak.getDate() + ' ' + bulanNama[tglCetak.getMonth() + 1] + ' ' + tglCetak.getFullYear();

  // Tanda tangan di kanan
  const signX = R - 200;
  doc.fontSize(9).font('Helvetica').text(tglStr, signX, yy, { width: 200, align: 'center' });
  yy += 14;
  const jabatanDisplay = 'Kepala ' + appName;
  doc.fontSize(9).font('Helvetica').text(jabatanDisplay, signX, yy, { width: 200, align: 'center' });
  yy += 50;
  doc.fontSize(9).font('Helvetica-Bold').text(kepalaNama || '......................................', signX, yy, { width: 200, align: 'center' });

  doc.end();
});

// ── Rekap Ustadz Excel ─────────────────────────────────
app.get('/api/rekap-ustadz/excel', authenticate, async (req, res) => {
  const appName = (db.settings && db.settings.app_name) || 'Pesantren';
  const alamatLembaga = (db.settings && db.settings.alamat_lembaga) || '';
  const logoData = (db.settings && db.settings.logo) || '';
  const bulanNama = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

  if (!db.absensi_sesi) db.absensi_sesi = [];
  let sesiList = db.absensi_sesi;
  if (req.query.dari) sesiList = sesiList.filter(s => s.tanggal >= req.query.dari);
  if (req.query.sampai) sesiList = sesiList.filter(s => s.tanggal <= req.query.sampai);

  // Deteksi kegiatan aktif
  const kegiatanAktifSet = new Map();
  sesiList.forEach(s => {
    let namaKeg = null, kategoriKeg = 'tambahan', urutanKeg = 0;
    if (s.kegiatan_id && s.kegiatan_id > 0) {
      const kg = db.kegiatan.find(k => k.id === s.kegiatan_id);
      if (kg) { namaKeg = kg.nama; kategoriKeg = kg.kategori || 'tambahan'; urutanKeg = kg.urutan_tampil || 0; }
    } else if (s.kegiatan_nama) {
      namaKeg = s.kegiatan_nama;
      const kg = db.kegiatan.find(k => k.nama === s.kegiatan_nama);
      if (kg) { kategoriKeg = kg.kategori || 'tambahan'; urutanKeg = kg.urutan_tampil || 0; }
    }
    if (namaKeg && !kegiatanAktifSet.has(namaKeg)) kegiatanAktifSet.set(namaKeg, { nama: namaKeg, kategori: kategoriKeg, urutan: urutanKeg });
  });
  const kegiatanList = Array.from(kegiatanAktifSet.values()).sort((a, b) => {
    if (a.kategori !== b.kategori) return a.kategori === 'pokok' ? -1 : 1;
    return a.urutan - b.urutan;
  });

  // Pivot per ustadz
  const users = db.users.filter(u => u.role !== 'wali');
  const pivotData = users.map(u => {
    const userSesi = sesiList.filter(s => s.ustadz_username === u.username);
    if (userSesi.length === 0) return null;
    const perKegiatan = {};
    kegiatanList.forEach(k => { perKegiatan[k.nama] = 0; });
    userSesi.forEach(s => {
      let namaKeg = s.kegiatan_nama;
      if (!namaKeg && s.kegiatan_id) { const kg = db.kegiatan.find(k => k.id === s.kegiatan_id); if (kg) namaKeg = kg.nama; }
      if (namaKeg && perKegiatan[namaKeg] !== undefined) perKegiatan[namaKeg]++;
    });
    return { nama: u.nama, username: u.username, per_kegiatan: perKegiatan, total: userSesi.length };
  }).filter(Boolean).sort((a, b) => b.total - a.total);

  // Buat Excel
  const wb = new ExcelJS.Workbook();
  wb.creator = appName;
  const ws = wb.addWorksheet('Rekap Ustadz');

  // Logo
  if (logoData && logoData.startsWith('data:')) {
    try {
      const ext = logoData.split(';')[0].split('/')[1];
      const imageId = wb.addImage({ base64: logoData.split(',')[1], extension: ext === 'svg' ? 'png' : ext });
      ws.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 60, height: 60 } });
    } catch (e) {}
  }

  // Kop surat
  const lastCol = String.fromCharCode(65 + 3 + kegiatanList.length); // No, Nama, kegiatan..., Total
  ws.mergeCells('C1:' + lastCol + '1');
  ws.getCell('C1').value = appName;
  ws.getCell('C1').font = { bold: true, size: 16 };
  ws.getCell('C1').alignment = { horizontal: 'center' };

  ws.mergeCells('C2:' + lastCol + '2');
  ws.getCell('C2').value = 'REKAPITULASI KEHADIRAN MENGAJAR USTADZ';
  ws.getCell('C2').font = { bold: true, size: 12 };
  ws.getCell('C2').alignment = { horizontal: 'center' };

  ws.mergeCells('C3:' + lastCol + '3');
  ws.getCell('C3').value = alamatLembaga;
  ws.getCell('C3').font = { size: 10 };
  ws.getCell('C3').alignment = { horizontal: 'center' };

  // Periode
  const dariDate = req.query.dari ? new Date(req.query.dari) : new Date();
  const sampaiDate = req.query.sampai ? new Date(req.query.sampai) : new Date();
  const periodeLabel = 'Periode: ' + dariDate.getDate() + ' ' + bulanNama[dariDate.getMonth() + 1] + ' ' + dariDate.getFullYear() + ' - ' + sampaiDate.getDate() + ' ' + bulanNama[sampaiDate.getMonth() + 1] + ' ' + sampaiDate.getFullYear();
  ws.mergeCells('A5:' + lastCol + '5');
  ws.getCell('A5').value = periodeLabel;
  ws.getCell('A5').font = { italic: true, size: 10 };
  ws.getCell('A5').alignment = { horizontal: 'center' };

  // Header tabel
  const headerRow = 7;
  const headers = ['No', 'Nama Ustadz', ...kegiatanList.map(k => k.nama), 'Total'];
  const headerRowObj = ws.getRow(headerRow);
  headers.forEach((h, i) => {
    const cell = headerRowObj.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E86C1' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  });
  headerRowObj.height = 25;

  // Data
  pivotData.forEach((u, idx) => {
    const row = ws.getRow(headerRow + 1 + idx);
    row.getCell(1).value = idx + 1;
    row.getCell(1).alignment = { horizontal: 'center' };
    row.getCell(2).value = u.nama;
    kegiatanList.forEach((k, ki) => {
      const val = u.per_kegiatan[k.nama] || 0;
      row.getCell(3 + ki).value = val === 0 ? '-' : val;
      row.getCell(3 + ki).alignment = { horizontal: 'center' };
    });
    row.getCell(3 + kegiatanList.length).value = u.total;
    row.getCell(3 + kegiatanList.length).alignment = { horizontal: 'center' };
    row.getCell(3 + kegiatanList.length).font = { bold: true };

    for (let c = 1; c <= headers.length; c++) {
      row.getCell(c).border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
    }
    if (idx % 2 === 0) {
      for (let c = 1; c <= headers.length; c++) {
        row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
      }
    }
  });

  // Sheet 2: Raw Data
  const ws2 = wb.addWorksheet('Raw Data');
  ws2.addRow(['Tanggal', 'Nama Ustadz', 'Kegiatan']);
  const rawHeader = ws2.getRow(1);
  rawHeader.font = { bold: true };
  rawHeader.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E86C1' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });
  sesiList.forEach(s => {
    let namaKeg = s.kegiatan_nama;
    if (!namaKeg && s.kegiatan_id) { const kg = db.kegiatan.find(k => k.id === s.kegiatan_id); if (kg) namaKeg = kg.nama; }
    ws2.addRow([s.tanggal, s.ustadz_username, namaKeg || '-']);
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=rekap-ustadz.xlsx');
  await wb.xlsx.write(res);
  res.end();
});

startServer();
