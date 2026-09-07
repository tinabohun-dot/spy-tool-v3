const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'spy.db'));
db.pragma('journal_mode = WAL');

db.exec(`
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
`);

// Разбивка eu_total_reach по стране/возрасту/полу (age_country_gender_reach_breakdown
// из Meta Ad Library API) — добавлена позже, поэтому для существующих баз это миграция.
try { db.exec('ALTER TABLE ad_snapshots ADD COLUMN reach_breakdown TEXT'); } catch { /* колонка уже есть */ }
try { db.exec('ALTER TABLE ad_snapshots ADD COLUMN link_caption TEXT'); } catch { /* колонка уже есть */ }

module.exports = db;
