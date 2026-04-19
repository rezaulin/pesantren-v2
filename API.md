# FAONSI API Reference

Backend: Node.js + Express + SQLite (server.js)

## Auth
- POST /api/login {username, password} → {token}
- GET /api/me → {id, nama, role, ...}

## Dashboard
- GET /api/dashboard → {total_santri, hadir_hari_ini, izin_sakit, alfa, alfa_list, ...}

## Users (admin only)
- GET/POST /api/users
- PUT/DELETE /api/users/:id

## Santri
- GET/POST /api/santri
- PUT/DELETE /api/santri/:id
  Fields: nama, kamar_id, kelas_diniyyah, kelompok_ngaji, kelompok_ngaji_malam, kelas_sekolah, jenis_bakat, status, extra

## Kamar
- GET/POST /api/kamar
- PUT/DELETE /api/kamar/:id

## Kegiatan
- GET/POST /api/kegiatan
- PUT/DELETE /api/kegiatan/:id

## Absensi
- GET /api/absensi?tanggal=&kegiatan_id= → [{santri_id, status, ...}]
- POST /api/absensi/bulk {tanggal, kegiatan_id, data:[{santri_id, status}]}

## Absen Malam
- GET /api/absen-malam?tanggal=&kamar_id=&kelompok=
- POST /api/absen-malam/bulk

## Absen Sekolah
- GET /api/absen-sekolah?tanggal=&kelas=
- POST /api/absen-sekolah/bulk

## Rekap
- GET /api/rekap?dari=&sampai=&kegiatan_id=&kamar_id= → [{tanggal, nama, status, ...}]

## Pengumuman
- GET/POST /api/pengumuman
- DELETE /api/pengumuman/:id

## Pelanggaran
- GET/POST /api/pelanggaran
- PUT/DELETE /api/pelanggaran/:id

## Catatan Guru
- GET/POST /api/catatan
- PUT/DELETE /api/catatan/:id

## Raport
- GET /api/raport/:santri_id → {santri, rekap}
- GET /api/raport/:santri_id/pdf → PDF file
- GET /api/raport/download-all?dari=&sampai= → ZIP

## Settings
- GET /api/settings
- PUT /api/settings {app_name, kepala_nama, alamat_lembaga, nama_kota}
- POST /api/settings/logo-file (multipart)
- POST /api/settings/bg-file (multipart)
- POST /api/settings/dash-bg-file (multipart)
- POST /api/settings/delete {field}

## Wali
- GET /api/wali/anak → [{id, nama, ...}]
- GET /api/wali/rekap?anak_id=&dari=&sampai=

## Roles
- admin: full access
- ustadz: absensi, santri (read), rekap, pengumuman, raport
- wali: dashboard (anak), rekap anak, catatan guru, pengumuman
