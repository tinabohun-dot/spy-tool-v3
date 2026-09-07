// Собирает статическую демо-версию (докс для GitHub Pages) из уже собранных
// данных живого сервера на localhost:3000: снимает JSON по каждому эндпоинту,
// скачивает превью локально и вычищает META_ACCESS_TOKEN из ссылок на снепшоты
// (иначе он утечёт всем, кто откроет демо).
const fs = require('fs');
const path = require('path');

const API_BASE = 'http://localhost:3000';
const OUT_DIR = path.join(__dirname, '..', 'docs');
// Демо — витрина, а не полный дамп: тянем превью только для разумного числа
// креативов на бренд, иначе на брендах в тысячи объявлений репозиторий
// раздувается на гигабайты. Общая статистика (metrics/eu-reach) при этом
// остаётся полной — режется только сама галерея карточек.
const MAX_ADS_PER_BRAND = 150;

function stripToken(snapshotUrl, adId) {
  return `https://www.facebook.com/ads/library/?id=${encodeURIComponent(adId)}`;
}

async function getJson(p) {
  const r = await fetch(API_BASE + p);
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
}

async function downloadImage(url, destDir, baseName) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    const ext = ct.includes('video') || ct.includes('mp4') ? 'jpg' // poster всегда картинка
      : ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : 'jpg';
    const fileName = `${baseName}.${ext}`;
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, fileName), buf);
    return fileName;
  } catch {
    return null;
  }
}

function writeJson(relPath, data) {
  const full = path.join(OUT_DIR, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(data));
}

const DOWNLOAD_CONCURRENCY = 16;
async function mapConcurrent(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function scrubAdsList(rows, thumbsDir, thumbsRelPrefix) {
  return mapConcurrent(rows, DOWNLOAD_CONCURRENCY, async (ad) => {
    let thumb = ad.thumbnail_url;
    if (thumb) {
      const fileName = await downloadImage(thumb, thumbsDir, `${ad.ad_id || ad.id}`);
      thumb = fileName ? `${thumbsRelPrefix}/${fileName}` : null;
    }
    return {
      ...ad,
      thumbnail_url: thumb,
      snapshot_url: ad.ad_id ? stripToken(ad.snapshot_url, ad.ad_id) : ad.snapshot_url
    };
  });
}

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const brands = await getJson('/api/brands');
  writeJson('data/api/brands.json', brands);

  for (const b of brands) {
    console.log(`Бренд: ${b.name} (id=${b.id})`);
    const thumbsDir = path.join(OUT_DIR, 'data', 'thumbs', String(b.id));
    const thumbsRel = `data/thumbs/${b.id}`;

    const metrics = await getJson(`/api/brands/${b.id}/metrics`);
    writeJson(`data/api/brands/${b.id}/metrics.json`, metrics);

    const euReach = await getJson(`/api/brands/${b.id}/eu-reach`);
    writeJson(`data/api/brands/${b.id}/eu-reach.json`, euReach);

    const trending = await getJson(`/api/brands/${b.id}/trending`);
    writeJson(`data/api/brands/${b.id}/trending.json`, trending);

    const winning = (await getJson(`/api/brands/${b.id}/winning`)).slice(0, MAX_ADS_PER_BRAND);
    writeJson(`data/api/brands/${b.id}/winning.json`, await scrubAdsList(winning, thumbsDir, thumbsRel));

    const creativeTests = await getJson(`/api/brands/${b.id}/creative-tests`);
    writeJson(`data/api/brands/${b.id}/creative-tests.json`, creativeTests);

    const adsFull = await getJson(`/api/brands/${b.id}/ads`);
    const ads = adsFull.slice(0, MAX_ADS_PER_BRAND);
    console.log(`  Скачиваю превью: ${ads.length} из ${adsFull.length} объявлений...`);
    writeJson(`data/api/brands/${b.id}/ads.json`, await scrubAdsList(ads, thumbsDir, thumbsRel));
  }

  // Статические файлы фронтенда + демо-шим
  for (const f of ['index.html', 'app.js', 'styles.css']) {
    fs.copyFileSync(path.join(__dirname, '..', 'public', f), path.join(OUT_DIR, f));
  }
  fs.copyFileSync(path.join(__dirname, 'demo-shim.js'), path.join(OUT_DIR, 'demo-shim.js'));

  let html = fs.readFileSync(path.join(OUT_DIR, 'index.html'), 'utf8');
  html = html.replace('<script src="app.js"></script>', '<script src="demo-shim.js"></script>\n<script src="app.js"></script>');
  html = html.replace('<body>', `<body>
<div class="demo-banner">Демо-режим: статичные данные одного снепшота, изменения не сохраняются. <a href="https://github.com/tinabohun-dot/spy-tool-v3" target="_blank" rel="noopener">Исходный код</a></div>`);
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);

  console.log('Готово:', OUT_DIR);
}

main().catch((e) => { console.error(e); process.exit(1); });
