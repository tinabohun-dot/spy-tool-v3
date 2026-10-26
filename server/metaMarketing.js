// Meta Marketing API (не Ad Library) — перформанс собственных рекламных
// кабинетов: расход, покупки, CPA и т.д. Логика метрик, грейдинга и
// группировки дублей портирована из личного Google Apps Script
// пользователя (meta_kpi v12).
const API_VERSION = 'v19.0';

const CPA_THRESHOLD = 75;
const GRADE_THRESHOLDS = { ALPHA: 50, SCALE: 10, TEST: 5, PROMISING: 2 };
const SUCCESS_GRADES = ['Promising', 'Test', 'Scale', 'Alpha'];

const PURCHASE_TYPES_PRIORITY = [
  ['omni_purchase'],
  ['purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_conversion.purchase',
    'onsite_web_purchase', 'onsite_web_app_purchase', 'app_custom_event.fb_mobile_purchase',
    'offline_conversion.purchase']
];
const LEAD_TYPES_PRIORITY = [
  ['omni_lead'],
  ['lead', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead_grouped',
    'onsite_conversion.lead', 'app_custom_event.fb_mobile_complete_registration',
    'offline_conversion.lead']
];

function parseAccounts(envValue) {
  if (!envValue) return {};
  const out = {};
  for (const pair of envValue.split(',')) {
    const [name, id] = pair.split(':').map((s) => s.trim());
    if (name && id) out[name] = id;
  }
  return out;
}

function accounts() {
  return parseAccounts(process.env.META_MARKETING_ACCOUNTS);
}

function token() {
  const t = process.env.META_ACCESS_TOKEN;
  if (!t) { const err = new Error('META_ACCESS_TOKEN не задан. Добавь его в server/.env'); err.status = 500; throw err; }
  return t;
}

async function paginate(url) {
  const results = [];
  let nextUrl = url;
  while (nextUrl) {
    const resp = await fetch(nextUrl);
    const json = await resp.json();
    if (json.error) { const err = new Error('Meta API: ' + json.error.message); err.status = resp.status; throw err; }
    results.push(...(json.data || []));
    nextUrl = json.paging?.next || null;
  }
  return results;
}

async function fetchAccountInsights(accountId, since, until) {
  const fields = [
    'ad_id', 'ad_name', 'campaign_name',
    'impressions', 'reach', 'clicks', 'unique_clicks', 'spend',
    'actions', 'action_values',
    'video_play_actions', 'video_p25_watched_actions', 'video_p50_watched_actions',
    'video_p75_watched_actions', 'video_p100_watched_actions', 'video_avg_time_watched_actions'
  ].join(',');
  const url = new URL(`https://graph.facebook.com/${API_VERSION}/${accountId}/insights`);
  url.searchParams.set('fields', fields);
  url.searchParams.set('time_range', JSON.stringify({ since, until }));
  url.searchParams.set('action_attribution_windows', JSON.stringify(['7d_click']));
  url.searchParams.set('level', 'ad');
  url.searchParams.set('limit', '500');
  url.searchParams.set('access_token', token());
  return paginate(url.toString());
}

// Разбивка на уровне аккаунта (не по объявлениям) — для платформ/демографии
// не нужна детализация по каждому крео, только агрегат за период.
async function fetchAccountBreakdown(accountId, since, until, breakdowns) {
  const url = new URL(`https://graph.facebook.com/${API_VERSION}/${accountId}/insights`);
  url.searchParams.set('fields', 'impressions,reach,spend');
  url.searchParams.set('time_range', JSON.stringify({ since, until }));
  url.searchParams.set('level', 'account');
  if (breakdowns?.length) url.searchParams.set('breakdowns', breakdowns.join(','));
  url.searchParams.set('limit', '500');
  url.searchParams.set('access_token', token());
  return paginate(url.toString());
}

// Платформы (facebook/instagram/audience_network/...) по всем аккаунтам —
// сумма impressions за период.
async function fetchPlatformBreakdown(since, until) {
  const accs = accounts();
  const platform = {};
  for (const accId of Object.values(accs)) {
    const rows = await fetchAccountBreakdown(accId, since, until, ['publisher_platform']);
    for (const r of rows) {
      if (!r.publisher_platform) continue;
      platform[r.publisher_platform] = (platform[r.publisher_platform] || 0) + parseInt(r.impressions || 0, 10);
    }
  }
  return platform;
}

