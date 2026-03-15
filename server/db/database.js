'use strict';
const Database = require('better-sqlite3');
const path = require('path');

// On Railway, mount a volume at /data and set DATA_DIR=/data to persist the DB.
// Falls back to the server root for local development.
const DB_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const DB_PATH = path.join(DB_DIR, 'ghostcoach.sqlite');

console.log(`[db] Database path: ${DB_PATH}`);
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create base schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    stripe_customer_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS licenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key TEXT UNIQUE NOT NULL,
    plan TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at TEXT,
    stripe_session_id TEXT,
    stripe_subscription_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Migrate: add new columns if they don't exist yet (safe on existing DBs)
const migrations = [
  'ALTER TABLE licenses ADD COLUMN device_id TEXT',
  'ALTER TABLE licenses ADD COLUMN device_name TEXT',
  'ALTER TABLE licenses ADD COLUMN activated_at TEXT',
  'ALTER TABLE licenses ADD COLUMN deactivation_count INTEGER DEFAULT 0',
  'ALTER TABLE licenses ADD COLUMN last_deactivation_date TEXT',
  'ALTER TABLE licenses ADD COLUMN coaching_calls_today INTEGER DEFAULT 0',
  'ALTER TABLE licenses ADD COLUMN coaching_calls_date TEXT',
];

for (const sql of migrations) {
  try {
    db.exec(sql);
  } catch (_) {
    // Column already exists — safe to ignore
  }
}

module.exports = db;
