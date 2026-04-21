/**
 * Migration script: data.json → MariaDB
 * Run: node migrate-to-mysql.js
 */
const fs = require('fs');
const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host: 'localhost',
  user: 'pesantren',
  password: 'pesantren2026',
  database: 'pesantren',
  multipleStatements: true
};

function toDatetime(iso) {
  if (!iso) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  return iso.slice(0, 19).replace('T', ' ');
}

async function migrate() {
  const db = JSON.parse(fs.readFileSync(__dirname + '/data.json', 'utf8'));
  const conn = await mysql.createConnection(DB_CONFIG);

  console.log('Connected to MariaDB');
  console.log('Data loaded:', Object.keys(db).map(k => `${k}: ${(db[k] || []).length}`).join(', '));

  // Disable FK checks for migration
  await conn.execute('SET FOREIGN_KEY_CHECKS = 0');

  // 1. Users
  console.log('\n--- Users ---');
  for (const u of (db.users || [])) {
    await conn.execute(
      'INSERT INTO users (id, username, password_hash, role, nama, created_at) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), role=VALUES(role), nama=VALUES(nama)',
      [u.id, u.username, u.password_hash, u.role || 'wali', u.nama || '-', toDatetime(u.created_at)]
    );
  }
  console.log(`  Migrated: ${(db.users || []).length} users`);

  // 2. Kamar
  console.log('\n--- Kamar ---');
  for (const k of (db.kamar || [])) {
    await conn.execute(
      'INSERT INTO kamar (id, nama, kapasitas, created_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE nama=VALUES(nama), kapasitas=VALUES(kapasitas)',
      [k.id, k.nama, k.kapasitas || 0, toDatetime(k.created_at)]
    );
  }
  console.log(`  Migrated: ${(db.kamar || []).length} kamar`);

  // 3. Kelas Sekolah
  console.log('\n--- Kelas Sekolah ---');
  for (const k of (db.kelas_sekolah || [])) {
    await conn.execute(
      'INSERT INTO kelas_sekolah (id, nama, created_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE nama=VALUES(nama)',
      [k.id, k.nama, toDatetime(k.created_at)]
    );
  }
  console.log(`  Migrated: ${(db.kelas_sekolah || []).length} kelas_sekolah`);

  // 4. Kegiatan
  console.log('\n--- Kegiatan ---');
  for (const k of (db.kegiatan || [])) {
    await conn.execute(
      'INSERT INTO kegiatan (id, nama, kategori, created_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE nama=VALUES(nama), kategori=VALUES(kategori)',
      [k.id, k.nama, k.kategori || 'tambahan', toDatetime(k.created_at)]
    );
  }
  console.log(`  Migrated: ${(db.kegiatan || []).length} kegiatan`);

  // 5. Santri (before kelompok because of FK)
  console.log('\n--- Santri ---');
  for (const s of (db.santri || [])) {
    await conn.execute(
      `INSERT INTO santri (id, nama, kamar_id, status, kelas_diniyyah, kelompok_ngaji, jenis_bakat, kelas_sekolah, kelompok_ngaji_malam, alamat, wali_user_id, wali_nama, extra, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE nama=VALUES(nama), kamar_id=VALUES(kamar_id), status=VALUES(status)`,
      [s.id, s.nama, s.kamar_id || null, s.status || 'aktif', s.kelas_diniyyah || '', s.kelompok_ngaji || '',
       s.jenis_bakat || '', s.kelas_sekolah || '', s.kelompok_ngaji_malam || '', s.alamat || '',
       s.wali_user_id || null, s.wali_nama || '-', s.extra ? JSON.stringify(s.extra) : null, toDatetime(s.created_at)]
    );
  }
  console.log(`  Migrated: ${(db.santri || []).length} santri`);

  // 6. Kelompok
  console.log('\n--- Kelompok ---');
  for (const k of (db.kelompok || [])) {
    await conn.execute(
      'INSERT INTO kelompok (id, nama, tipe, kegiatan_nama, created_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE nama=VALUES(nama), tipe=VALUES(tipe), kegiatan_nama=VALUES(kegiatan_nama)',
      [k.id, k.nama, k.tipe || '', k.kegiatan_nama || null, toDatetime(k.created_at)]
    );
  }
  console.log(`  Migrated: ${(db.kelompok || []).length} kelompok`);

  // 7. Santri Kelompok
  console.log('\n--- Santri Kelompok ---');
  let skId = 1;
  for (const sk of (db.santri_kelompok || [])) {
    await conn.execute(
      'INSERT INTO santri_kelompok (id, santri_id, kelompok_id, status, created_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status=VALUES(status)',
      [sk.id || skId++, sk.santri_id, sk.kelompok_id || null, sk.status || 'aktif', toDatetime(sk.created_at)]
    );
  }
  console.log(`  Migrated: ${(db.santri_kelompok || []).length} santri_kelompok`);

  // 8. Absensi Sesi
  console.log('\n--- Absensi Sesi ---');
  for (const s of (db.absensi_sesi || [])) {
    await conn.execute(
      'INSERT INTO absensi_sesi (id, ustadz_username, kelompok_id, tanggal, created_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE ustadz_username=VALUES(ustadz_username)',
      [s.id, s.ustadz_username || 'admin', s.kelompok_id || null, s.tanggal, toDatetime(s.created_at)]
    );
  }
  console.log(`  Migrated: ${(db.absensi_sesi || []).length} absensi_sesi`);

  // 9. Absensi
  console.log('\n--- Absensi ---');
  let absCount = 0;
  for (const a of (db.absensi || [])) {
    await conn.execute(
      'INSERT INTO absensi (id, santri_id, kelompok_id, sesi_id, tanggal, status, keterangan, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status=VALUES(status)',
      [a.id, a.santri_id, a.kelompok_id || null, a.sesi_id || null, a.tanggal, a.status, a.keterangan || '', a.recorded_by || null, toDatetime(a.created_at)]
    );
    absCount++;
  }
  console.log(`  Migrated: ${absCount} absensi`);

  // 10. Absen Malam
  console.log('\n--- Absen Malam ---');
  for (const a of (db.absen_malam || [])) {
    await conn.execute(
      'INSERT INTO absen_malam (id, santri_id, tanggal, status, keterangan, created_at) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status=VALUES(status)',
      [a.id, a.santri_id, a.tanggal, a.status, a.keterangan || '', toDatetime(a.created_at)]
    );
  }
  console.log(`  Migrated: ${(db.absen_malam || []).length} absen_malam`);

  // 11. Absen Sekolah
  console.log('\n--- Absen Sekolah ---');
  for (const a of (db.absen_sekolah || [])) {
    await conn.execute(
      'INSERT INTO absen_sekolah (id, santri_id, tanggal, status, kelas_sekolah, keterangan, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status=VALUES(status)',
      [a.id, a.santri_id, a.tanggal, a.status, a.kelas_sekolah || '', a.keterangan || '', toDatetime(a.created_at)]
    );
  }
  console.log(`  Migrated: ${(db.absen_sekolah || []).length} absen_sekolah`);

  // 12. Pelanggaran
  console.log('\n--- Pelanggaran ---');
  for (const p of (db.pelanggaran || [])) {
    await conn.execute(
      'INSERT INTO pelanggaran (id, santri_id, tanggal, jenis, keterangan, sanksi, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE jenis=VALUES(jenis)',
      [p.id, p.santri_id, p.tanggal, p.jenis || '', p.keterangan || '', p.sanksi || '', toDatetime(p.created_at)]
    );
  }
  console.log(`  Migrated: ${(db.pelanggaran || []).length} pelanggaran`);

  // 13. Catatan Guru
  console.log('\n--- Catatan Guru ---');
  for (const c of (db.catatan_guru || [])) {
    await conn.execute(
      'INSERT INTO catatan_guru (id, santri_id, tanggal, kategori, judul, isi, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE isi=VALUES(isi)',
      [c.id, c.santri_id, c.tanggal, c.kategori || 'lainnya', c.judul || '', c.isi || '', c.created_by || null, toDatetime(c.created_at)]
    );
  }
  console.log(`  Migrated: ${(db.catatan_guru || []).length} catatan_guru`);

  // 14. Jadwal Umum
  console.log('\n--- Jadwal Umum ---');
  for (const j of (db.jadwal_umum || [])) {
    await conn.execute(
      'INSERT INTO jadwal_umum (id, kelompok_id, ustadz_username, hari, jam_mulai, jam_selesai, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE jam_mulai=VALUES(jam_mulai)',
      [j.id, j.kelompok_id, j.ustadz_username || '', j.hari || '', j.jam_mulai || '', j.jam_selesai || '', toDatetime(j.created_at)]
    );
  }
  console.log(`  Migrated: ${(db.jadwal_umum || []).length} jadwal_umum`);

  // 15. Jadwal Sekolah
  console.log('\n--- Jadwal Sekolah ---');
  for (const j of (db.jadwal_sekolah || [])) {
    await conn.execute(
      'INSERT INTO jadwal_sekolah (id, kelas_sekolah, hari, jam_mulai, jam_selesai, created_at) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE jam_mulai=VALUES(jam_mulai)',
      [j.id, j.kelas_sekolah || '', j.hari || '', j.jam_mulai || '', j.jam_selesai || '', toDatetime(j.created_at)]
    );
  }
  console.log(`  Migrated: ${(db.jadwal_sekolah || []).length} jadwal_sekolah`);

  // 16. Pengumuman
  console.log('\n--- Pengumuman ---');
  for (const p of (db.pengumuman || [])) {
    await conn.execute(
      'INSERT INTO pengumuman (id, judul, isi, created_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE isi=VALUES(isi)',
      [p.id, p.judul || '', p.isi || '', toDatetime(p.created_at)]
    );
  }
  console.log(`  Migrated: ${(db.pengumuman || []).length} pengumuman`);

  // 17. Settings
  console.log('\n--- Settings ---');
  const s = db.settings || {};
  await conn.execute(
    'INSERT INTO settings (id, app_name, alamat_lembaga, kepala_nama, nama_kota, logo) VALUES (1, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE app_name=VALUES(app_name), alamat_lembaga=VALUES(alamat_lembaga), kepala_nama=VALUES(kepala_nama), nama_kota=VALUES(nama_kota), logo=VALUES(logo)',
    [s.app_name || 'Pesantren', s.alamat_lembaga || '', s.kepala_nama || '', s.nama_kota || '', s.logo || null]
  );
  console.log('  Migrated: settings');

  // Re-enable FK checks
  await conn.execute('SET FOREIGN_KEY_CHECKS = 1');

  // Auto-increment fix
  console.log('\n--- Fix AUTO_INCREMENT ---');
  const tables = ['users','kamar','kelas_sekolah','santri','kegiatan','kelompok','santri_kelompok','absensi_sesi','absensi','absen_malam','absen_sekolah','pelanggaran','catatan_guru','jadwal_umum','jadwal_sekolah','pengumuman'];
  for (const t of tables) {
    await conn.execute(`ALTER TABLE ${t} AUTO_INCREMENT = (SELECT COALESCE(MAX(id), 1) + 1 FROM (SELECT id FROM ${t}) AS tmp)`);
  }
  console.log('  AUTO_INCREMENT fixed');

  // Verify counts
  console.log('\n=== VERIFICATION ===');
  for (const t of ['users','kamar','santri','kelompok','santri_kelompok','absensi','absen_malam','kegiatan','pelanggaran','catatan_guru']) {
    const [rows] = await conn.execute(`SELECT COUNT(*) as cnt FROM ${t}`);
    console.log(`  ${t}: ${rows[0].cnt}`);
  }

  await conn.end();
  console.log('\n✅ Migration complete!');
}

migrate().catch(e => { console.error('Migration failed:', e); process.exit(1); });