// Демография по всем аккаунтам, без ограничения по Европе (в отличие от
// EU Reach у Ad Library) — пол/возраст/страна + суммарный охват аккаунтов.
// Важно: reach по разбивкам не складывается в точный уникальный охват
// (один и тот же человек может попасть в несколько сегментов) — это тот же
// приближённый подход, что и в EU Reach.
async function fetchDemographics(since, until) {
  const accs = accounts();
  const gender = {};
  const age = {};
  const countries = {};
  let totalReach = 0;

  for (const accId of Object.values(accs)) {
    const totals = await fetchAccountBreakdown(accId, since, until, []);
    totalReach += totals.reduce((s, r) => s + (parseInt(r.reach || 0, 10)), 0);

    const ageGenderRows = await fetchAccountBreakdown(accId, since, until, ['age', 'gender']);
    for (const r of ageGenderRows) {
      const reach = parseInt(r.reach || 0, 10);
      if (r.gender && r.gender !== 'unknown') gender[r.gender] = (gender[r.gender] || 0) + reach;
      if (r.age) age[r.age] = (age[r.age] || 0) + reach;
    }

    const countryRows = await fetchAccountBreakdown(accId, since, until, ['country']);
    for (const r of countryRows) {
      if (!r.country) continue;
      countries[r.country] = (countries[r.country] || 0) + parseInt(r.reach || 0, 10);
    }
  }

  return { totalReach, gender, age, countries };
}

async function fetchAllAccountsInsights(since, until) {
  const accs = accounts();
  const rows = [];
  for (const [accName, accId] of Object.entries(accs)) {
    const accRows = await fetchAccountInsights(accId, since, until);
    for (const r of accRows) { r._accountName = accName; rows.push(r); }
  }
  return rows;
}

// Те же поля, что и fetchAccountInsights (level=ad, purchases/spend по
// объявлению), но с разбивкой по демографии — для вкладки "Аудитория".
// Важно: Meta не разрешает совмещать в одном запросе больше 2 не-временных
// разбивок сразу — age+gender вместе работают, country отдельно, а
// age+gender+country все вместе Meta прямо отклоняет ошибкой
// "Current combination of data breakdown columns ... is invalid" (проверено
// напрямую на реальном API). Поэтому вызывающий код всегда просит либо
// ['age','gender'], либо ['country'], никогда все три сразу.
async function fetchAccountInsightsBreakdown(accountId, since, until, breakdowns) {
  const fields = [
    'ad_id', 'ad_name', 'campaign_name',
    'impressions', 'reach', 'clicks', 'unique_clicks', 'spend',
    'actions', 'action_values',
    'video_play_actions', 'video_p25_watched_actions', 'video_p50_watched_actions',
    'video_p75_watched_actions', 'video_p100_watched_actions', 'video_avg_time_watched_actions'
  ].join(',');
  const url = new URL(`https://graph.facebook.com/${API_VERSION}/${accountId}/insights`);
  url.searchParams.set('fields', fields);
  url.searchParams.set('time_range', JSON.stringify({ since, until }));
  url.searchParams.set('action_attribution_windows', JSON.stringify(['7d_click']));
  url.searchParams.set('level', 'ad');
  url.searchParams.set('breakdowns', breakdowns.join(','));
  url.searchParams.set('limit', '500');
  url.searchParams.set('access_token', token());
  return paginate(url.toString());
}

// Аккаунты запрашиваем параллельно, а не по очереди — с разбивкой по
// демографии страниц у Meta заметно больше, чем без неё (age+gender/country
// умножают число строк), и на широких периодах (30 дней) последовательный
// обход 3+ аккаунтов ощутимо копится в секунды ожидания.
async function fetchAllAccountsInsightsBreakdown(since, until, breakdowns) {
  const accs = accounts();
  const perAccount = await Promise.all(
    Object.entries(accs).map(async ([accName, accId]) => {
      const accRows = await fetchAccountInsightsBreakdown(accId, since, until, breakdowns);
      for (const r of accRows) r._accountName = accName;
      return accRows;
    })
  );
  return perAccount.flat();
}

