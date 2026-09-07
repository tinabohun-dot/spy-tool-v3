// Meta Marketing API (не Ad Library) — перформанс собственных рекламных
// кабинетов: расход, покупки, CPA и т.д. Логика метрик, грейдинга и
// группировки дублей портирована из личного Google Apps Script
// пользователя (meta_kpi v12).
const API_VERSION = 'v19.0';

const CPA_THRESHOLD = 75;
const GRADE_THRESHOLDS = { ALPHA: 50, SCALE: 20, TEST: 10, PROMISING: 3 };
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

async function fetchAllAccountsInsights(since, until) {
  const accs = accounts();
  const rows = [];
  for (const [accName, accId] of Object.entries(accs)) {
    const accRows = await fetchAccountInsights(accId, since, until);
    for (const r of accRows) { r._accountName = accName; rows.push(r); }
  }
  return rows;
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
        ...row, _mergedCount: 1, _accountNames: [row._accountName],
        _prevPlays: getVideoMetric(row.video_play_actions), _adIds: [row.ad_id]
      };
      groups[key] = copy;
      order.push(key);
      continue;
    }
    const target = groups[key];
    target._mergedCount++;
    target._adIds.push(row.ad_id);
    if (!target._accountNames.includes(row._accountName)) target._accountNames.push(row._accountName);
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

function getGrade(purchases, cpa) {
  const cpaNum = (cpa === '' || cpa === null || cpa === undefined) ? Infinity : cpa;
  if (purchases === 0) return 'No purchases';
  if (purchases >= 1 && purchases <= 2) return 'Bad';
  if (cpaNum >= CPA_THRESHOLD) return 'Bad';
  if (purchases >= GRADE_THRESHOLDS.ALPHA) return 'Alpha';
  if (purchases >= GRADE_THRESHOLDS.SCALE) return 'Scale';
  if (purchases >= GRADE_THRESHOLDS.TEST) return 'Test';
  if (purchases >= GRADE_THRESHOLDS.PROMISING) return 'Promising';
  return 'Bad';
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
  const isVideo = /_v_/i.test(row.ad_name || '') || (!/_s_/i.test(row.ad_name || '') && videoPlays > 0);
  const hookRate = isVideo && impressions > 0 ? videoViews3s / impressions : null;

  return {
    adId: row.ad_id,
    adIds: row._adIds || [row.ad_id],
    name: row.ad_name,
    type: isVideo ? 'Video' : 'Static',
    mergedCount: row._mergedCount || 1,
    accounts: row._accountNames || (row._accountName ? [row._accountName] : []),
    campaignName: row.campaign_name || '',
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
    url.searchParams.set('fields', 'creative{thumbnail_url,image_url},effective_status');
    url.searchParams.set('access_token', token());
    const resp = await fetch(url.toString());
    const json = await resp.json();
    info = {
      previewUrl: json?.creative?.thumbnail_url || json?.creative?.image_url || null,
      status: json?.effective_status || null
    };
  } catch {
    info = { previewUrl: null, status: null };
  }
  adInfoCache.set(adId, info);
  return info;
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

module.exports = {
  accounts, fetchAllAccountsInsights, fetchAccountInsights,
  groupRowsByCreative, buildCreativeEntry, summarize, attachPreviews
};
