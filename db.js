/**
 * Database helper — MariaDB wrapper
 * Replaces in-memory JSON with SQL queries
 */
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: 'localhost',
  user: 'pesantren',
  password: 'pesantren2026',
  database: 'pesantren',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  dateStrings: true
});

// Helper: run query
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// Helper: run query return single row
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

// Helper: insert and return id
async function insert(table, data) {
  const keys = Object.keys(data);
  const vals = Object.values(data);
  const placeholders = keys.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
  const [result] = await pool.execute(sql, vals);
  return { id: result.insertId, ...data };
}

// Helper: update by id
async function update(table, id, data) {
  const keys = Object.keys(data);
  const vals = Object.values(data);
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  const sql = `UPDATE ${table} SET ${setClause} WHERE id = ?`;
  await pool.execute(sql, [...vals, id]);
}

// Helper: delete by id
async function remove(table, id) {
  await pool.execute(`DELETE FROM ${table} WHERE id = ?`, [id]);
}

// Helper: get now in WIB
function nowWIB() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).replace(' ', 'T').slice(0, 19);
}

// Helper: get today in WIB
function todayWIB() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
}

module.exports = { pool, query, queryOne, insert, update, remove, nowWIB, todayWIB };
