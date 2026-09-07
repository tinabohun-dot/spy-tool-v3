const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'saved.json');

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf-8');
}

function getAll() {
  ensureFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function save(ad) {
  ensureFile();
  const all = getAll();
  if (all.some((a) => a.id === ad.id)) {
    return all; // уже сохранено
  }
  const withMeta = { ...ad, savedAt: new Date().toISOString() };
  const next = [withMeta, ...all];
  fs.writeFileSync(DATA_FILE, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

function remove(id) {
  ensureFile();
  const all = getAll();
  const next = all.filter((a) => a.id !== id);
  fs.writeFileSync(DATA_FILE, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

module.exports = { getAll, save, remove };
