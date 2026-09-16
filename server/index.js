require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');

const { closeBrowser } = require('./snapshotInspect');
const db = require('./db');
const { fetchSnapshotForAdPage, todayStr, hashText } = require('./fetchService');
const analytics = require('./analytics');
const jobStatus = require('./jobStatus');
const metaMarketing = require('./metaMarketing');
const airtable = require('./airtable');
const { checkNewTopCreatives, warsawDateString } = require('./slackAlerts');
const googleDrive = require('./googleDrive');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Бесплатный Render засыпает без входящих запросов, поэтому cron.schedule на
// фиксированное время мог просто не наступить, пока процесс спал — и
// уведомление в Slack не уходило вовсе (see: тишина в #top_creo). Вместо
// расписания — триггерим проверку первым же запросом после 10:00 по Варшаве,
// не чаще раза в день. Дата последнего запуска лежит в app_meta, чтобы
// пережить рестарт/сон, а topCreoCheckRunning защищает от дублей, пока
// сама проверка (обращения к Meta API) ещё выполняется. Важно: эта middleware
// стоит ДО express.static — иначе для отданных статикой запросов (например,
// самой главной страницы) next() не вызывался бы и проверка не запускалась.
const TOP_CREO_CHECK_HOUR = 10; // по Варшаве — как раньше было в cron.schedule
let topCreoCheckRunning = false;

async function maybeRunMorningTopCreoCheck() {
  if (topCreoCheckRunning) return;
  // Всё тело — в одном try/catch: необработанный reject в async-функции,
  // вызванной без await/.catch() (как ниже, в middleware), убивает весь
  // процесс Node (поведение по умолчанию с Node 15+) — а не просто эту
  // проверку. Один сетевой сбой при обращении к Turso на холодном старте
  // контейнера уронил бы сервер прямо на первом запросе (health-check
  // Render) и выглядел бы как зависший на ровном месте деплой.
  try {
    const warsawHour = +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hour: 'numeric', hourCycle: 'h23' }).format(new Date());
    if (warsawHour < TOP_CREO_CHECK_HOUR) return;

    const today = warsawDateString(0);
    // "Прочитать дату, потом записать" — не атомарно: два почти одновременных
    // запроса (например, браузер параллельно бьёт на несколько эндпоинтов при
    // загрузке страницы) оба могли проскочить SELECT ДО того, как первый из
    // них успевал записать "сегодня уже сделано" — отсюда дубли уведомлений
    // в Slack. UPDATE ... WHERE value != ? — атомарная операция на уровне
    // БД: из нескольких одновременных попыток "забрать" сегодняшний день
    // реально изменит строку только одна, остальные увидят changes = 0.
    await db.prepare(`
      INSERT INTO app_meta (key, value) VALUES ('last_top_creo_check_date', '')
      ON CONFLICT(key) DO NOTHING
    `).run();
    const claim = await db.prepare(`
      UPDATE app_meta SET value = ? WHERE key = 'last_top_creo_check_date' AND value != ?
    `).run(today, today);
    if (!claim.changes) return;

    topCreoCheckRunning = true;
    console.log('[top-creo] Утренняя проверка запущена первым визитом:', today);
    await checkNewTopCreatives();
  } catch (e) {
    console.error('[top-creo] Ошибка утренней проверки:', e.message);
  } finally {
    topCreoCheckRunning = false;
  }
}

