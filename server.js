const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const archiver = require('archiver');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'pesantren-secret-key';
const DB_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer - memory storage, max 5MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── JSON Database ──────────────────────────────────────
function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    // Ensure new tables exist
    if (!data.kelompok) data.kelompok = [];
    if (!data.santri_kelompok) data.santri_kelompok = [];
    if (!data.absensi_sesi) data.absensi_sesi = [];
    if (!data.kelas_sekolah) {
      // Auto-seed from existing santri data
      const kelasSet = new Set(data.santri.map(s => s.kelas_sekolah).filter(Boolean));
      data.kelas_sekolah = [...kelasSet].sort().map((nama, i) => ({ id: i + 1, nama, created_at: new Date().toISOString() }));
    }
    return data;
  }
  return { users: [], kamar: [], kelas_sekolah: [], santri: [], absensi: [], absen_malam: [], absen_sekolah: [], absensi_sesi: [], pengumuman: [], kegiatan: [], kelompok: [], santri_kelompok: [] };
}
function saveDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }
function nextId(arr) { return arr.length ? Math.max(...arr.map(x => x.id)) + 1 : 1; }

// Init default admin
let db = loadDB();
if (!db.users.find(u => u.username === 'admin')) {
  db.users.push({ id: 1, username: 'admin', password_hash: bcrypt.hashSync('admin123', 10), role: 'admin', nama: 'Administrator', created_at: new Date().toISOString() });
  saveDB(db);
  console.log('Default admin: admin / admin123');
}
// Init default kegiatan
if (!db.kegiatan) db.kegiatan = [];
if (db.kegiatan.length === 0) {
  db.kegiatan = [
    { id: 1, nama: 'Ngaji Pagi', created_at: new Date().toISOString() },
    { id: 2, nama: "Ngaji Qur'an Siang", created_at: new Date().toISOString() },
    { id: 3, nama: 'Bakat', created_at: new Date().toISOString() },
    { id: 4, nama: 'Madrasah Diniyyah', created_at: new Date().toISOString() },
    { id: 5, nama: 'Ngaji Malam', created_at: new Date().toISOString() },
  ];
}
saveDB(db);

// Backfill: auto-create kelompok untuk kegiatan yang belum punya
db.kegiatan.forEach(k => {
  if (k.kategori === 'pokok') {
    // Pokok: kelompok tipe = nama kegiatan
    // Migrasi: cek kelompok lama tipe KEGIATAN → ubah ke tipe nama kegiatan
    const oldKegiatan = db.kelompok.find(kl => kl.tipe === 'KEGIATAN' && kl.kegiatan_nama === k.nama);
    if (oldKegiatan) { oldKegiatan.tipe = k.nama; }
    const existing = db.kelompok.find(kl => kl.tipe === k.nama);
    if (!existing) {
      db.kelompok.push({ id: nextId(db.kelompok), nama: k.nama, tipe: k.nama, kegiatan_nama: k.nama, created_at: new Date().toISOString() });
    }
  } else {
    // Tambahan: kelompok tipe KEGIATAN
    const existing = db.kelompok.find(kl => kl.nama === k.nama && kl.tipe === 'KEGIATAN');
    if (!existing) {
      db.kelompok.push({ id: nextId(db.kelompok), nama: k.nama, tipe: 'KEGIATAN', kegiatan_nama: k.nama, created_at: new Date().toISOString() });
    } else if (!existing.kegiatan_nama) {
      existing.kegiatan_nama = k.nama;
    }
  }
});
saveDB(db);

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
app.post('/api/users', authenticate, requireAdmin, (req, res) => {
  const { username, password, role, nama } = req.body;
  if (!username || !password || !nama) return res.status(400).json({ message: 'Semua field wajib' });
  if (db.users.find(u => u.username === username)) return res.status(400).json({ message: 'Username sudah ada' });
  const user = { id: nextId(db.users), username, password_hash: bcrypt.hashSync(password, 10), role: role || 'ustadz', nama, created_at: new Date().toISOString() };
  db.users.push(user); saveDB(db); res.json({ message: 'User ditambahkan', user: { id: user.id, username: user.username, nama: user.nama, role: user.role } });
});
app.put('/api/users/:id', authenticate, requireAdmin, (req, res) => {
  const user = db.users.find(u => u.id == req.params.id);
  if (!user) return res.status(404).json({ message: 'User tidak ditemukan' });
  const { username, password, role, nama } = req.body;
  if (username) user.username = username;
  if (nama) user.nama = nama;
  if (role) user.role = role;
  if (password) user.password_hash = bcrypt.hashSync(password, 10);
  saveDB(db); res.json({ message: 'User diupdate' });
});
app.delete('/api/users/:id', authenticate, requireAdmin, (req, res) => {
  if (req.user.id == req.params.id) return res.status(400).json({ message: 'Tidak bisa hapus diri sendiri' });
  db.users = db.users.filter(u => u.id != req.params.id); saveDB(db);
  res.json({ message: 'User dihapus' });
});

// ── Kamar ──────────────────────────────────────────────
app.get('/api/kamar', authenticate, (req, res) => {
  res.json(db.kamar.map(k => ({
    ...k, jumlah_santri: db.santri.filter(s => s.kamar_id === k.id && s.status === 'aktif').length
  })));
});
app.post('/api/kamar', authenticate, requireAdmin, (req, res) => {
  const { nama, kapasitas, pengurus } = req.body;
  if (!nama) return res.status(400).json({ message: 'Nama wajib' });
  const k = { id: nextId(db.kamar), nama, kapasitas: kapasitas || 10, pengurus: pengurus || '' };
  db.kamar.push(k); saveDB(db); res.json(k);
});
app.put('/api/kamar/:id', authenticate, requireAdmin, (req, res) => {
  const k = db.kamar.find(x => x.id == req.params.id);
  if (!k) return res.status(404).json({ message: 'Kamar tidak ditemukan' });
  Object.assign(k, req.body); saveDB(db); res.json({ message: 'Kamar diupdate' });
});
app.delete('/api/kamar/:id', authenticate, requireAdmin, (req, res) => {
  db.kamar = db.kamar.filter(k => k.id != req.params.id); saveDB(db);
  res.json({ message: 'Kamar dihapus' });
});

