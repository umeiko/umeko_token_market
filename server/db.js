import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const databasePath = resolve(process.env.DATA_PATH || 'data/market.db');
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    max_concurrency INTEGER NOT NULL DEFAULT 4,
    enabled INTEGER NOT NULL DEFAULT 1,
    healthy INTEGER NOT NULL DEFAULT 1,
    health_message TEXT NOT NULL DEFAULT '',
    last_seen_at TEXT,
    last_latency_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    input_price REAL NOT NULL DEFAULT 0,
    output_price REAL NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE(provider_id, name)
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    token_quota_5h INTEGER NOT NULL DEFAULT 2000000,
    token_quota_week INTEGER NOT NULL DEFAULT 20000000,
    quota_reset_5h_at TEXT,
    quota_reset_week_at TEXT,
    created_ip TEXT NOT NULL DEFAULT '',
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_created_ip ON users(created_ip, created_at);
  CREATE TABLE IF NOT EXISTS email_challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    ip TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    consumed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_challenges_email ON email_challenges(email, created_at);
  CREATE INDEX IF NOT EXISTS idx_challenges_ip ON email_challenges(ip, created_at);
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    token_quota INTEGER NOT NULL DEFAULT 0,
    budget_quota_micros INTEGER NOT NULL DEFAULT 0,
    rpm_limit INTEGER NOT NULL DEFAULT 60,
    concurrency_limit INTEGER NOT NULL DEFAULT 2,
    used_tokens INTEGER NOT NULL DEFAULT 0,
    used_cost_micros INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    key_id INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
    provider_id INTEGER REFERENCES providers(id) ON DELETE SET NULL,
    model TEXT NOT NULL DEFAULT '',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_micros INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_key ON usage_logs(key_id, created_at);
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT OR IGNORE INTO settings(key, value) VALUES
    ('site_name', 'Umeko Token Relay'),
    ('request_timeout_ms', '300000');
  UPDATE settings SET value = 'Umeko Token Relay' WHERE key = 'site_name' AND value = 'UMEKO Relay';
`);

const keyColumns = db.prepare('PRAGMA table_info(api_keys)').all();
if (!keyColumns.some((column) => column.name === 'user_id')) {
  db.exec('ALTER TABLE api_keys ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id, created_at)');

export function getUserUsage(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const usage = (window, resetAt) => db.prepare(`SELECT COALESCE(SUM(l.total_tokens), 0) used
    FROM usage_logs l JOIN api_keys k ON k.id = l.key_id
    WHERE k.user_id = ? AND l.created_at >= datetime('now', ?)
      AND (? IS NULL OR l.created_at > ?)`).get(userId, window, resetAt, resetAt).used;
  const fiveUsed = usage('-5 hours', user.quota_reset_5h_at);
  const weekUsed = usage('-7 days', user.quota_reset_week_at);
  return {
    five_hours: {
      used: fiveUsed, quota: user.token_quota_5h,
      remaining: user.token_quota_5h > 0 ? Math.max(0, user.token_quota_5h - fiveUsed) : null,
      reset_at: user.quota_reset_5h_at,
    },
    week: {
      used: weekUsed, quota: user.token_quota_week,
      remaining: user.token_quota_week > 0 ? Math.max(0, user.token_quota_week - weekUsed) : null,
      reset_at: user.quota_reset_week_at,
    },
  };
}

export function transaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function passwordRecord(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

export function ensureAdmin() {
  const existing = db.prepare('SELECT id FROM admin_users LIMIT 1').get();
  if (existing) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || randomBytes(12).toString('base64url');
  const { salt, hash } = passwordRecord(password);
  db.prepare('INSERT INTO admin_users(username, password_hash, salt) VALUES (?, ?, ?)').run(username, hash, salt);
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`\nInitial admin credentials:\n  username: ${username}\n  password: ${password}\n`);
  }
}

export function verifyAdmin(username, password) {
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!user) return null;
  const candidate = scryptSync(password, user.salt, 64);
  const expected = Buffer.from(user.password_hash, 'hex');
  if (!timingSafeEqual(candidate, expected)) return null;
  return { id: user.id, username: user.username };
}

export function changePassword(userId, password) {
  const { salt, hash } = passwordRecord(password);
  db.prepare('UPDATE admin_users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, userId);
}

export function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, row.value]));
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