// Кривая удержания видео по секундам (video_play_curve_actions — та же, что
// на графике удержания в Ads Manager) + просмотры 15 сек. Отдельный запрос,
// чтобы возможная ошибка этого поля не ломала основные отчёты. Возвращает
// строки на объявление (при breakdown=country — на объявление x страну).
async function fetchVideoCurveRows(accountId, since, until, breakdowns) {
  const url = new URL(`https://graph.facebook.com/${API_VERSION}/${accountId}/insights`);
  url.searchParams.set('fields', 'ad_id,video_play_actions,video_play_curve_actions,video_15_sec_watched_actions');
  url.searchParams.set('time_range', JSON.stringify({ since, until }));
  url.searchParams.set('level', 'ad');
  if (breakdowns?.length) url.searchParams.set('breakdowns', breakdowns.join(','));
  url.searchParams.set('limit', '500');
  url.searchParams.set('access_token', token());
  return paginate(url.toString());
}

// ad_id -> { plays, curve: [% на каждом шаге], thru15 } (с учётом фильтра стран).
async function fetchVideoCurves(since, until, countries, countryMode) {
  const byCountry = countries && countries.length ? ['country'] : [];
  const perAccount = await Promise.all(
    Object.values(accounts()).map((accId) => fetchVideoCurveRows(accId, since, until, byCountry))
  );
  let rows = perAccount.flat();
  if (byCountry.length) rows = filterRowsByCountries(rows, countries, countryMode);
  const out = {};
  for (const r of rows) {
    const plays = getVideoMetric(r.video_play_actions);
    const raw = (r.video_play_curve_actions || [])[0]?.value;
    const curve = Array.isArray(raw) ? raw.map(Number) : null;
    const t = (out[r.ad_id] ||= { plays: 0, curveSum: null, thru15: 0 });
    t.plays += plays;
    t.thru15 += getVideoMetric(r.video_15_sec_watched_actions);
    if (curve) {
      t.curveSum ||= new Array(curve.length).fill(0);
      curve.forEach((v, i) => { t.curveSum[i] += (v || 0) * plays; });
    }
  }
  for (const t of Object.values(out)) {
    t.curve = t.curveSum && t.plays > 0 ? t.curveSum.map((v) => v / t.plays) : null;
    delete t.curveSum;
  }
  return out;
}

// Страны, по которым есть трата за период (для списка в фильтре), от
// большей траты к меньшей. Берём разбивку на уровне аккаунта — это дёшево.
async function fetchCountrySpend(since, until) {
  const perAccount = await Promise.all(
    Object.values(accounts()).map((accId) => fetchAccountBreakdown(accId, since, until, ['country']))
  );
  const out = {};
  for (const r of perAccount.flat()) {
    if (!r.country) continue;
    const c = (out[r.country] ||= { spend: 0, impressions: 0 });
    c.spend += parseFloat(r.spend || 0);
    c.impressions += parseInt(r.impressions || 0, 10);
  }
  return Object.entries(out).map(([code, v]) => ({ code, ...v })).sort((a, b) => b.spend - a.spend);
}

// Фильтр строк (ad x country) по списку стран: include — только они,
// exclude — все кроме них.
function filterRowsByCountries(rows, countries, mode) {
  const set = new Set(countries);
  return rows.filter((r) => (mode === 'exclude' ? !set.has(r.country) : set.has(r.country)));
}

// После фильтра по странам строки по одному объявлению надо снова свернуть в
// одну (суммируем spend/показы/клики/покупки и видео-метрики), чтобы дальше
// работала обычная группировка креативов. Охват (reach) по странам
// складывается приближённо — одна и та же оговорка, что и в EU Reach.
function collapseCountryRows(rows) {
  const byAd = new Map();
  for (const r of rows) {
    const t = byAd.get(r.ad_id);
    if (!t) {
      const copy = JSON.parse(JSON.stringify(r));
      delete copy.country;
      copy._prevPlays = getVideoMetric(r.video_play_actions);
      byAd.set(r.ad_id, copy);
      continue;
    }
    for (const f of ['impressions', 'reach', 'clicks', 'unique_clicks', 'spend']) {
      t[f] = String(parseFloat(t[f] || 0) + parseFloat(r[f] || 0));
    }
    t.actions = mergeActionArrays(t.actions, r.actions);
    t.action_values = mergeActionArrays(t.action_values, r.action_values);
    for (const f of VIDEO_FIELDS) t[f] = mergeVideoMetric(t[f], r[f]);
    t.video_avg_time_watched_actions = mergeAvgWatchTime(
      t.video_avg_time_watched_actions, t._prevPlays, r.video_avg_time_watched_actions, getVideoMetric(r.video_play_actions)
    );
    t._prevPlays = getVideoMetric(t.video_play_actions);
  }
  return [...byAd.values()];
}

