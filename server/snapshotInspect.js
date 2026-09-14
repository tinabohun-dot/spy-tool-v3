// Общая утилита: открывает публичную страницу-снепшот объявления (ad_snapshot_url)
// в headless-браузере и вытаскивает превью-картинку/видео + формат. Мета больше
// не рендерит эту страницу на сервере (og:image в HTML нет) — креатив подгружается
// уже в браузере через JS, поэтому без реального рендеринга превью не получить.
const puppeteer = require('puppeteer');

let browserPromise = null;
let relaunchPromise = null;
function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    // --disable-dev-shm-usage: в Docker /dev/shm по умолчанию урезан до
    // 64 МБ — рендер-процессу Chrome этого не хватает на тяжёлых страницах,
    // и он падает посреди работы (видно как "Navigating frame was detached").
    // Без этого флага Chrome пишет туда, с ним — на обычный диск во
    // временную папку, что чуть медленнее, зато не падает.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
}
async function getBrowser() {
  if (!browserPromise) browserPromise = launchBrowser();
  const browser = await browserPromise;
  // Переиспользуем один и тот же процесс браузера для всех вкладок. Если он
  // реально упал (а не просто одна вкладка не догрузилась), перезапускаем —
  // но только один раз, даже если это заметили сразу несколько параллельных
  // вызовов, иначе каждый из них плодит свой процесс Chromium и старый никто
  // не закрывает (утечка процессов при параллельной обработке).
  if (!browser.connected) {
    if (!relaunchPromise) {
      relaunchPromise = (async () => {
        await browser.close().catch(() => {});
        const fresh = await launchBrowser();
        relaunchPromise = null;
        return fresh;
      })();
      browserPromise = relaunchPromise;
    }
    return relaunchPromise;
  }
  return browser;
}

// Ограничиваем число одновременно открытых вкладок, иначе при параллельном
// разборе десятков объявлений на сервере улетит память/CPU. На бесплатном
// Render (один слабый общий CPU, ~512 МБ RAM) даже 3 одновременные вкладки с
// тяжёлыми страницами Facebook приводили к "Navigation timeout" и падениям
// вкладок ("Navigating frame was detached") — временно снижаем до 1, чтобы
// сначала добиться стабильности, а не скорости. Можно будет аккуратно
// повышать обратно, когда станет ясно, что именно упирается в лимит.
const MAX_CONCURRENT = 1;
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
    // Шрифты не нужны для извлечения превью, а Facebook тянет их пачками —
    // блокируем, чтобы не жечь и так дефицитный CPU/сеть на слабом хостинге.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.resourceType() === 'font') req.abort();
      else req.continue();
    });
    // networkidle2 ждал бы, пока затихнут вообще все фоновые запросы
    // (трекеры/пиксели у Facebook не прекращаются подолгу) — а нам нужно
    // только дождаться самого медиа, чем и так занимается опрос ниже.
    // domcontentloaded наступает намного раньше и этого достаточно, чтобы
    // JS-плеер начал инициализацию.
    await page.goto(snapshotUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // networkidle2 значит только "сеть затихла" — сам JS-плеер Facebook ещё
    // может дорисовывать <video> (с poster) в DOM пару секунд после этого,
    // особенно под нагрузкой на слабом CPU. Поэтому не проверяем DOM один
    // раз, а опрашиваем его до 8 секунд, пока не появится video или
    // достаточно крупная img — так мы не фиксируем "unknown" преждевременно.
    return await page.evaluate(async () => {
      function extract() {
        const video = document.querySelector('video');
        if (video) {
          const src = video.currentSrc || video.src || video.querySelector('source')?.src || null;
          if (video.poster || src) return { format: 'video', thumbnail: video.poster || src };
        }
        const imgs = Array.from(document.querySelectorAll('img'))
          .filter((img) => img.naturalWidth > 100 && img.naturalHeight > 100)
          .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
        if (imgs[0]) return { format: 'image', thumbnail: imgs[0].src };
        return null;
      }
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const result = extract();
        if (result) return result;
        await new Promise((r) => setTimeout(r, 300));
      }
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
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await attemptInspect(snapshotUrl);
        if (result.thumbnail || attempt === 1) return result;
      } catch (e) { lastError = e; /* пробуем ещё раз новой вкладкой */ }
    }
    // Раньше здесь молча возвращали unknown — с сервера было невозможно
    // понять, сбоит ли скрапер вообще или просто у объявления нет медиа.
    console.warn('[snapshot-inspect] Не удалось найти превью:', snapshotUrl, lastError ? `(${lastError.message})` : '(video/img не появились за отведённое время)');
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
