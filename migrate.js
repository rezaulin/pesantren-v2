/**
 * MIGRATION SCRIPT: Flat fields → Many-to-Many (kelompok + pivot)
 * & Merge absen_sekolah + absen_malam → absensi
 * 
 * Run: node migrate.js
 * Backup: data.json.backup.* (auto-created before migration)
 */

const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.json');
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));

console.log('=== MIGRATION START ===\n');

// ── 1. Buat kelompok dari KAMAR ─────────────────────────────────
if (!db.kelompok) db.kelompok = [];
let kelompokId = db.kelompok.length ? Math.max(...db.kelompok.map(k => k.id)) + 1 : 1;

// Map: old_id → new_kelompok_id
const kamarToKelompok = {};
(db.kamar || []).forEach(k => {
  const existing = db.kelompok.find(kl => kl.nama === k.nama && kl.tipe === 'KAMAR');
  if (existing) {
    kamarToKelompok[k.id] = existing.id;
  } else {
    const kel = { id: kelompokId++, nama: k.nama, tipe: 'KAMAR', created_at: k.created_at || new Date().toISOString() };
    db.kelompok.push(kel);
    kamarToKelompok[k.id] = kel.id;
  }
});
console.log(`✓ KAMAR: ${Object.keys(kamarToKelompok).length} kelompok dibuat`);

// ── 2. Buat kelompok dari KEGIATAN ──────────────────────────────
const kegiatanToKelompok = {};
(db.kegiatan || []).forEach(k => {
  const existing = db.kelompok.find(kl => kl.nama === k.nama && kl.tipe === 'KEGIATAN');
  if (existing) {
    kegiatanToKelompok[k.id] = existing.id;
  } else {
    const kel = { id: kelompokId++, nama: k.nama, tipe: 'KEGIATAN', created_at: k.created_at || new Date().toISOString() };
    db.kelompok.push(kel);
    kegiatanToKelompok[k.id] = kel.id;
  }
});
console.log(`✓ KEGIATAN: ${Object.keys(kegiatanToKelompok).length} kelompok dibuat`);

// ── 3. Buat kelompok dari flat fields santri ────────────────────
function getOrCreateKelompok(nama, tipe) {
  if (!nama || !nama.trim()) return null;
  nama = nama.trim();
  let existing = db.kelompok.find(k => k.nama.toLowerCase() === nama.toLowerCase() && k.tipe === tipe);
  if (existing) return existing.id;
  const kel = { id: kelompokId++, nama, tipe, created_at: new Date().toISOString() };
  db.kelompok.push(kel);
  return kel.id;
}

// ── 4. Buat santri_kelompok (pivot) dari data santri ────────────
if (!db.santri_kelompok) db.santri_kelompok = [];
const now = new Date().toISOString();

(db.santri || []).forEach(s => {
  // Kamar
  if (s.kamar_id && kamarToKelompok[s.kamar_id]) {
    const exists = db.santri_kelompok.find(sk => sk.santri_id === s.id && sk.kelompok_id === kamarToKelompok[s.kamar_id]);
    if (!exists) {
      db.santri_kelompok.push({ santri_id: s.id, kelompok_id: kamarToKelompok[s.kamar_id], status: 'aktif', created_at: s.created_at || now });
    }
  }
  // Kelas Diniyyah
  const diniyyahId = getOrCreateKelompok(s.kelas_diniyyah, 'SEKOLAH');
  if (diniyyahId) {
    const exists = db.santri_kelompok.find(sk => sk.santri_id === s.id && sk.kelompok_id === diniyyahId);
    if (!exists) {
      db.santri_kelompok.push({ santri_id: s.id, kelompok_id: diniyyahId, status: 'aktif', created_at: s.created_at || now });
    }
  }
  // Kelompok Ngaji (SOROGAN)
  const ngajiId = getOrCreateKelompok(s.kelompok_ngaji, 'SOROGAN');
  if (ngajiId) {
    const exists = db.santri_kelompok.find(sk => sk.santri_id === s.id && sk.kelompok_id === ngajiId);
    if (!exists) {
      db.santri_kelompok.push({ santri_id: s.id, kelompok_id: ngajiId, status: 'aktif', created_at: s.created_at || now });
    }
  }
  // Jenis Bakat
  const bakatId = getOrCreateKelompok(s.jenis_bakat, 'BAKAT');
  if (bakatId) {
    const exists = db.santri_kelompok.find(sk => sk.santri_id === s.id && sk.kelompok_id === bakatId);
    if (!exists) {
      db.santri_kelompok.push({ santri_id: s.id, kelompok_id: bakatId, status: 'aktif', created_at: s.created_at || now });
    }
  }
  // Kelas Sekolah
  const sekolahId = getOrCreateKelompok(s.kelas_sekolah, 'SEKOLAH');
  if (sekolahId) {
    const exists = db.santri_kelompok.find(sk => sk.santri_id === s.id && sk.kelompok_id === sekolahId);
    if (!exists) {
      db.santri_kelompok.push({ santri_id: s.id, kelompok_id: sekolahId, status: 'aktif', created_at: s.created_at || now });
    }
  }
  // Kelompok Ngaji Malam
  const malamId = getOrCreateKelompok(s.kelompok_ngaji_malam, 'SOROGAN_MALAM');
  if (malamId) {
    const exists = db.santri_kelompok.find(sk => sk.santri_id === s.id && sk.kelompok_id === malamId);
    if (!exists) {
      db.santri_kelompok.push({ santri_id: s.id, kelompok_id: malamId, status: 'aktif', created_at: s.created_at || now });
    }
  }
});
console.log(`✓ SANTRI_KELOMPOK: ${db.santri_kelompok.length} relasi dibuat`);