// ── Kelas Sekolah ────────────────────────────────────────
app.get('/api/kelas-sekolah', authenticate, (req, res) => {
  if (!db.kelas_sekolah) db.kelas_sekolah = [];
  res.json(db.kelas_sekolah.map(k => ({
    ...k, jumlah_santri: db.santri.filter(s => s.kelas_sekolah === k.nama && s.status === 'aktif').length
  })));
});
app.post('/api/kelas-sekolah', authenticate, requireAdmin, (req, res) => {
  const { nama } = req.body;
  if (!nama) return res.status(400).json({ message: 'Nama kelas wajib' });
  if (!db.kelas_sekolah) db.kelas_sekolah = [];
  if (db.kelas_sekolah.find(k => k.nama.toLowerCase() === nama.toLowerCase())) {
    return res.status(400).json({ message: 'Kelas sudah ada' });
  }
  const k = { id: nextId(db.kelas_sekolah), nama, created_at: new Date().toISOString() };
  db.kelas_sekolah.push(k); saveDB(db); res.json(k);
});
app.put('/api/kelas-sekolah/:id', authenticate, requireAdmin, (req, res) => {
  if (!db.kelas_sekolah) db.kelas_sekolah = [];
  const k = db.kelas_sekolah.find(x => x.id == req.params.id);
  if (!k) return res.status(404).json({ message: 'Kelas tidak ditemukan' });
  const oldNama = k.nama;
  Object.assign(k, req.body);
  // Update all santri with old kelas_sekolah
  if (req.body.nama && req.body.nama !== oldNama) {
    db.santri.forEach(s => { if (s.kelas_sekolah === oldNama) s.kelas_sekolah = req.body.nama; });
  }
  saveDB(db); res.json({ message: 'Kelas diupdate' });
});
app.delete('/api/kelas-sekolah/:id', authenticate, requireAdmin, (req, res) => {
  if (!db.kelas_sekolah) db.kelas_sekolah = [];
  const k = db.kelas_sekolah.find(x => x.id == req.params.id);
  if (k) {
    // Clear kelas_sekolah from santri
    db.santri.forEach(s => { if (s.kelas_sekolah === k.nama) s.kelas_sekolah = ''; });
    db.kelas_sekolah = db.kelas_sekolah.filter(x => x.id != req.params.id);
  }
  saveDB(db); res.json({ message: 'Kelas dihapus' });
});
app.post('/api/kelas-sekolah/pindah', authenticate, requireAdmin, (req, res) => {
  const { santri_ids, kelas_nama } = req.body;
  if (!santri_ids || !santri_ids.length) return res.status(400).json({ message: 'Pilih santri dulu' });
  let count = 0;
  santri_ids.forEach(sid => {
    const s = db.santri.find(x => x.id === sid);
    if (s) { s.kelas_sekolah = kelas_nama || ''; count++; }
  });
  saveDB(db); res.json({ message: count + ' santri dipindahkan ke ' + (kelas_nama || '-') });
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
  res.json(list.map(s => {
    const k = db.kamar.find(x => x.id === s.kamar_id);
    return { ...s, kamar_nama: k ? k.nama : '-' };
  }));
});
app.post('/api/santri', authenticate, requireAdmin, (req, res) => {
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
  db.santri.push(s); saveDB(db); res.json(s);
});
app.put('/api/santri/:id', authenticate, requireAdmin, (req, res) => {
  const s = db.santri.find(x => x.id == req.params.id);
  if (!s) return res.status(404).json({ message: 'Santri tidak ditemukan' });
  const fields = ['nama', 'status', 'kelas_diniyyah', 'kelompok_ngaji', 'jenis_bakat', 'kelas_sekolah', 'kelompok_ngaji_malam', 'alamat'];
  fields.forEach(f => { if (req.body[f] !== undefined) s[f] = req.body[f]; });
  if (req.body.kamar_id) s.kamar_id = parseInt(req.body.kamar_id);
  if (req.body.wali_user_id !== undefined) s.wali_user_id = req.body.wali_user_id ? parseInt(req.body.wali_user_id) : null;
  if (req.body.extra !== undefined) s.extra = req.body.extra;
  saveDB(db); res.json({ message: 'Santri diupdate' });
});
app.delete('/api/santri/:id', authenticate, requireAdmin, (req, res) => {
  db.santri = db.santri.filter(s => s.id != req.params.id); saveDB(db);
  res.json({ message: 'Santri dihapus' });
});