// Список ad name по всем аккаунтам, без фильтра по дате — чтобы понять, какие
// Task ID из Airtable вообще когда-либо доходили до реального запуска в Meta
// (level=ad + /ads возвращает объявления в любом статусе за всё время, в
// отличие от /insights, которому обязательно нужен диапазон дат).
async function fetchAllAdNamesEver() {
  const accs = accounts();
  const names = [];
  for (const accId of Object.values(accs)) {
    const url = new URL(`https://graph.facebook.com/${API_VERSION}/${accId}/ads`);
    url.searchParams.set('fields', 'name');
    url.searchParams.set('limit', '500');
    url.searchParams.set('access_token', token());
    const ads = await paginate(url.toString());
    for (const ad of ads) if (ad.name) names.push(ad.name);
  }
  return names;
}

let launchedTaskNumbersCache = null; // { at, set }
const LAUNCHED_CACHE_TTL_MS = 5 * 60 * 1000;
async function fetchLaunchedTaskNumbers() {
  if (launchedTaskNumbersCache && Date.now() - launchedTaskNumbersCache.at < LAUNCHED_CACHE_TTL_MS) {
    return launchedTaskNumbersCache.set;
  }
  const names = await fetchAllAdNamesEver();
  const set = new Set();
  for (const name of names) {
    const m = name.match(/^(\d+)/);
    if (m) set.add(m[1]);
  }
  launchedTaskNumbersCache = { at: Date.now(), set };
  return set;
}

function getAction(actions, type) {
  if (!actions) return 0;
  const f = actions.find((a) => a.action_type === type);
  return f ? parseFloat(f.value) || 0 : 0;
}

function sumActionTypes(arr, types) {
  if (!arr) return 0;
  return arr.filter((a) => types.includes(a.action_type)).reduce((s, a) => s + (parseFloat(a.value) || 0), 0);
}

function getActionByPriority(arr, priorityGroups) {
  if (!arr) return 0;
  for (const group of priorityGroups) {
    const sum = sumActionTypes(arr, group);
    if (sum > 0) return sum;
  }
  return 0;
}

function getVideoMetric(arr) {
  if (!arr || !arr.length) return 0;
  return parseFloat(arr[0].value || 0);
}

// Ведущий номер + вариация из имени объявления — так объединяются копии
// одного и того же креатива (напр. "104_v2_...", "104_n1_...").
function getCreativeGroupKey(name) {
  if (!name) return null;
  const norm = String(name).trim();
  const numMatch = norm.match(/^(\d+)/);
  if (!numMatch) return null;
  const number = numMatch[1];
  const rest = norm.slice(number.length);

  let variation = 'base';
  const letterMatch = rest.match(/_(n|v)(\d{1,2})(?:_|$)/i);
  if (letterMatch) {
    variation = letterMatch[1].toLowerCase() + letterMatch[2];
  } else {
    const bareMatch = rest.match(/_(\d{1,2})(?:_|$)/);
    if (bareMatch && +bareMatch[1] >= 1 && +bareMatch[1] <= 10) variation = 'v' + bareMatch[1];
  }
  return number + '_' + variation;
}

function mergeActionArrays(a, b) {
  const map = {};
  for (const item of [...(a || []), ...(b || [])]) {
    map[item.action_type] = (parseFloat(map[item.action_type] || 0) + parseFloat(item.value || 0));
  }
  return Object.entries(map).map(([action_type, value]) => ({ action_type, value: String(value) }));
}

function mergeVideoMetric(a, b) {
  return [{ value: String(getVideoMetric(a) + getVideoMetric(b)) }];
}