// ── 5. Migrasi absen_malam → absensi ────────────────────────────
// Cari kelompok_id untuk "Absen Malam"
const absenMalamKelompok = db.kelompok.find(k => k.nama === 'Absen Malam' || k.nama === 'Ngaji Malam');
let absenMalamKelompokId = absenMalamKelompok ? absenMalamKelompok.id : null;
if (!absenMalamKelompokId) {
  const kel = { id: kelompokId++, nama: 'Absen Malam', tipe: 'KEGIATAN', created_at: now };
  db.kelompok.push(kel);
  absenMalamKelompokId = kel.id;
}

let absenId = db.absensi.length ? Math.max(...db.absensi.map(a => a.id)) + 1 : 1;
let migratedMalam = 0;

(db.absen_malam || []).forEach(a => {
  // Cek duplikat: jangan migrasi kalau sudah ada di absensi
  const duplikat = db.absensi.find(ex => 
    ex.santri_id === a.santri_id && ex.tanggal === a.tanggal && ex.kelompok_id === absenMalamKelompokId
  );
  if (!duplikat) {
    db.absensi.push({
      id: absenId++,
      santri_id: a.santri_id,
      kegiatan_id: null,
      kelompok_id: absenMalamKelompokId,
      sesi_id: a.sesi_id || null,
      tanggal: a.tanggal,
      status: a.status,
      keterangan: a.keterangan || '',
      recorded_by: a.recorded_by,
      created_at: a.created_at || now
    });
    migratedMalam++;
  }
});
console.log(`✓ ABSEN MALAM → absensi: ${migratedMalam} record dimigrasi`);

// ── 6. Migrasi absen_sekolah → absensi ──────────────────────────
// Cari kelompok_id untuk "Sekolah Formal"
const absenSekolahKelompok = db.kelompok.find(k => k.nama === 'Sekolah Formal');
let absenSekolahKelompokId = absenSekolahKelompok ? absenSekolahKelompok.id : null;
if (!absenSekolahKelompokId) {
  const kel = { id: kelompokId++, nama: 'Sekolah Formal', tipe: 'SEKOLAH', created_at: now };
  db.kelompok.push(kel);
  absenSekolahKelompokId = kel.id;
}

let migratedSekolah = 0;
(db.absen_sekolah || []).forEach(a => {
  const duplikat = db.absensi.find(ex => 
    ex.santri_id === a.santri_id && ex.tanggal === a.tanggal && ex.kelompok_id === absenSekolahKelompokId
  );
  if (!duplikat) {
    db.absensi.push({
      id: absenId++,
      santri_id: a.santri_id,
      kegiatan_id: null,
      kelompok_id: absenSekolahKelompokId,
      sesi_id: a.sesi_id || null,
      tanggal: a.tanggal,
      status: a.status,
      keterangan: a.keterangan || '',
      recorded_by: a.recorded_by,
      created_at: a.created_at || now
    });
    migratedSekolah++;
  }
});
console.log(`✓ ABSEN SEKOLAH → absensi: ${migratedSekolah} record dimigrasi`);

// ── 7. Update absensi lama: tambah kelompok_id dari kegiatan_id ──
let updatedAbsensi = 0;
db.absensi.forEach(a => {
  if (!a.kelompok_id && a.kegiatan_id) {
    const kelId = kegiatanToKelompok[a.kegiatan_id];
    if (kelId) {
      a.kelompok_id = kelId;
      updatedAbsensi++;
    }
  }
  // Pastikan sesi_id ada (null kalau tidak ada)
  if (a.sesi_id === undefined) a.sesi_id = null;
});
console.log(`✓ ABSENSI lama diupdate: ${updatedAbsensi} record ditambah kelompok_id`);

// ── 8. Update absensi_sesi: tambah kelompok_id ─────────────────
if (!db.absensi_sesi) db.absensi_sesi = [];
let updatedSesi = 0;
db.absensi_sesi.forEach(s => {
  if (!s.kelompok_id) {
    if (s.kegiatan_id && kegiatanToKelompok[s.kegiatan_id]) {
      s.kelompok_id = kegiatanToKelompok[s.kegiatan_id];
      updatedSesi++;
    }
  }
  // Tambah jam_sesi kalau tidak ada
  if (s.jam_sesi === undefined) s.jam_sesi = null;
});
console.log(`✓ ABSENSI_SESI diupdate: ${updatedSesi} record ditambah kelompok_id`);

// ── 9. Simpan ──────────────────────────────────────────────────
fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

console.log('\n=== MIGRATION SELESAI ===');
console.log(`Total kelompok: ${db.kelompok.length}`);
console.log(`Total santri_kelompok: ${db.santri_kelompok.length}`);
console.log(`Total absensi: ${db.absensi.length}`);
console.log(`Tabel lama (absen_malam, absen_sekolah) TIDAK dihapus — masih ada sebagai backup.`);
console.log('\nJalankan PM2 restart setelah ini.');
