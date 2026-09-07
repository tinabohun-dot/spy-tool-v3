// Общая утилита: открывает публичную страницу-снепшот объявления (ad_snapshot_url)
// в headless-браузере и вытаскивает превью-картинку/видео + формат. Мета больше
// не рендерит эту страницу на сервере (og:image в HTML нет) — креатив подгружается
// уже в браузере через JS, поэтому без реального рендеринга превью не получить.
const puppeteer = require('puppeteer');

let browserPromise = null;
function launchBrowser() {
  return puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
}
async function getBrowser() {
  if (!browserPromise) browserPromise = launchBrowser();
  const browser = await browserPromise;
  // Переиспользуем один и тот же процесс браузера для всех вкладок. Если он
  // реально упал (а не просто одна вкладка не догрузилась), перезапускаем.
  if (!browser.connected) browserPromise = launchBrowser();
  return browserPromise;
}

// Ограничиваем число одновременно открытых вкладок, иначе при параллельном
// разборе десятков объявлений на сервере улетит память/CPU.
const MAX_CONCURRENT = 8;
let active = 0;
const queue = [];
function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      active++;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally { active--; if (queue.length) queue.shift()(); }
    };
    if (active < MAX_CONCURRENT) run(); else queue.push(run);
  });
}

async function attemptInspect(snapshotUrl) {
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(snapshotUrl, { waitUntil: 'networkidle2', timeout: 20000 });

    return await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) {
        const src = video.currentSrc || video.src || video.querySelector('source')?.src || null;
        return { format: 'video', thumbnail: video.poster || src };
      }
      const imgs = Array.from(document.querySelectorAll('img'))
        .filter((img) => img.naturalWidth > 100 && img.naturalHeight > 100)
        .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
      if (imgs[0]) return { format: 'image', thumbnail: imgs[0].src };
      return { format: 'unknown', thumbnail: null };
    });
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// Отдельная вкладка иногда не успевает догрузиться (медленная сеть, тяжёлое
// видео) — это нормально при большом объёме и не значит, что упал сам браузер,
// поэтому просто пробуем ещё раз новой вкладкой на том же браузере (без его
// пересоздания — так мы больше не плодим лишние процессы Chromium).
async function inspectSnapshot(snapshotUrl) {
  if (!snapshotUrl) return { format: 'unknown', thumbnail: null };
  return withSlot(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await attemptInspect(snapshotUrl);
        if (result.thumbnail || attempt === 1) return result;
      } catch { /* пробуем ещё раз новой вкладкой */ }
    }
    return { format: 'unknown', thumbnail: null };
  });
}

async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

module.exports = { inspectSnapshot, closeBrowser };