function mergeAvgWatchTime(prevArr, prevPlays, newArr, newPlays) {
  const prevAvg = getVideoMetric(prevArr) || 0;
  const newAvg = getVideoMetric(newArr) || 0;
  const totalPlays = (prevPlays || 0) + (newPlays || 0);
  if (totalPlays === 0) return [{ value: '0' }];
  return [{ value: String(((prevAvg * (prevPlays || 0)) + (newAvg * (newPlays || 0))) / totalPlays) }];
}

const VIDEO_FIELDS = [
  'video_play_actions', 'video_p25_watched_actions', 'video_p50_watched_actions',
  'video_p75_watched_actions', 'video_p100_watched_actions'
];

function groupRowsByCreative(allRows) {
  const groups = {};
  const order = [];
  for (const row of allRows) {
    const groupKey = getCreativeGroupKey(row.ad_name);
    const key = groupKey !== null ? groupKey : '__noNum__' + row.ad_name;
    if (!groups[key]) {
      const copy = {
        ...row, _mergedCount: 1, _accountNames: [row._accountName], _campaignNames: [row.campaign_name],
        _prevPlays: getVideoMetric(row.video_play_actions), _adIds: [row.ad_id],
        _campaignSpend: { [row.campaign_name || '']: parseFloat(row.spend || 0) }
      };
      groups[key] = copy;
      order.push(key);
      continue;
    }
    const target = groups[key];
    target._mergedCount++;
    target._adIds.push(row.ad_id);
    if (!target._accountNames.includes(row._accountName)) target._accountNames.push(row._accountName);
    if (!target._campaignNames.includes(row.campaign_name)) target._campaignNames.push(row.campaign_name);
    const cKey = row.campaign_name || '';
    target._campaignSpend[cKey] = (target._campaignSpend[cKey] || 0) + parseFloat(row.spend || 0);
    if (row.ad_name.length < target.ad_name.length) target.ad_name = row.ad_name;
    for (const f of ['impressions', 'reach', 'clicks', 'unique_clicks', 'spend']) {
      target[f] = String((parseFloat(target[f] || 0) + parseFloat(row[f] || 0)));
    }
    target.actions = mergeActionArrays(target.actions, row.actions);
    target.action_values = mergeActionArrays(target.action_values, row.action_values);
    for (const f of VIDEO_FIELDS) target[f] = mergeVideoMetric(target[f], row[f]);
    const newPlays = getVideoMetric(row.video_play_actions);
    target.video_avg_time_watched_actions = mergeAvgWatchTime(
      target.video_avg_time_watched_actions, target._prevPlays, row.video_avg_time_watched_actions, newPlays
    );
    target._prevPlays = getVideoMetric(target.video_play_actions);
  }
  return order.map((k) => groups[k]);
}

// Воронка — по названию кампании: в нём всегда есть слаг вида
// "school-bullying-fl-v1", "brain-activation-fl-v2" и т.п. (слова через
// дефис + "-fl-v<номер>"). Раньше тут был фиксированный список известных
// воронок с фоллбэком на 'Test', из-за чего любая новая воронка, которой нет
// в списке, ошибочно показывалась как "Test". Теперь слаг вытаскивается из
// названия кампании автоматически — новые воронки подхватываются сами, без
// правок кода.
function getFunnelFromCampaign(campaignName) {
  if (!campaignName) return null;
  const title = (slug, sep) => slug.split(sep).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const match = campaignName.match(/([a-z0-9]+(?:-[a-z0-9]+)*)-fl-v\d+/i);
  if (match) return title(match[1], '-');
  // Старые кампании названы с подчёркиваниями ("..._brain_activation_fl_v2_..."):
  // слаг тут не отделить от остального названия, берём два слова перед "_fl_vN".
  const legacy = campaignName.match(/([a-z0-9]+_[a-z0-9]+)_fl_v\d+/i);
  return legacy ? title(legacy[1], '_') : null;
}

// "Bad" и "No purchases" убраны как отдельные грейды — всё, что не
// дотягивает до Promising (по покупкам или по CPA), падает в "Bedolaga".
function getGrade(purchases, cpa) {
  const cpaNum = (cpa === '' || cpa === null || cpa === undefined) ? Infinity : cpa;
  const cpaOk = cpaNum < CPA_THRESHOLD;
  if (purchases >= GRADE_THRESHOLDS.ALPHA && cpaOk) return 'Alpha';
  if (purchases >= GRADE_THRESHOLDS.SCALE && cpaOk) return 'Scale';
  if (purchases >= GRADE_THRESHOLDS.TEST && cpaOk) return 'Test';
  if (purchases >= GRADE_THRESHOLDS.PROMISING && cpaOk) return 'Promising';
  return 'Bedolaga';
}