// ── Kegiatan ───────────────────────────────────────────
app.get('/api/kegiatan', authenticate, (req, res) => {
  res.json(db.kegiatan);
});
app.post('/api/kegiatan', authenticate, requireAdmin, (req, res) => {
  const { nama, kategori, urutan_tampil } = req.body;
  if (!nama) return res.status(400).json({ message: 'Nama kegiatan wajib' });
  const k = { id: nextId(db.kegiatan), nama, kategori: kategori || 'pokok', urutan_tampil: urutan_tampil || 0, created_at: new Date().toISOString() };
  db.kegiatan.push(k);
  if (k.kategori === 'pokok') {
    // Pokok: kelompok tipe = nama kegiatan sendiri (jadi tipe absensi tersendiri)
    if (!db.kelompok.find(kl => kl.nama === nama && kl.tipe === nama)) {
      db.kelompok.push({ id: nextId(db.kelompok), nama, tipe: nama, kegiatan_nama: nama, created_at: new Date().toISOString() });
    }
  } else {
    // Tambahan: kelompok tipe KEGIATAN (sub-grup system)
    if (!db.kelompok.find(kl => kl.nama === nama && kl.tipe === 'KEGIATAN')) {
      db.kelompok.push({ id: nextId(db.kelompok), nama, tipe: 'KEGIATAN', kegiatan_nama: nama, created_at: new Date().toISOString() });
    }
  }
  saveDB(db); res.json(k);
});
app.put('/api/kegiatan/:id', authenticate, requireAdmin, (req, res) => {
  const k = db.kegiatan.find(x => x.id == req.params.id);
  if (!k) return res.status(404).json({ message: 'Kegiatan tidak ditemukan' });
  const oldNama = k.nama;
  const oldKategori = k.kategori;
  if (req.body.nama) k.nama = req.body.nama;
  if (req.body.kategori !== undefined) k.kategori = req.body.kategori;
  if (req.body.urutan_tampil !== undefined) k.urutan_tampil = parseInt(req.body.urutan_tampil) || 0;
  // Sync kelompok: rename tipe/kegiatan_nama
  if (req.body.nama && req.body.nama !== oldNama) {
    if (oldKategori === 'pokok') {
      // Pokok: kelompok tipe = nama kegiatan → update tipe
      db.kelompok.filter(kl => kl.tipe === oldNama).forEach(kl => { kl.tipe = k.nama; kl.kegiatan_nama = k.nama; });
    } else {
      // Tambahan: kelompok tipe KEGIATAN, kegiatan_nama = nama → update kegiatan_nama + nama
      db.kelompok.filter(kl => kl.tipe === 'KEGIATAN' && kl.kegiatan_nama === oldNama).forEach(kl => { kl.kegiatan_nama = k.nama; if (kl.nama === oldNama) kl.nama = k.nama; });
    }
  }
  saveDB(db); res.json({ message: 'Kegiatan diupdate' });
});
app.delete('/api/kegiatan/:id', authenticate, requireAdmin, (req, res) => {
  const k = db.kegiatan.find(x => x.id == req.params.id);
  if (k) {
    // Hapus kelompok terkait + relasi anggota
    let kelompokIds;
    if (k.kategori === 'pokok') {
      kelompokIds = db.kelompok.filter(kl => kl.tipe === k.nama).map(kl => kl.id);
    } else {
      kelompokIds = db.kelompok.filter(kl => kl.tipe === 'KEGIATAN' && kl.kegiatan_nama === k.nama).map(kl => kl.id);
    }
    if (kelompokIds.length) {
      db.kelompok = db.kelompok.filter(kl => !kelompokIds.includes(kl.id));
      db.santri_kelompok = db.santri_kelompok.filter(sk => !kelompokIds.includes(sk.kelompok_id));
    }
  }
  db.kegiatan = db.kegiatan.filter(x => x.id != req.params.id); saveDB(db);
  res.json({ message: 'Kegiatan dihapus' });
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
app.post('/api/kelompok', authenticate, requireAdmin, (req, res) => {
  const { nama, tipe, kegiatan_nama } = req.body;
  if (!nama || !tipe) return res.status(400).json({ message: 'Nama & tipe wajib' });
  // Cek duplikat: nama + tipe + kegiatan_nama (untuk KEGIATAN, nama bisa sama beda kegiatan)
  if (db.kelompok.find(k => k.nama.toLowerCase() === nama.toLowerCase() && k.tipe === tipe && (k.kegiatan_nama || '') === (kegiatan_nama || '')))
    return res.status(400).json({ message: 'Kelompok dengan nama & tipe ini sudah ada' });
  const k = { id: nextId(db.kelompok), nama, tipe, kegiatan_nama: kegiatan_nama || null, created_at: new Date().toISOString() };
  db.kelompok.push(k); saveDB(db); res.json(k);
});
app.put('/api/kelompok/:id', authenticate, requireAdmin, (req, res) => {
  const k = db.kelompok.find(x => x.id == req.params.id);
  if (!k) return res.status(404).json({ message: 'Kelompok tidak ditemukan' });
  if (req.body.nama) k.nama = req.body.nama;
  if (req.body.tipe) k.tipe = req.body.tipe;
  if (req.body.kegiatan_nama !== undefined) k.kegiatan_nama = req.body.kegiatan_nama || null;
  saveDB(db); res.json({ message: 'Kelompok diupdate' });
});
app.delete('/api/kelompok/:id', authenticate, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  // Soft-delete: set semua anggota jadi inactive
  db.santri_kelompok.forEach(sk => { if (sk.kelompok_id === id) sk.status = 'inactive'; });
  db.kelompok = db.kelompok.filter(k => k.id !== id);
  saveDB(db); res.json({ message: 'Kelompok dihapus (anggota di-set inactive)' });
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
app.post('/api/santri-kelompok', authenticate, requireAdmin, (req, res) => {
  const { santri_id, kelompok_id } = req.body;
  if (!santri_id || !kelompok_id) return res.status(400).json({ message: 'santri_id & kelompok_id wajib' });
  // Cek duplikat aktif
  const existing = db.santri_kelompok.find(sk => sk.santri_id == santri_id && sk.kelompok_id == kelompok_id && sk.status === 'aktif');
  if (existing) return res.status(400).json({ message: 'Santri sudah anggota kelompok ini' });
  const sk = { santri_id: parseInt(santri_id), kelompok_id: parseInt(kelompok_id), status: 'aktif', created_at: new Date().toISOString() };
  db.santri_kelompok.push(sk); saveDB(db); res.json(sk);
});
// Bulk add: masukkan banyak santri ke 1 kelompok
app.post('/api/santri-kelompok/bulk', authenticate, requireAdmin, (req, res) => {
  const { kelompok_id, santri_ids } = req.body;
  if (!kelompok_id || !santri_ids || !Array.isArray(santri_ids))
    return res.status(400).json({ message: 'kelompok_id & santri_ids (array) wajib' });
  let added = 0;
  santri_ids.forEach(sid => {
    const existing = db.santri_kelompok.find(sk => sk.santri_id == sid && sk.kelompok_id == kelompok_id && sk.status === 'aktif');
    if (!existing) {
      db.santri_kelompok.push({ santri_id: parseInt(sid), kelompok_id: parseInt(kelompok_id), status: 'aktif', created_at: new Date().toISOString() });
      added++;
    }
  });
  saveDB(db); res.json({ message: `${added} santri ditambahkan`, added });
});
app.put('/api/santri-kelompok/deactivate', authenticate, requireAdmin, (req, res) => {
  const { santri_id, kelompok_id } = req.body;
  if (!santri_id || !kelompok_id) return res.status(400).json({ message: 'santri_id & kelompok_id wajib' });
  const sk = db.santri_kelompok.find(x => x.santri_id == santri_id && x.kelompok_id == kelompok_id && x.status === 'aktif');
  if (!sk) return res.status(404).json({ message: 'Relasi tidak ditemukan' });
  sk.status = 'inactive';
  saveDB(db); res.json({ message: 'Anggota di-nonaktifkan (history tetap tersimpan)' });
});
app.delete('/api/santri-kelompok', authenticate, requireAdmin, (req, res) => {
  const { santri_id, kelompok_id } = req.query;
  if (!santri_id || !kelompok_id) return res.status(400).json({ message: 'santri_id & kelompok_id wajib' });
  db.santri_kelompok = db.santri_kelompok.filter(sk => !(sk.santri_id == santri_id && sk.kelompok_id == kelompok_id));
  saveDB(db); res.json({ message: 'Relasi dihapus permanen' });
});

// ── Absensi (Unified) ──────────────────────────────────────────
app.get('/api/absensi', authenticate, (req, res) => {
  let list = db.absensi;
  if (req.query.tanggal) list = list.filter(a => a.tanggal === req.query.tanggal);
  // Filter by kelompok_id (new unified system)
  if (req.query.kelompok_id) list = list.filter(a => a.kelompok_id == req.query.kelompok_id);
  // Filter by sesi_id (untuk bedain pagi/siang)
  if (req.query.sesi_id) list = list.filter(a => a.sesi_id == req.query.sesi_id);
  // Filter by kelompok tipe (e.g., ?kelompok_tipe=SEKOLAH)
  if (req.query.kelompok_tipe) {
    const kelompokIds = db.kelompok.filter(k => k.tipe === req.query.kelompok_tipe).map(k => k.id);
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
app.post('/api/absensi/bulk', authenticate, (req, res) => {
  if (req.user.role === 'wali') return res.status(403).json({ message: 'Wali tidak bisa mengubah absensi' });
  const { tanggal, kegiatan_id, kelompok_id, sesi_id, jam_sesi, items } = req.body;
  if (!tanggal || !items) return res.status(400).json({ message: 'Data tidak lengkap (tanggal, items wajib)' });
  if (!kelompok_id && !kegiatan_id) return res.status(400).json({ message: 'kelompok_id atau kegiatan_id wajib' });
  // Resolve kelompok_id dari kegiatan_id jika tidak dikirim
  let finalKelompokId = kelompok_id ? parseInt(kelompok_id) : null;
  if (!finalKelompokId && kegiatan_id) {
    const kg = db.kegiatan.find(k => k.id == kegiatan_id);
    if (kg) {
      const kl = db.kelompok.find(k => k.nama === kg.nama && k.tipe === 'KEGIATAN');
      if (kl) finalKelompokId = kl.id;
    }
  }
  if (!db.absensi_sesi) db.absensi_sesi = [];
  // ── Sesi: replace jika sudah ada (transparan) ──
  const sesiMatch = (s) => {
    if (sesi_id) return s.ustadz_username === req.user.username && s.kelompok_id === finalKelompokId && s.tanggal === tanggal && s.id === parseInt(sesi_id);
    if (finalKelompokId) return s.ustadz_username === req.user.username && s.kelompok_id === finalKelompokId && s.tanggal === tanggal;
    return s.ustadz_username === req.user.username && s.kegiatan_id == kegiatan_id && s.tanggal === tanggal;
  };
  const oldSesi = db.absensi_sesi.find(sesiMatch);
  let currentSesiId;
  if (oldSesi) {
    // Hapus absensi lama milik sesi ini
    if (sesi_id) {
      db.absensi = db.absensi.filter(a => !(a.sesi_id === parseInt(sesi_id) && a.tanggal === tanggal));
    } else if (finalKelompokId) {
      db.absensi = db.absensi.filter(a => !(a.kelompok_id === finalKelompokId && a.tanggal === tanggal && a.recorded_by === req.user.id));
    } else {
      db.absensi = db.absensi.filter(a => !(a.kegiatan_id == kegiatan_id && a.tanggal === tanggal && a.recorded_by === req.user.id));
    }
    oldSesi.created_at = new Date().toISOString();
    currentSesiId = oldSesi.id;
  } else {
    // Buat sesi baru
    const newSesi = { id: nextId(db.absensi_sesi), ustadz_username: req.user.username, kegiatan_id: kegiatan_id ? parseInt(kegiatan_id) : 0, kelompok_id: finalKelompokId, tanggal, jam_sesi: jam_sesi || null, created_at: new Date().toISOString() };
    db.absensi_sesi.push(newSesi);
    currentSesiId = newSesi.id;
  }
  // Insert absensi baru (fresh, bukan upsert) — link ke sesi
  items.forEach(item => {
    db.absensi.push({
      id: nextId(db.absensi), santri_id: item.santri_id,
      kegiatan_id: kegiatan_id ? parseInt(kegiatan_id) : null,
      kelompok_id: finalKelompokId,
      sesi_id: currentSesiId,
      tanggal, status: item.status, keterangan: item.keterangan || '',
      recorded_by: req.user.id, created_at: new Date().toISOString()
    });
  });
  saveDB(db); res.json({ message: 'Absensi tersimpan' });
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

app.post('/api/absen-malam/bulk', authenticate, (req, res) => {
  if (req.user.role === 'wali') return res.status(403).json({ message: 'Wali tidak bisa mengubah absensi' });
  if (!db.absensi_sesi) db.absensi_sesi = [];
  const { tanggal, items } = req.body;
  if (!tanggal || !items) return res.status(400).json({ message: 'Data tidak lengkap (tanggal, items wajib)' });
  // Cari kelompok Absen Malam
  const kelompok = db.kelompok.find(k => k.nama === 'Absen Malam' || k.nama === 'Ngaji Malam');
  const kelompokId = kelompok ? kelompok.id : null;
  // ── Sesi: replace jika sudah ada ──
  const oldSesiMalam = db.absensi_sesi.find(s => s.ustadz_username === req.user.username && (s.kegiatan_nama === 'Absen Malam' || (kelompokId && s.kelompok_id === kelompokId)) && s.tanggal === tanggal);
  if (oldSesiMalam) {
    // Hapus dari unified absensi
    if (kelompokId) {
      db.absensi = db.absensi.filter(a => !(a.kelompok_id === kelompokId && a.tanggal === tanggal && a.recorded_by === req.user.id));
    }
    // Also clean old table for compat
    if (!db.absen_malam) db.absen_malam = [];
    db.absen_malam = db.absen_malam.filter(a => !(a.tanggal === tanggal && a.recorded_by === req.user.id));
    oldSesiMalam.created_at = new Date().toISOString();
  } else {
    db.absensi_sesi.push({ id: nextId(db.absensi_sesi), ustadz_username: req.user.username, kegiatan_id: 0, kelompok_id: kelompokId, kegiatan_nama: 'Absen Malam', tanggal, created_at: new Date().toISOString() });
  }
  // Insert ke unified absensi
  items.forEach(item => {
    db.absensi.push({ id: nextId(db.absensi), santri_id: item.santri_id, kegiatan_id: null, kelompok_id: kelompokId, sesi_id: null, tanggal, status: item.status, keterangan: item.keterangan || '', recorded_by: req.user.id, created_at: new Date().toISOString() });
  });
  saveDB(db); res.json({ message: 'Absen malam tersimpan (unified)' });
});

// ── Absen Sekolah (Tabel Terpisah) ─────────────────────
app.get('/api/absen-sekolah', authenticate, (req, res) => {
  // Read from unified absensi table
  const kelompok = db.kelompok.find(k => k.nama === 'Sekolah Formal');
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

app.post('/api/absen-sekolah/bulk', authenticate, (req, res) => {
  if (req.user.role === 'wali') return res.status(403).json({ message: 'Wali tidak bisa mengubah absensi' });
  if (!db.absensi_sesi) db.absensi_sesi = [];
  const { tanggal, items } = req.body;
  if (!tanggal || !items) return res.status(400).json({ message: 'Data tidak lengkap (tanggal, items wajib)' });
  // Cari kelompok Sekolah Formal
  const kelompok = db.kelompok.find(k => k.nama === 'Sekolah Formal');
  const kelompokId = kelompok ? kelompok.id : null;
  // ── Sesi: replace jika sudah ada ──
  const oldSesiSekolah = db.absensi_sesi.find(s => s.ustadz_username === req.user.username && (s.kegiatan_nama === 'Sekolah Formal' || (kelompokId && s.kelompok_id === kelompokId)) && s.tanggal === tanggal);
  if (oldSesiSekolah) {
    if (kelompokId) {
      db.absensi = db.absensi.filter(a => !(a.kelompok_id === kelompokId && a.tanggal === tanggal && a.recorded_by === req.user.id));
    }
    if (!db.absen_sekolah) db.absen_sekolah = [];
    db.absen_sekolah = db.absen_sekolah.filter(a => !(a.tanggal === tanggal && a.recorded_by === req.user.id));
    oldSesiSekolah.created_at = new Date().toISOString();
  } else {
    db.absensi_sesi.push({ id: nextId(db.absensi_sesi), ustadz_username: req.user.username, kegiatan_id: 0, kelompok_id: kelompokId, kegiatan_nama: 'Sekolah', tanggal, created_at: new Date().toISOString() });
  }
  // Insert ke unified absensi
  items.forEach(item => {
    db.absensi.push({ id: nextId(db.absensi), santri_id: item.santri_id, kegiatan_id: null, kelompok_id: kelompokId, sesi_id: null, tanggal, status: item.status, keterangan: item.keterangan || '', recorded_by: req.user.id, created_at: new Date().toISOString() });
  });
  saveDB(db); res.json({ message: 'Absen sekolah tersimpan (unified)' });
});

// ── Rekap ──────────────────────────────────────────────
app.get('/api/rekap', authenticate, (req, res) => {
  // Rekap by kelompok_tipe (unified - recommended)
  if (req.query.kelompok_tipe) {
    const kelompokIds = db.kelompok.filter(k => k.tipe === req.query.kelompok_tipe).map(k => k.id);
    let list = db.absensi.filter(a => kelompokIds.includes(a.kelompok_id));
    if (req.query.dari) list = list.filter(a => a.tanggal >= req.query.dari);
    if (req.query.sampai) list = list.filter(a => a.tanggal <= req.query.sampai);
    if (req.query.kelompok_id) list = list.filter(a => a.kelompok_id == req.query.kelompok_id);
    return res.json(list.map(a => {
      const s = db.santri.find(x => x.id === a.santri_id);
      const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
      const kl = db.kelompok.find(x => x.id === a.kelompok_id);
      return { tanggal: a.tanggal, nama: s ? s.nama : '-', kamar_nama: k ? k.nama : '-', kelompok_nama: kl ? kl.nama : '-', kegiatan_nama: kl ? kl.nama : '-', status: a.status, keterangan: a.keterangan };
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
  // Rekap Absen Sekolah - tabel terpisah
  if (req.query.tipe === 'absen_sekolah') {
    let list = db.absen_sekolah || [];
    if (req.query.dari) list = list.filter(a => a.tanggal >= req.query.dari);
    if (req.query.sampai) list = list.filter(a => a.tanggal <= req.query.sampai);
    if (req.query.kelas_sekolah) {
      const santriIds = db.santri.filter(s => s.kelas_sekolah === req.query.kelas_sekolah).map(s => s.id);
      list = list.filter(a => santriIds.includes(a.santri_id));
    }
    return res.json(list.map(a => {
      const s = db.santri.find(x => x.id === a.santri_id);
      const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
      return { tanggal: a.tanggal, nama: s ? s.nama : '-', kamar_nama: k ? k.nama : '-', kegiatan_nama: 'Sekolah', status: a.status, keterangan: a.keterangan };
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
  let list = db.absensi.map(a => {
    const s = db.santri.find(x => x.id === a.santri_id);
    const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
    const kg = db.kegiatan.find(x => x.id === a.kegiatan_id);
    const kl = db.kelompok.find(x => x.id === a.kelompok_id);
    return { tanggal: a.tanggal, nama: s ? s.nama : '-', kamar_nama: k ? k.nama : '-', kelompok_nama: kl ? kl.nama : '-', kegiatan_nama: kg ? kg.nama : (kl ? kl.nama : '-'), status: a.status, keterangan: a.keterangan || '' };
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
app.post('/api/pengumuman', authenticate, requireAdmin, (req, res) => {
  const { judul, isi } = req.body;
  if (!judul || !isi) return res.status(400).json({ message: 'Judul & isi wajib' });
  const p = { id: nextId(db.pengumuman), judul, isi, created_by: req.user.id, created_at: new Date().toISOString() };
  db.pengumuman.push(p); saveDB(db); res.json(p);
});
app.delete('/api/pengumuman/:id', authenticate, requireAdmin, (req, res) => {
  db.pengumuman = db.pengumuman.filter(p => p.id != req.params.id); saveDB(db);
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
app.post('/api/pelanggaran', authenticate, requireAdmin, (req, res) => {
  const { santri_id, tanggal, jenis, keterangan, sanksi } = req.body;
  if (!santri_id || !tanggal || !jenis) return res.status(400).json({ message: 'Santri, tanggal & jenis wajib' });
  if (!db.pelanggaran) db.pelanggaran = [];
  const p = { id: nextId(db.pelanggaran), santri_id: parseInt(santri_id), tanggal, jenis, keterangan: keterangan || '', sanksi: sanksi || '', created_at: new Date().toISOString() };
  db.pelanggaran.push(p); saveDB(db); res.json(p);
});
app.put('/api/pelanggaran/:id', authenticate, requireAdmin, (req, res) => {
  if (!db.pelanggaran) return res.status(404).json({ message: 'Tidak ditemukan' });
  const p = db.pelanggaran.find(x => x.id == req.params.id);
  if (!p) return res.status(404).json({ message: 'Tidak ditemukan' });
  ['tanggal', 'jenis', 'keterangan', 'sanksi'].forEach(f => { if (req.body[f] !== undefined) p[f] = req.body[f]; });
  if (req.body.santri_id) p.santri_id = parseInt(req.body.santri_id);
  saveDB(db); res.json({ message: 'Pelanggaran diupdate' });
});
app.delete('/api/pelanggaran/:id', authenticate, requireAdmin, (req, res) => {
  if (!db.pelanggaran) return res.status(404).json({ message: 'Tidak ditemukan' });
  db.pelanggaran = db.pelanggaran.filter(p => p.id != req.params.id); saveDB(db);
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
app.post('/api/catatan', authenticate, (req, res) => {
  if (req.user.role === 'wali') return res.status(403).json({ message: 'Wali tidak bisa membuat catatan' });
  const { santri_id, tanggal, judul, isi, kategori } = req.body;
  if (!santri_id || !tanggal || !isi) return res.status(400).json({ message: 'Santri, tanggal & isi wajib' });
  if (!db.catatan_guru) db.catatan_guru = [];
  const c = {
    id: nextId(db.catatan_guru), santri_id: parseInt(santri_id), tanggal,
    judul: judul || '', isi, kategori: kategori || 'lainnya',
    created_by: req.user.id, created_at: new Date().toISOString()
  };
  db.catatan_guru.push(c); saveDB(db); res.json(c);
});
app.put('/api/catatan/:id', authenticate, (req, res) => {
  if (req.user.role === 'wali') return res.status(403).json({ message: 'Wali tidak bisa mengubah catatan' });
  if (!db.catatan_guru) return res.status(404).json({ message: 'Tidak ditemukan' });
  const c = db.catatan_guru.find(x => x.id == req.params.id);
  if (!c) return res.status(404).json({ message: 'Tidak ditemukan' });
  ['santri_id', 'tanggal', 'judul', 'isi', 'kategori'].forEach(f => { if (req.body[f] !== undefined) c[f] = req.body[f]; });
  if (req.body.santri_id) c.santri_id = parseInt(req.body.santri_id);
  saveDB(db); res.json({ message: 'Catatan diupdate' });
});
app.delete('/api/catatan/:id', authenticate, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'Hanya admin' });
  if (!db.catatan_guru) return res.status(404).json({ message: 'Tidak ditemukan' });
  db.catatan_guru = db.catatan_guru.filter(c => c.id != req.params.id);
  saveDB(db); res.json({ message: 'Catatan dihapus' });
});

// ── Download All Raport (ZIP) ──────────────────────────
app.get('/api/raport/download-all', authenticate, (req, res) => {
  const dataSettings = loadDB();
  const appName = (dataSettings.settings && dataSettings.settings.app_name) || 'Pesantren';
  const kepalaNama = (dataSettings.settings && dataSettings.settings.kepala_nama) || '';
  const alamatLembaga = (dataSettings.settings && dataSettings.settings.alamat_lembaga) || '';
  const namaKota = (dataSettings.settings && dataSettings.settings.nama_kota) || '';
  const logoData = (dataSettings.settings && dataSettings.settings.logo) || '';
  const bulanNama = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const tglCetak = new Date();
  const tglStr = (namaKota ? namaKota + ', ' : '') + tglCetak.getDate() + ' ' + bulanNama[tglCetak.getMonth() + 1] + ' ' + tglCetak.getFullYear();
  const waliDisplay_ = '......................................';
  const kepalaDisplay = (kepalaNama && kepalaNama !== '-') ? kepalaNama : '......................................';

  let santriList = db.santri.filter(s => s.status === 'aktif');
  if (!santriList.length) return res.status(404).json({ message: 'Tidak ada santri aktif' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename=raport-semua-santri.zip');
  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.pipe(res);
  archive.on('error', (err) => { console.error('ZIP error:', err); res.status(500).end(); });

  function generateRaportPDF(santri) {
    return new Promise((resolve) => {
      const kamar = db.kamar.find(k => k.id === santri.kamar_id);
      let absensiList = db.absensi.filter(a => a.santri_id === santri.id);
      if (req.query.dari) absensiList = absensiList.filter(a => a.tanggal >= req.query.dari);
      if (req.query.sampai) absensiList = absensiList.filter(a => a.tanggal <= req.query.sampai);
      const rekap = {};
      absensiList.forEach(a => {
        const kg = db.kegiatan.find(k => k.id === a.kegiatan_id);
        const namaKeg = kg ? kg.nama : 'Lainnya';
        if (!rekap[namaKeg]) rekap[namaKeg] = { H: 0, I: 0, S: 0, A: 0 };
        rekap[namaKeg][a.status]++;
      });
      let absenMalamList = (db.absen_malam || []).filter(a => a.santri_id === santri.id);
      if (req.query.dari) absenMalamList = absenMalamList.filter(a => a.tanggal >= req.query.dari);
      if (req.query.sampai) absenMalamList = absenMalamList.filter(a => a.tanggal <= req.query.sampai);
      if (absenMalamList.length) { rekap['Absen Malam'] = { H: 0, I: 0, S: 0, A: 0 }; absenMalamList.forEach(a => rekap['Absen Malam'][a.status]++); }
      let absenSekolahList = (db.absen_sekolah || []).filter(a => a.santri_id === santri.id);
      if (req.query.dari) absenSekolahList = absenSekolahList.filter(a => a.tanggal >= req.query.dari);
      if (req.query.sampai) absenSekolahList = absenSekolahList.filter(a => a.tanggal <= req.query.sampai);
      if (absenSekolahList.length) { rekap['Sekolah'] = { H: 0, I: 0, S: 0, A: 0 }; absenSekolahList.forEach(a => rekap['Sekolah'][a.status]++); }
      const wali = santri.wali_user_id ? db.users.find(u => u.id === santri.wali_user_id) : null;
      const waliD = (wali && wali.nama && wali.nama !== '-') ? wali.nama : waliDisplay_;
      const sampaiD = req.query.sampai ? new Date(req.query.sampai) : new Date();
      const periodeLabel = bulanNama[sampaiD.getMonth() + 1] + ' ' + sampaiD.getFullYear();
      const totalH = Object.values(rekap).reduce((s, r) => s + r.H, 0);
      const totalI = Object.values(rekap).reduce((s, r) => s + r.I, 0);
      const totalS = Object.values(rekap).reduce((s, r) => s + r.S, 0);
      const totalA = Object.values(rekap).reduce((s, r) => s + r.A, 0);
      const totalAll = totalH + totalI + totalS + totalA;

      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve({ filename: 'raport-' + santri.nama.replace(/[^a-zA-Z0-9\u00C0-\u024F]/g, '-') + '.pdf', buffer: Buffer.concat(chunks) }));
      const L = 40, R = 555, W = R - L;
      let yy = 40;
      const logoW = 75; const textX = L + logoW; const textW = W - logoW * 2;
      if (logoData && logoData.startsWith('data:')) { try { doc.image(Buffer.from(logoData.split(',')[1], 'base64'), L, yy, { width: 50, height: 50 }); } catch (e) {} }
      doc.fontSize(14).font('Helvetica-Bold').text(appName, textX, yy, { width: textW, align: 'center' }); yy += 18;
      doc.fontSize(11).font('Helvetica-Bold').text('LAPORAN BULANAN PERKEMBANGAN SANTRI', textX, yy, { width: textW, align: 'center' }); yy += 14;
      doc.fontSize(8).font('Helvetica').text(alamatLembaga || '', textX, yy, { width: textW, align: 'center' }); yy += 14;
      doc.moveTo(L, yy + 4).lineTo(R, yy + 4).lineWidth(1.5).stroke();
      doc.moveTo(L, yy + 7).lineTo(R, yy + 7).lineWidth(0.5).stroke(); yy += 16;
      doc.fontSize(9);
      const lbl1X = L, col1X = L + 85, val1X = L + 95;
      const lbl2X = 320, col2X = 320 + 85, val2X = 320 + 95;
      const dataW_ = 135;
      doc.font('Helvetica-Bold').text('Nama Santri', lbl1X, yy, { width: 85 }); doc.text(':', col1X, yy);
      doc.font('Helvetica').text(santri.nama, val1X, yy, { width: dataW_ });
      doc.font('Helvetica-Bold').text('Kelas Diniyyah', lbl2X, yy); doc.text(':', col2X, yy);
      doc.font('Helvetica').text(santri.kelas_diniyyah || '-', val2X, yy, { width: dataW_ }); yy += 14;
      doc.font('Helvetica-Bold').text('Asrama', lbl1X, yy, { width: 85 }); doc.text(':', col1X, yy);
      doc.font('Helvetica').text(kamar ? kamar.nama : '-', val1X, yy, { width: dataW_ });
      doc.font('Helvetica-Bold').text('Periode', lbl2X, yy); doc.text(':', col2X, yy);
      doc.font('Helvetica').text(periodeLabel, val2X, yy, { width: dataW_ }); yy += 14;
      doc.font('Helvetica-Bold').text('Alamat', lbl1X, yy, { width: 85 }); doc.text(':', col1X, yy);
      doc.font('Helvetica').text(santri.alamat || '-', val1X, yy, { width: dataW_ });
      doc.font('Helvetica-Bold').text('Orang Tua', lbl2X, yy); doc.text(':', col2X, yy);
      doc.font('Helvetica').text(waliD, val2X, yy, { width: dataW_ }); yy += 18;
      doc.moveTo(L, yy - 4).lineTo(R, yy - 4).lineWidth(0.5).stroke(); yy += 8;
      doc.fontSize(10).font('Helvetica-Bold').text('A. Rekap Absensi', L, yy);
      doc.moveTo(L, doc.y + 2).lineTo(L + 110, doc.y + 2).lineWidth(1).stroke(); yy = doc.y + 8;
      const colW2 = [140, 55, 55, 55, 55, 55];
      const headers2 = ['Kegiatan', 'Hadir', 'Izin', 'Sakit', 'Alpa', 'Total'];
      doc.rect(L, yy - 3, colW2.reduce((a, b) => a + b, 0), 14).fill('#f0f0f0').fillColor('#000');
      doc.fontSize(8).font('Helvetica-Bold');
      let xx = L;
      headers2.forEach((h, i) => { doc.text(h, xx, yy, { width: colW2[i], align: i > 0 ? 'center' : 'left' }); xx += colW2[i]; });
      yy += 14;
      doc.moveTo(L, yy - 2).lineTo(L + colW2.reduce((a, b) => a + b, 0), yy - 2).lineWidth(0.5).stroke();
      doc.font('Helvetica').fontSize(8).fillColor('#000');
      Object.entries(rekap).forEach(([keg, r]) => {
        const t = r.H + r.I + r.S + r.A; xx = L;
        [keg, r.H, r.I, r.S, r.A, t].forEach((c, i) => { doc.text(String(c), xx, yy, { width: colW2[i], align: i > 0 ? 'center' : 'left' }); xx += colW2[i]; }); yy += 13;
      });
      xx = L; doc.font('Helvetica-Bold');
      ['TOTAL', totalH, totalI, totalS, totalA, totalAll].forEach((c, i) => { doc.text(String(c), xx, yy, { width: colW2[i], align: i > 0 ? 'center' : 'left' }); xx += colW2[i]; });
      yy += 20;
      if (yy > 680) { doc.addPage(); yy = 40; }
      doc.fontSize(9).font('Helvetica');
      const sigW = (R - L) / 3;
      doc.text(tglStr, L, yy, { width: sigW, align: 'center' }); yy += 14;
      doc.text('Wali Santri', L, yy, { width: sigW, align: 'center' });
      doc.text('Wali Kelas', L + sigW, yy, { width: sigW, align: 'center' });
      doc.text('Kepala Yayasan', L + sigW * 2, yy, { width: sigW, align: 'center' }); yy += 50;
      doc.moveTo(L + 20, yy - 2).lineTo(L + sigW - 20, yy - 2).stroke();
      doc.moveTo(L + sigW + 20, yy - 2).lineTo(L + sigW * 2 - 20, yy - 2).stroke();
      doc.text(kepalaDisplay, L + sigW * 2, yy, { width: sigW, align: 'center' });
      doc.moveTo(L + sigW * 2 + 20, yy - 2).lineTo(R - 20, yy - 2).stroke();
      doc.end();
    });
  }

  (async () => {
    for (const santri of santriList) {
      const { filename, buffer } = await generateRaportPDF(santri);
      archive.append(buffer, { name: filename });
    }
    archive.finalize();
  })();
});

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
  // Group absensi by kegiatan - show ALL kegiatan
  const rekap = {};
  // Initialize all kegiatan with 0
  db.kegiatan.forEach(k => {
    rekap[k.nama] = { H: 0, I: 0, S: 0, A: 0, detail: [] };
  });
  // Fill in actual data
  absensiList.forEach(a => {
    const kg = db.kegiatan.find(k => k.id === a.kegiatan_id);
    const nama = kg ? kg.nama : 'Lainnya';
    if (!rekap[nama]) rekap[nama] = { H: 0, I: 0, S: 0, A: 0, detail: [] };
    rekap[nama][a.status] = (rekap[nama][a.status] || 0) + 1;
    rekap[nama].detail.push({ tanggal: a.tanggal, status: a.status, keterangan: a.keterangan });
  });
  // Tambah Absen Malam dari tabel terpisah
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
  // Tambah Absen Sekolah dari tabel terpisah
  let absenSekolahList = (db.absen_sekolah || []).filter(a => a.santri_id === santri.id);
  if (req.query.dari) absenSekolahList = absenSekolahList.filter(a => a.tanggal >= req.query.dari);
  if (req.query.sampai) absenSekolahList = absenSekolahList.filter(a => a.tanggal <= req.query.sampai);
  if (absenSekolahList.length) {
    rekap['Sekolah'] = { H: 0, I: 0, S: 0, A: 0, detail: [] };
    absenSekolahList.forEach(a => {
      rekap['Sekolah'][a.status] = (rekap['Sekolah'][a.status] || 0) + 1;
      rekap['Sekolah'].detail.push({ tanggal: a.tanggal, status: a.status, keterangan: a.keterangan });
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

// ── Export Raport PDF (4-Zone Layout) ───────────────────
app.get('/api/raport/:santri_id/pdf', authenticate, (req, res) => {
  const santri = db.santri.find(s => s.id == req.params.santri_id);
  if (!santri) return res.status(404).json({ message: 'Santri tidak ditemukan' });
  const kamar = db.kamar.find(k => k.id === santri.kamar_id);
  // Absensi rekap
  let absensiList = db.absensi.filter(a => a.santri_id === santri.id);
  if (req.query.dari) absensiList = absensiList.filter(a => a.tanggal >= req.query.dari);
  if (req.query.sampai) absensiList = absensiList.filter(a => a.tanggal <= req.query.sampai);
  const rekap = {};
  absensiList.forEach(a => {
    const kg = db.kegiatan.find(k => k.id === a.kegiatan_id);
    const nama = kg ? kg.nama : 'Lainnya';
    if (!rekap[nama]) rekap[nama] = { H: 0, I: 0, S: 0, A: 0 };
    rekap[nama][a.status]++;
  });
  // Absen Malam
  let absenMalamList = (db.absen_malam || []).filter(a => a.santri_id === santri.id);
  if (req.query.dari) absenMalamList = absenMalamList.filter(a => a.tanggal >= req.query.dari);
  if (req.query.sampai) absenMalamList = absenMalamList.filter(a => a.tanggal <= req.query.sampai);
  if (absenMalamList.length) {
    rekap['Absen Malam'] = { H: 0, I: 0, S: 0, A: 0 };
    absenMalamList.forEach(a => rekap['Absen Malam'][a.status]++);
  }
  // Absen Sekolah
  let absenSekolahList = (db.absen_sekolah || []).filter(a => a.santri_id === santri.id);
  if (req.query.dari) absenSekolahList = absenSekolahList.filter(a => a.tanggal >= req.query.dari);
  if (req.query.sampai) absenSekolahList = absenSekolahList.filter(a => a.tanggal <= req.query.sampai);
  if (absenSekolahList.length) {
    rekap['Sekolah'] = { H: 0, I: 0, S: 0, A: 0 };
    absenSekolahList.forEach(a => rekap['Sekolah'][a.status]++);
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
  const dataSettings = loadDB();
  const appName = (dataSettings.settings && dataSettings.settings.app_name) || 'Pesantren';
  const kepalaNama = (dataSettings.settings && dataSettings.settings.kepala_nama) || '';
  const alamatLembaga = (dataSettings.settings && dataSettings.settings.alamat_lembaga) || '';
  const namaKota = (dataSettings.settings && dataSettings.settings.nama_kota) || '';
  const logoData = (dataSettings.settings && dataSettings.settings.logo) || '';
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
  const data = loadDB();
  res.json(data.settings || { app_name: 'Pesantren Absensi', logo: '' });
});
app.put('/api/settings', authenticate, requireAdmin, (req, res) => {
  const data = loadDB();
  data.settings = { ...data.settings, ...req.body };
  saveDB(data);
  res.json({ message: 'Pengaturan disimpan', settings: data.settings });
});
app.post('/api/settings/logo', authenticate, requireAdmin, (req, res) => {
  const { logo } = req.body;
  if (!logo) return res.status(400).json({ message: 'Logo wajib' });
  const data = loadDB();
  if (!data.settings) data.settings = { app_name: 'Pesantren Absensi' };
  data.settings.logo = logo;
  saveDB(data);
  res.json({ message: 'Logo diupdate' });
});
app.post('/api/settings/background', authenticate, requireAdmin, (req, res) => {
  const { background } = req.body;
  if (!background) return res.status(400).json({ message: 'Background wajib' });
  const data = loadDB();
  if (!data.settings) data.settings = { app_name: 'Pesantren Absensi' };
  data.settings.background = background;
  saveDB(data);
  res.json({ message: 'Background diupdate' });
});
app.post('/api/settings/dashboard-bg', authenticate, requireAdmin, (req, res) => {
  const { dashboard_bg } = req.body;
  if (!dashboard_bg) return res.status(400).json({ message: 'Background dashboard wajib' });
  const data = loadDB();
  if (!data.settings) data.settings = { app_name: 'Pesantren Absensi' };
  data.settings.dashboard_bg = dashboard_bg;
  saveDB(data);
  res.json({ message: 'Background dashboard diupdate' });
});
app.post('/api/settings/delete', authenticate, requireAdmin, (req, res) => {
  const { field } = req.body;
  const allowed = ['logo', 'background', 'dashboard_bg'];
  if (!allowed.includes(field)) return res.status(400).json({ message: 'Field tidak valid' });
  const data = loadDB();
  if (data.settings) delete data.settings[field];
  saveDB(data);
  res.json({ message: field + ' dihapus' });
});

// File upload endpoints (multer)
app.post('/api/settings/logo-file', authenticate, requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'File tidak ada' });
  const data = loadDB();
  if (!data.settings) data.settings = { app_name: 'Pesantren Absensi' };
  data.settings.logo = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
  saveDB(data);
  res.json({ message: 'Logo diupload' });
});
app.post('/api/settings/bg-file', authenticate, requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'File tidak ada' });
  const data = loadDB();
  if (!data.settings) data.settings = { app_name: 'Pesantren Absensi' };
  data.settings.background = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
  saveDB(data);
  res.json({ message: 'Background login diupload' });
});
app.post('/api/settings/dash-bg-file', authenticate, requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'File tidak ada' });
  const data = loadDB();
  if (!data.settings) data.settings = { app_name: 'Pesantren Absensi' };
  data.settings.dashboard_bg = 'data:' + req.file.mimetype + ';base64,' + req.file.buffer.toString('base64');
  saveDB(data);
  res.json({ message: 'Background menu diupload' });
});

// ── Export PDF ──────────────────────────────────────────
app.get('/api/export/pdf', authenticate, (req, res) => {
  let list = db.absensi;
  if (req.query.dari) list = list.filter(a => a.tanggal >= req.query.dari);
  if (req.query.sampai) list = list.filter(a => a.tanggal <= req.query.sampai);
  if (req.query.kegiatan_id) list = list.filter(a => a.kegiatan_id == req.query.kegiatan_id);
  const santriFilters = ['kamar_id', 'kelas_diniyyah', 'kelompok_ngaji', 'kelompok_ngaji_malam', 'jenis_bakat', 'kelas_sekolah'];
  santriFilters.forEach(f => {
    if (req.query[f]) {
      const santriIds = db.santri.filter(s => String(s[f]) === String(req.query[f])).map(s => s.id);
      list = list.filter(a => santriIds.includes(a.santri_id));
    }
  });

  const data = list.map(a => {
    const s = db.santri.find(x => x.id === a.santri_id);
    const k = s ? db.kamar.find(x => x.id === s.kamar_id) : null;
    const kg = db.kegiatan.find(x => x.id === a.kegiatan_id);
    return { tanggal: a.tanggal, nama: s ? s.nama : '-', kamar: k ? k.nama : '-', kegiatan: kg ? kg.nama : '-', status: a.status, keterangan: a.keterangan };
  }).sort((a, b) => b.tanggal.localeCompare(a.tanggal));

  const statusMap = { H: 'Hadir', I: 'Izin', S: 'Sakit', A: 'Alfa' };

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=rekap-absensi.pdf');
  doc.pipe(res);

  // Header
  const data_settings = loadDB();
  const appName = (data_settings.settings && data_settings.settings.app_name) || 'Pesantren';
  doc.fontSize(18).font('Helvetica-Bold').text('REKAP ABSENSI SANTRI', { align: 'center' });
  doc.fontSize(10).font('Helvetica').text(appName, { align: 'center' });
  doc.moveDown(0.5);
  const filterText = [];
  if (req.query.dari) filterText.push(`Dari: ${req.query.dari}`);
  if (req.query.sampai) filterText.push(`Sampai: ${req.query.sampai}`);
  if (req.query.kegiatan_id) {
    const kg = db.kegiatan.find(x => x.id == req.query.kegiatan_id);
    if (kg) filterText.push(`Kegiatan: ${kg.nama}`);
  }
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
  const dataSettings = loadDB();
  const appName = (dataSettings.settings && dataSettings.settings.app_name) || 'Pesantren';
  const alamatLembaga = (dataSettings.settings && dataSettings.settings.alamat_lembaga) || '';
  const logoData = (dataSettings.settings && dataSettings.settings.logo) || '';
  const bulanNama = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

  // ── Ambil data rekap (sama seperti /api/export/pdf) ──
  let list = db.absensi;
  if (req.query.dari) list = list.filter(a => a.tanggal >= req.query.dari);
  if (req.query.sampai) list = list.filter(a => a.tanggal <= req.query.sampai);
  if (req.query.kegiatan_id) list = list.filter(a => a.kegiatan_id == req.query.kegiatan_id);
  const santriFilters = ['kamar_id', 'kelas_diniyyah', 'kelompok_ngaji', 'kelompok_ngaji_malam', 'jenis_bakat', 'kelas_sekolah'];
  santriFilters.forEach(f => {
    if (req.query[f]) {
      const santriIds = db.santri.filter(s => String(s[f]) === String(req.query[f])).map(s => s.id);
      list = list.filter(a => santriIds.includes(a.santri_id));
    }
  });

  // ── Pivot: per santri, per kegiatan, hitung H/I/S/A ──
  const pivot = {};
  const kegiatanSet = new Set();
  list.forEach(a => {
    const s = db.santri.find(x => x.id === a.santri_id);
    if (!s) return;
    const kg = db.kegiatan.find(x => x.id === a.kegiatan_id);
    const namaKeg = kg ? kg.nama : 'Lainnya';
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
app.post('/api/maintenance/cleanup-absensi', authenticate, requireAdmin, (req, res) => {
  const validKegiatanIds = new Set(db.kegiatan.map(k => k.id));
  const before = db.absensi.length;
  db.absensi = db.absensi.filter(a => validKegiatanIds.has(a.kegiatan_id));
  const removed = before - db.absensi.length;
  saveDB(db);
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
  const dataSettings = loadDB();
  const appName = (dataSettings.settings && dataSettings.settings.app_name) || 'Pesantren';
  const kepalaNama = (dataSettings.settings && dataSettings.settings.kepala_nama) || '';
  const alamatLembaga = (dataSettings.settings && dataSettings.settings.alamat_lembaga) || '';
  const namaKota = (dataSettings.settings && dataSettings.settings.nama_kota) || '';
  const logoData = (dataSettings.settings && dataSettings.settings.logo) || '';

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
  const dataSettings = loadDB();
  const appName = (dataSettings.settings && dataSettings.settings.app_name) || 'Pesantren';
  const alamatLembaga = (dataSettings.settings && dataSettings.settings.alamat_lembaga) || '';
  const logoData = (dataSettings.settings && dataSettings.settings.logo) || '';
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

app.listen(PORT, () => console.log(`Server jalan di http://localhost:${PORT}`));
