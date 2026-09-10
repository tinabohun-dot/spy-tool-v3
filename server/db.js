// Turso (libSQL) вместо локального better-sqlite3 — чтобы данные переживали
// деплой/сон на бесплатном хостинге (там нет постоянного диска). Локально,
// если TURSO_DATABASE_URL не задан, работаем с обычным файлом на диске через
// тот же клиент (embedded/file-режим libSQL) — для разработки это то же
// самое SQLite, без необходимости поднимать облачную базу.
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const client = createClient(
  process.env.TURSO_DATABASE_URL
    ? { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: 'file:' + path.join(DATA_DIR, 'spy.db') }
);

// Тонкая обёртка в духе better-sqlite3 (prepare(sql).get/all/run), но
// асинхронная — так вызывающий код меняется минимально (добавить await и
// async), без переписывания каждого запроса под другой API.
function prepare(sql) {
  async function execute(params) {
    const isNamed = params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0]);
    return client.execute({ sql, args: isNamed ? params[0] : params });
  }
  return {
    async get(...params) {
      const result = await execute(params);
      return result.rows[0];
    },
    async all(...params) {
      const result = await execute(params);
      return result.rows;
    },
    async run(...params) {
      const result = await execute(params);
      return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
    }
  };
}

async function exec(sql) {
  const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
  for (const statement of statements) await client.execute(statement);
}

async function migrate() {
  await exec(`
    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ad_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
      platform TEXT NOT NULL DEFAULT 'meta',
      page_id TEXT NOT NULL,
      page_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(platform, page_id)
    );

    CREATE TABLE IF NOT EXISTS ad_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ad_page_id INTEGER NOT NULL REFERENCES ad_pages(id) ON DELETE CASCADE,
      ad_id TEXT NOT NULL,
      creative_body TEXT,
      creative_title TEXT,
      snapshot_url TEXT,
      thumbnail_url TEXT,
      format TEXT,
      delivery_start TEXT,
      delivery_stop TEXT,
      languages TEXT,
      platforms TEXT,
      is_active INTEGER NOT NULL,
      eu_total_reach INTEGER,
      duplicate_group TEXT,
      fetch_date TEXT NOT NULL,
      UNIQUE(ad_page_id, ad_id, fetch_date)
    );

    CREATE TABLE IF NOT EXISTS rank_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ad_page_id INTEGER NOT NULL REFERENCES ad_pages(id) ON DELETE CASCADE,
      ad_id TEXT NOT NULL,
      fetch_date TEXT NOT NULL,
      rank INTEGER NOT NULL,
      UNIQUE(ad_page_id, ad_id, fetch_date)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_page_date ON ad_snapshots(ad_page_id, fetch_date);
    CREATE INDEX IF NOT EXISTS idx_rank_page_ad ON rank_history(ad_page_id, ad_id);

    CREATE TABLE IF NOT EXISTS notified_top_creatives (
      creative_key TEXT PRIMARY KEY,
      grade TEXT NOT NULL,
      notified_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Разбивка eu_total_reach по стране/возрасту/полу и подпись ссылки —
  // добавлены позже, поэтому для существующих баз это миграция.
  try { await client.execute('ALTER TABLE ad_snapshots ADD COLUMN reach_breakdown TEXT'); } catch { /* колонка уже есть */ }
  try { await client.execute('ALTER TABLE ad_snapshots ADD COLUMN link_caption TEXT'); } catch { /* колонка уже есть */ }
}

const ready = migrate();

module.exports = { prepare, exec, ready };