// Кампания (а значит и воронка) креатива для Success Rate — та, где он
// потратил больше всего денег, как в личном скрипте пользователя.
function primaryCampaignName(row) {
  const spendBy = row._campaignSpend;
  if (!spendBy) return row.campaign_name;
  const best = Object.keys(spendBy).sort((a, b) => spendBy[b] - spendBy[a])[0];
  return best || row.campaign_name;
}

// Фильтр по типу кампании: в названии тестовых кампаний на креативы стоит
// метка "CREO-TEST" (не путать с "LOC-TEST" и т.п.). mode: 'creo-test' —
// только такие кампании, 'no-creo-test' — все кроме них, иначе без фильтра.
// Фильтруем строки до группировки, чтобы spend/покупки/грейд креатива
// считались только по выбранным кампаниям.
function filterRowsByCampaignMode(rows, mode) {
  if (mode !== 'creo-test' && mode !== 'no-creo-test') return rows;
  const isCreoTest = (r) => /creo-test/i.test(r.campaign_name || '');
  return rows.filter((r) => (mode === 'creo-test' ? isCreoTest(r) : !isCreoTest(r)));
}

function buildCreativeEntry(row) {
  const impressions = parseInt(row.impressions || 0, 10);
  const reach = parseInt(row.reach || 0, 10);
  const spend = parseFloat(row.spend || 0);
  const clicks = parseInt(row.clicks || 0, 10);
  const uniqueClicks = parseInt(row.unique_clicks || 0, 10);
  const linkClicks = sumActionTypes(row.actions, ['link_click']);
  const landingViews = getAction(row.actions, 'landing_page_view');
  const addToCart = getAction(row.actions, 'add_to_cart');
  const purchases = getActionByPriority(row.actions, PURCHASE_TYPES_PRIORITY);
  const purchaseValue = getActionByPriority(row.action_values, PURCHASE_TYPES_PRIORITY);
  const leads = getActionByPriority(row.actions, LEAD_TYPES_PRIORITY);
  const videoViews3s = getAction(row.actions, 'video_view');

  const cpa = purchases > 0 ? spend / purchases : null;
  const ctr = impressions > 0 ? linkClicks / impressions : 0;
  const cpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
  const cpc = clicks > 0 ? spend / clicks : null;
  const costPerLandingView = landingViews > 0 ? spend / landingViews : null;
  const frequency = reach > 0 ? impressions / reach : 0;

  const videoPlays = getVideoMetric(row.video_play_actions);
  // Тип крео зашит вторым сегментом названия: 123_V_..., 123_S_..., 123_L_...
  // (L — лонгрид, отдельный тип). Для старых названий без этого сегмента —
  // прежняя эвристика по _v_/_s_ и наличию видео-просмотров.
  const isLongread = /^l$/i.test(String(row.ad_name || '').split('_')[1] || '');
  const isVideo = !isLongread && (/_v_/i.test(row.ad_name || '') || (!/_s_/i.test(row.ad_name || '') && videoPlays > 0));
  const hookRate = isVideo && impressions > 0 ? videoViews3s / impressions : null;

  return {
    adId: row.ad_id,
    adIds: row._adIds || [row.ad_id],
    name: row.ad_name,
    type: isLongread ? 'Longread' : isVideo ? 'Video' : 'Static',
    mergedCount: row._mergedCount || 1,
    accounts: row._accountNames || (row._accountName ? [row._accountName] : []),
    campaignName: row.campaign_name || '',
    // Один и тот же креатив может крутиться в разных кампаниях/воронках в
    // разных аккаунтах (см. _campaignNames при мёрдже в groupRowsByCreative) —
    // раньше здесь брался campaign_name только первой попавшейся строки, из-за
    // чего в "Все аккаунты" воронка могла показывать не ту, что видна при
    // фильтре по конкретному аккаунту. Собираем воронки со всех объединённых
    // кампаний и показываем все различающиеся.
    primaryFunnel: getFunnelFromCampaign(primaryCampaignName(row)),
    funnel: [...new Set((row._campaignNames || [row.campaign_name]).map(getFunnelFromCampaign).filter(Boolean))].join(' / '),
    spend,
    impressions,
    reach,
    frequency,
    clicks,
    uniqueClicks,
    linkClicks,
    landingViews,
    costPerLandingView,
    cpm,
    cpc,
    addToCart,
    leads,
    purchases,
    purchaseValue,
    cpa,
    ctr,
    videoPlays: isVideo ? videoPlays : null,
    hookRate,
    videoViews3s: isVideo ? videoViews3s : null,
    videoP25: isVideo ? getVideoMetric(row.video_p25_watched_actions) : null,
    videoP50: isVideo ? getVideoMetric(row.video_p50_watched_actions) : null,
    videoP75: isVideo ? getVideoMetric(row.video_p75_watched_actions) : null,
    videoP100: isVideo ? getVideoMetric(row.video_p100_watched_actions) : null,
    avgWatchTime: isVideo ? getVideoMetric(row.video_avg_time_watched_actions) : null,
    grade: getGrade(purchases, cpa)
  };
}