app.use((req, res, next) => {
  next();
  maybeRunMorningTopCreoCheck().catch((e) => console.error('[top-creo] Необработанная ошибка:', e.message));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/scaling', async (req, res) => res.json(await analytics.scalingCreatives()));

app.get('/api/brands', async (req, res) => {
  const brands = await db.prepare('SELECT * FROM brands ORDER BY created_at DESC').all();
  const pages = await db.prepare('SELECT * FROM ad_pages').all();
  res.json(
    await Promise.all(brands.map(async (b) => ({
      ...b,
      pages: pages.filter((p) => p.brand_id === b.id),
      stats: await analytics.libraryStats(b.id)
    })))
  );
});

app.post('/api/brands', async (req, res) => {
  const { name, category } = req.body;
  if (!name) return res.status(400).json({ error: 'Нужно имя бренда' });
  const info = await db.prepare('INSERT INTO brands (name, category) VALUES (?, ?)').run(name, category || null);
  res.json(await db.prepare('SELECT * FROM brands WHERE id = ?').get(info.lastInsertRowid));
});

app.delete('/api/brands/:id', async (req, res) => {
  await db.prepare('DELETE FROM brands WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

function extractPageId(input) {
  const m = String(input).match(/view_all_page_id=(\d+)/);
  if (m) return m[1];
  const digits = String(input).match(/^\d+$/);
  return digits ? digits[0] : null;
}

app.post('/api/brands/:brandId/pages', async (req, res) => {
  try {
    const { platform = 'meta', input, page_name } = req.body;
    if (platform !== 'meta') return res.status(400).json({ error: 'Пока поддержан только platform=meta' });
    const pageId = extractPageId(input);
    if (!pageId) return res.status(400).json({ error: 'Не удалось распознать page_id из введённой строки' });

    await db.prepare('INSERT OR IGNORE INTO ad_pages (brand_id, platform, page_id, page_name) VALUES (?,?,?,?)')
      .run(req.params.brandId, platform, pageId, page_name || null);
    const adPage = await db.prepare('SELECT * FROM ad_pages WHERE platform = ? AND page_id = ?').get(platform, pageId);
    fetchSnapshotForAdPage(adPage).catch((e) => console.error('Первичный сбор снепшота не удался:', e.message));
    res.json(adPage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ON DELETE CASCADE в схеме не срабатывает — SQLite/Turso не проверяют внешние
// ключи, пока не включишь PRAGMA foreign_keys, а мы её нигде не включаем.
// Поэтому чистим зависимые таблицы явно, а не полагаемся на каскад.
app.delete('/api/pages/:id', async (req, res) => {
  await db.prepare('DELETE FROM rank_history WHERE ad_page_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM ad_snapshots WHERE ad_page_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM ad_pages WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/brands/:brandId/refresh', async (req, res) => {
  const days = +req.query.days || 7;
  const pages = await db.prepare('SELECT * FROM ad_pages WHERE brand_id = ?').all(req.params.brandId);
  const results = [];
  for (const p of pages) {
    try {
      results.push({ page_id: p.page_id, page_name: p.page_name, ...(await fetchSnapshotForAdPage(p, days)) });
    } catch (err) {
      console.error(`Сбор снепшота не удался для page_id=${p.page_id} (${p.page_name}):`, err.message);
      results.push({ page_id: p.page_id, page_name: p.page_name, error: err.message });
    }
  }
  res.json({ results });
});

app.get('/api/brands/:brandId/metrics', async (req, res) => res.json(await analytics.metrics(req.params.brandId, +req.query.days || 7)));
app.get('/api/brands/:brandId/eu-reach', async (req, res) => res.json(await analytics.euReach(req.params.brandId)));
app.get('/api/brands/:brandId/trending', async (req, res) => res.json(await analytics.trending(req.params.brandId)));
app.get('/api/brands/:brandId/winning', async (req, res) => res.json(await analytics.winningAds(req.params.brandId)));
app.get('/api/brands/:brandId/creative-tests', async (req, res) => res.json(await analytics.creativeTests(req.params.brandId)));
app.get('/api/brands/:brandId/ads', async (req, res) => res.json(await analytics.creativesGrid(req.params.brandId)));

// Статус сбора снепшотов по каждой Ad Page: идёт ли сейчас сбор, сколько уже
// обработано, и чем закончился последний запуск — иначе непонятно, "просто
// нет данных" это или "ещё собирается".
app.get('/api/jobs', async (req, res) => {
  const pages = await db.prepare(`
    SELECT ad_pages.id, ad_pages.page_name, ad_pages.page_id, ad_pages.brand_id, brands.name as brand_name
    FROM ad_pages JOIN brands ON brands.id = ad_pages.brand_id
  `).all();
  const snapshotCounts = await db.prepare(`
    SELECT ad_page_id, COUNT(DISTINCT ad_id) as existingCount, MAX(fetch_date) as lastFetchDate
    FROM ad_snapshots GROUP BY ad_page_id
  `).all();
  const dataByPageId = Object.fromEntries(snapshotCounts.map((r) => [r.ad_page_id, r]));
  const jobsByPageId = Object.fromEntries(jobStatus.listJobs().map((j) => [j.pageId, j]));
  res.json(pages.map((p) => ({
    pageId: p.id,
    pageName: p.page_name || p.page_id,
    brandId: p.brand_id,
    brandName: p.brand_name,
    existingCount: dataByPageId[p.id]?.existingCount || 0,
    lastFetchDate: dataByPageId[p.id]?.lastFetchDate || null,
    ...(jobsByPageId[p.id] || { status: 'idle', startedAt: null, finishedAt: null, total: null, processed: 0, error: null })
  })));
});

// Аналитика по собственным рекламным кабинетам (Marketing API): расход,
// покупки, CPA, грейд — за выбранный период, с объединением дублей одного
// креатива и разбивкой по аккаунтам.
app.get('/api/analytics', async (req, res) => {
  try {
    const { since, until } = req.query;
    if (!since || !until) return res.status(400).json({ error: 'Нужны параметры since и until (YYYY-MM-DD)' });

    const accNames = Object.keys(metaMarketing.accounts());
    if (!accNames.length) return res.status(400).json({ error: 'META_MARKETING_ACCOUNTS не задан в server/.env' });

    const allRows = await metaMarketing.fetchAllAccountsInsights(since, until);

    const overallCreatives = await metaMarketing.attachPreviews(
      metaMarketing.groupRowsByCreative(allRows).map(metaMarketing.buildCreativeEntry)
    );

    const byAccount = {};
    for (const accName of accNames) {
      const rows = allRows.filter((r) => r._accountName === accName);
      const creatives = await metaMarketing.attachPreviews(
        metaMarketing.groupRowsByCreative(rows).map(metaMarketing.buildCreativeEntry)
      );
      byAccount[accName] = { summary: metaMarketing.summarize(creatives), creatives };
    }

    // Воронка уже определена в buildCreativeEntry по названию кампании
    // (getFunnelFromCampaign) — так же, как в личном скрипте пользователя.

    res.json({
      accounts: accNames,
      overall: { summary: metaMarketing.summarize(overallCreatives), creatives: overallCreatives },
      byAccount
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Креативный продакшн (Airtable): сколько задач дошло до "To Test" за период,
// разбивка видео/статика и по дизайнерам.
app.get('/api/analytics/production', async (req, res) => {
  try {
    const { since, until } = req.query;
    if (!since || !until) return res.status(400).json({ error: 'Нужны параметры since и until' });
    const launchedTaskNumbers = await metaMarketing.fetchLaunchedTaskNumbers().catch(() => null);
    res.json(await airtable.productionReport(since, until, launchedTaskNumbers));
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// CP (Airtable): сколько задач перевели в "To Do" по дням, видео/статика,
// разбивка по тому, какой CP поставил задачу.
app.get('/api/analytics/cp', async (req, res) => {
  try {
    const { since, until } = req.query;
    if (!since || !until) return res.status(400).json({ error: 'Нужны параметры since и until' });
    res.json(await airtable.cpReport(since, until));
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// UA (Airtable): сколько задач запустили (перевели в "Sent UA") по дням.
// Данные копятся только с момента подключения automation.
app.get('/api/analytics/ua', async (req, res) => {
  try {
    const { since, until } = req.query;
    if (!since || !until) return res.status(400).json({ error: 'Нужны параметры since и until' });
    res.json(await airtable.uaReport(since, until));
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Formats: формат/воронка (по своим креативам, без превью — быстрее) + платформы.
app.get('/api/analytics/formats', async (req, res) => {
  try {
    const { since, until } = req.query;
    if (!since || !until) return res.status(400).json({ error: 'Нужны параметры since и until' });

    const allRows = await metaMarketing.fetchAllAccountsInsights(since, until);
    const creatives = metaMarketing.groupRowsByCreative(allRows).map(metaMarketing.buildCreativeEntry);

    const format = { Video: 0, Static: 0 };
    const funnel = {};
    for (const c of creatives) {
      format[c.type] = (format[c.type] || 0) + 1;
      const f = c.funnel || '—';
      funnel[f] = (funnel[f] || 0) + 1;
    }
    const platform = await metaMarketing.fetchPlatformBreakdown(since, until);

    res.json({ total: creatives.length, format, funnel, platform });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Users: демография по своим кабинетам (не только EU, как в Ad Library).
app.get('/api/analytics/users', async (req, res) => {
  try {
    const { since, until } = req.query;
    if (!since || !until) return res.status(400).json({ error: 'Нужны параметры since и until' });
    res.json(await metaMarketing.fetchDemographics(since, until));
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Аудитория: те же метрики по креативам, что и в "Все креативы", но с
// возможностью выбрать срез по гендеру/возрасту/гео. Meta не разрешает
// запросить все три разбивки сразу (см. комментарий у
// fetchAllAccountsInsightsBreakdown), поэтому берём их двумя отдельными
// запросами — возраст+гендер вместе, гео отдельно — и применяем к
// нужному датасету только тот фильтр, который реально выбран.
app.get('/api/analytics/audience', async (req, res) => {
  try {
    const { since, until, gender, age, country } = req.query;
    if (!since || !until) return res.status(400).json({ error: 'Нужны параметры since и until' });

    const accNames = Object.keys(metaMarketing.accounts());
    if (!accNames.length) return res.status(400).json({ error: 'META_MARKETING_ACCOUNTS не задан в server/.env' });

    const [ageGenderRows, countryRows] = await Promise.all([
      metaMarketing.fetchAllAccountsInsightsBreakdown(since, until, ['age', 'gender']),
      metaMarketing.fetchAllAccountsInsightsBreakdown(since, until, ['country'])
    ]);

    // Сводки по каждому измерению всегда считаем по полным, нефильтрованным
    // данным — это то, что рисуется в столбиках сверху, чтобы по ним и
    // выбирать срез, а не только смотреть на уже применённый фильтр.
    function summaryByDimension(rows, dimension) {
      const out = {};
      for (const row of rows) {
        const key = row[dimension] || 'unknown';
        const entry = metaMarketing.buildCreativeEntry(row);
        if (!out[key]) out[key] = { spend: 0, purchases: 0 };
        out[key].spend += entry.spend;
        out[key].purchases += entry.purchases;
      }
      return out;
    }
    const genderSummary = summaryByDimension(ageGenderRows, 'gender');
    const ageSummary = summaryByDimension(ageGenderRows, 'age');
    const countrySummary = summaryByDimension(countryRows, 'country');

    // Гео — из отдельного датасета (комбинировать с возрастом/гендером Meta
    // не даёт), возраст/гендер — из своего, можно фильтровать по одному или
    // сразу по обоим одновременно, раз они и так лежат в одной выдаче.
    const sourceRows = country
      ? countryRows.filter((r) => r.country === country)
      : ageGenderRows.filter((r) => (!gender || r.gender === gender) && (!age || r.age === age));

    const creatives = await metaMarketing.attachPreviews(
      metaMarketing.groupRowsByCreative(sourceRows).map(metaMarketing.buildCreativeEntry)
    );

    res.json({
      accounts: accNames,
      genderSummary, ageSummary, countrySummary,
      summary: metaMarketing.summarize(creatives),
      creatives
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Запустить сбор снепшота для одной конкретной Ad Page (не всего бренда) —
// пригодится, когда во вкладке "Сбор данных" видно, что по странице нет
// данных или сбор давно не запускался.
app.post('/api/pages/:pageId/refresh', async (req, res) => {
  const page = await db.prepare('SELECT * FROM ad_pages WHERE id = ?').get(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Ad Page не найдена' });
  const days = +req.query.days || 7;
  fetchSnapshotForAdPage(page, days).catch((e) => console.error(`Сбор не удался для page_id=${page.page_id}:`, e.message));
  res.json({ ok: true });
});

// Разовый ручной импорт объявлений в обход обычного сбора — на случай, когда
// официальный Meta Ad Library API не отдаёт активные объявления по странице
// (бывает у отдельных крупных рекламодателей — отставание индексации на
// стороне Meta), а сам сайт facebook.com/ads/library их видит. Данные сюда
// приходят вручную (например, вытащены из открытой страницы), поэтому не
// обновляются сами по себе — это не замена обычному автоматическому сбору.
app.post('/api/pages/:pageId/manual-import', async (req, res) => {
  const page = await db.prepare('SELECT * FROM ad_pages WHERE id = ?').get(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Ad Page не найдена' });
  const { ads } = req.body;
  if (!Array.isArray(ads) || !ads.length) return res.status(400).json({ error: 'Нужен непустой массив ads' });

  const date = todayStr();
  const insertSnapshot = db.prepare(`
    INSERT INTO ad_snapshots (
      ad_page_id, ad_id, creative_body, creative_title, snapshot_url, thumbnail_url,
      format, delivery_start, delivery_stop, languages, platforms, is_active,
      eu_total_reach, reach_breakdown, link_caption, duplicate_group, fetch_date
    ) VALUES (@ad_page_id, @ad_id, @creative_body, @creative_title, @snapshot_url, @thumbnail_url,
      @format, @delivery_start, @delivery_stop, @languages, @platforms, @is_active,
      @eu_total_reach, @reach_breakdown, @link_caption, @duplicate_group, @fetch_date)
    ON CONFLICT(ad_page_id, ad_id, fetch_date) DO UPDATE SET
      is_active=excluded.is_active, delivery_stop=excluded.delivery_stop, eu_total_reach=excluded.eu_total_reach,
      reach_breakdown=excluded.reach_breakdown, thumbnail_url=excluded.thumbnail_url, format=excluded.format,
      link_caption=excluded.link_caption
  `);
  let imported = 0;
  for (const ad of ads) {
    if (!ad.ad_id) continue;
    await insertSnapshot.run({
      ad_page_id: page.id, ad_id: String(ad.ad_id),
      creative_body: ad.creative_body || '', creative_title: ad.creative_title || null,
      snapshot_url: ad.snapshot_url || `https://www.facebook.com/ads/library/?id=${ad.ad_id}`,
      thumbnail_url: ad.thumbnail_url || null, format: ad.format || 'unknown',
      delivery_start: ad.delivery_start || null, delivery_stop: ad.delivery_stop || null,
      languages: null, platforms: null,
      is_active: ad.is_active === false ? 0 : 1,
      eu_total_reach: ad.eu_total_reach ?? null, reach_breakdown: null,
      link_caption: ad.link_caption || null,
      duplicate_group: hashText(ad.creative_body || ''), fetch_date: date
    });
    imported++;
  }
  res.json({ ok: true, imported });
});

const schedule = process.env.CRON_SCHEDULE || '0 3 * * *';
cron.schedule(schedule, async () => {
  console.log('[cron] Старт ежедневного сбора снепшотов:', new Date().toISOString());
  const pages = await db.prepare('SELECT * FROM ad_pages').all();
  for (const p of pages) {
    try { await fetchSnapshotForAdPage(p); } catch (e) { console.error(`[cron] Ошибка для page_id=${p.page_id}:`, e.message); }
  }
  console.log('[cron] Готово');
});

// Разовая авторизация для поиска видео в Google Drive по имени креатива
// (используется в Slack-уведомлениях) — открой /oauth2/start в браузере,
// разреши доступ, и полученный refresh_token сохрани в server/.env как
// GOOGLE_REFRESH_TOKEN.
app.get('/oauth2/start', (req, res) => {
  try { res.redirect(googleDrive.getAuthUrl()); } catch (e) { res.status(500).send(e.message); }
});

app.get('/oauth2/callback', async (req, res) => {
  if (req.query.error) return res.status(400).send('Google вернул ошибку: ' + req.query.error);
  try {
    const tokens = await googleDrive.exchangeCodeForTokens(req.query.code);
    console.log('GOOGLE_REFRESH_TOKEN:', tokens.refresh_token);
    res.send('Готово! Refresh token выведен в консоль сервера (в терминале) — добавь его в server/.env как GOOGLE_REFRESH_TOKEN и перезапусти сервер.');
  } catch (e) {
    res.status(500).send('Ошибка: ' + e.message);
  }
});

db.ready.then(() => {
  app.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
    if (!process.env.META_ACCESS_TOKEN) console.warn('⚠️  META_ACCESS_TOKEN не найден в .env — запросы к Meta API будут падать с ошибкой.');
  });
}).catch((err) => {
  console.error('Не удалось применить миграции БД:', err);
  process.exit(1);
});

// Без этого при штатной остановке (Ctrl+C / kill) процесс headless-браузера
// остаётся висеть в фоне осиротевшим.
async function shutdown() {
  await closeBrowser().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