function summarize(creatives) {
  const totalSpend = creatives.reduce((s, c) => s + c.spend, 0);
  const totalPurchases = creatives.reduce((s, c) => s + c.purchases, 0);
  const gradeCounts = {};
  for (const c of creatives) gradeCounts[c.grade] = (gradeCounts[c.grade] || 0) + 1;
  const successCount = creatives.filter((c) => SUCCESS_GRADES.includes(c.grade)).length;
  return {
    totalSpend,
    totalPurchases,
    overallCpa: totalPurchases > 0 ? totalSpend / totalPurchases : null,
    gradeCounts,
    successCount,
    successRate: creatives.length ? successCount / creatives.length : 0
  };
}

// Превью и текущий статус доставки берём одним запросом на ad_id (effective_status:
// ACTIVE значит объявление сейчас реально крутится, любое другое значение —
// остановлено/на паузе/отклонено и т.п. — считаем "не активно").
const adInfoCache = new Map();
async function fetchAdInfo(adId) {
  if (!adId) return { previewUrl: null, status: null };
  if (adInfoCache.has(adId)) return adInfoCache.get(adId);
  let info;
  try {
    const url = new URL(`https://graph.facebook.com/${API_VERSION}/${adId}`);
    url.searchParams.set('fields', 'creative{thumbnail_url,image_url,video_id,object_story_spec{video_data{video_id}},asset_feed_spec{videos{video_id}}},effective_status');
    url.searchParams.set('access_token', token());
    const resp = await fetch(url.toString());
    const json = await resp.json();
    info = {
      previewUrl: json?.creative?.thumbnail_url || json?.creative?.image_url || null,
      status: json?.effective_status || null,
      videoId: json?.creative?.video_id
        || json?.creative?.object_story_spec?.video_data?.video_id
        || json?.creative?.asset_feed_spec?.videos?.[0]?.video_id
        || null,
      rawError: json?.error?.message || null
    };
  } catch {
    info = { previewUrl: null, status: null, videoId: null };
  }
  adInfoCache.set(adId, info);
  return info;
}

// "Живое" превью объявления — тот же рендер (с воспроизведением видео),
// что и в самом Ads Manager, а не статичная картинка thumbnail_url. Meta
// отдаёт его как готовый <iframe> (поле body) под конкретный формат
// плейсмента — если запрошенный формат объявлению не подходит (например,
// оно никогда не показывалось в этом плейсменте), API отвечает пустым
// data[], поэтому пробуем ещё один распространённый формат перед тем как
// сдаться.
const AD_PREVIEW_FORMATS = ['MOBILE_FEED_STANDARD', 'DESKTOP_FEED_STANDARD'];

async function fetchAdPreview(adId, adFormat) {
  const formats = adFormat ? [adFormat] : AD_PREVIEW_FORMATS;
  for (const format of formats) {
    const url = new URL(`https://graph.facebook.com/${API_VERSION}/${adId}/previews`);
    url.searchParams.set('ad_format', format);
    url.searchParams.set('access_token', token());
    const resp = await fetch(url.toString());
    const json = await resp.json();
    if (json.error) throw new Error(json.error.message);
    const html = json?.data?.[0]?.body;
    if (html) return html;
  }
  return null;
}

async function mapConcurrent(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function attachPreviews(creatives) {
  const allIds = new Set();
  for (const c of creatives) { (c.adIds || [c.adId]).forEach((id) => id && allIds.add(id)); }
  await mapConcurrent([...allIds], 8, fetchAdInfo);

  for (const c of creatives) {
    const rep = adInfoCache.get(c.adId);
    c.previewUrl = rep?.previewUrl || null;
    const statuses = (c.adIds || [c.adId]).map((id) => adInfoCache.get(id)?.status);
    c.activeCount = statuses.filter((s) => s === 'ACTIVE').length;
    c.totalCount = statuses.length;
  }
  return creatives;
}

// Длина видео (сек) — чтобы сравнивать среднее время просмотра с полной
// длиной ролика. Берём video_id из креатива объявления и читаем length у
// самого видео; результат кэшируем. Если Meta не отдаёт длину (нет доступа к
// видео / динамический креатив), поле остаётся null.
const videoLengthCache = new Map();
async function fetchVideoLength(videoId) {
  if (!videoId) return null;
  if (videoLengthCache.has(videoId)) return videoLengthCache.get(videoId);
  let length = null;
  try {
    const url = new URL(`https://graph.facebook.com/${API_VERSION}/${videoId}`);
    url.searchParams.set('fields', 'length');
    url.searchParams.set('access_token', token());
    const json = await (await fetch(url.toString())).json();
    length = typeof json?.length === 'number' ? json.length : null;
    if (json?.error) videoLengthErrors.push(json.error.message);
  } catch (err) { videoLengthErrors.push(err.message); }
  videoLengthCache.set(videoId, length);
  return length;
}
const videoLengthErrors = [];

// Прямое чтение видео-объекта токену запрещено ((#10) нет прав), зато список
// видео рекламного аккаунта (/advideos) читается — берём длины оттуда и
// кэшируем на 30 минут.
let accountVideosCache = null; // { at, map }
async function loadAccountVideoLengths() {
  if (accountVideosCache && Date.now() - accountVideosCache.at < 30 * 60 * 1000) return accountVideosCache.map;
  const map = {};
  await Promise.all(Object.values(accounts()).map(async (accId) => {
    try {
      const url = new URL(`https://graph.facebook.com/${API_VERSION}/${accId}/advideos`);
      url.searchParams.set('fields', 'length');
      url.searchParams.set('limit', '500');
      url.searchParams.set('access_token', token());
      for (const v of await paginate(url.toString())) if (typeof v.length === 'number') map[v.id] = v.length;
    } catch (err) { videoLengthErrors.push('advideos: ' + err.message); }
  }));
  accountVideosCache = { at: Date.now(), map };
  return map;
}

// Требует предварительного attachPreviews (там подтягивается video_id).
async function attachVideoLengths(creatives) {
  const lengths = await loadAccountVideoLengths();
  for (const c of creatives) {
    const vid = adInfoCache.get(c.adId)?.videoId;
    c.videoLength = (vid && lengths[vid]) || null;
  }
  attachVideoLengths.lastDebug = {
    creatives: creatives.length,
    withVideoId: creatives.filter((c) => adInfoCache.get(c.adId)?.videoId).length,
    withLength: creatives.filter((c) => c.videoLength).length,
    infoErrors: [...new Set(creatives.map((c) => adInfoCache.get(c.adId)?.rawError).filter(Boolean))].slice(0, 3),
    lengthErrors: [...new Set(videoLengthErrors)].slice(0, 3)
  };
  return creatives;
}

module.exports = {
  attachVideoLengths,
  accounts, fetchAllAccountsInsights, fetchAccountInsights,
  fetchAllAccountsInsightsBreakdown, fetchVideoCurves, fetchCountrySpend, filterRowsByCountries, collapseCountryRows,
  groupRowsByCreative, buildCreativeEntry, summarize, attachPreviews, filterRowsByCampaignMode,
  fetchLaunchedTaskNumbers, fetchPlatformBreakdown, fetchDemographics,
  fetchAdPreview,
  SUCCESS_GRADES
};
