const db = require('./db');

function pageIdsForBrand(brandId) {
  return db.prepare('SELECT id FROM ad_pages WHERE brand_id = ?').all(brandId).map((r) => r.id);
}

function latestSnapshot(pageIds) {
  if (!pageIds.length) return [];
  const ph = pageIds.map(() => '?').join(',');
  const maxDateRow = db.prepare(`SELECT MAX(fetch_date) as d FROM ad_snapshots WHERE ad_page_id IN (${ph})`).get(...pageIds);
  if (!maxDateRow?.d) return [];
  return db.prepare(`SELECT * FROM ad_snapshots WHERE ad_page_id IN (${ph}) AND fetch_date = ?`).all(...pageIds, maxDateRow.d);
}

function metrics(brandId, days = 7) {
  const pageIds = pageIdsForBrand(brandId);
  if (!pageIds.length) return null;
  const ph = pageIds.map(() => '?').join(',');
  const byDay = db.prepare(`
    SELECT substr(delivery_start,1,10) as day, format, COUNT(*) as n FROM ad_snapshots
    WHERE ad_page_id IN (${ph}) AND delivery_start IS NOT NULL GROUP BY day, format ORDER BY day ASC
  `).all(...pageIds);
  const rows = latestSnapshot(pageIds);
  const formatCount = { image: 0, video: 0, unknown: 0 };
  const langCount = {}; const platformCount = {}; const destinationCount = {};
  for (const r of rows) {
    formatCount[r.format] = (formatCount[r.format] || 0) + 1;
    for (const l of JSON.parse(r.languages || '[]')) langCount[l] = (langCount[l] || 0) + 1;
    for (const p of JSON.parse(r.platforms || '[]')) platformCount[p] = (platformCount[p] || 0) + 1;
    if (r.link_caption) destinationCount[r.link_caption] = (destinationCount[r.link_caption] || 0) + 1;
  }

  const DAY = 86400000;
  const today = new Date();
  const sinceCurrent = new Date(today - days * DAY).toISOString().slice(0, 10);
  const sincePrev = new Date(today - 2 * days * DAY).toISOString().slice(0, 10);
  let current = 0; let prev = 0;
  for (const d of byDay) {
    if (d.day >= sinceCurrent) current += d.n;
    else if (d.day >= sincePrev) prev += d.n;
  }
  const pctChange = prev ? Math.round(((current - prev) / prev) * 100) : null;

  return {
    byDay, formatCount, languages: langCount, platforms: platformCount, destinations: destinationCount,
    totalAdsInLatestSnapshot: rows.length, adsPublished: { days, current, prev, pctChange }
  };
}

function euReach(brandId) {
  const pageIds = pageIdsForBrand(brandId);
  if (!pageIds.length) return null;
  const rows = latestSnapshot(pageIds).filter((r) => r.eu_total_reach != null);
  const totalReach = rows.reduce((s, r) => s + (r.eu_total_reach || 0), 0);

  const gender = { male: 0, female: 0, unknown: 0 };
  const age = {};
  const countries = {};
  for (const r of rows) {
    let breakdown;
    try { breakdown = JSON.parse(r.reach_breakdown || '[]'); } catch { breakdown = []; }
    for (const c of breakdown) {
      for (const ag of c.age_gender_breakdowns || []) {
        const male = ag.male || 0; const female = ag.female || 0; const unknown = ag.unknown || 0;
        gender.male += male; gender.female += female; gender.unknown += unknown;
        age[ag.age_range] = (age[ag.age_range] || 0) + male + female + unknown;
        countries[c.country] = (countries[c.country] || 0) + male + female + unknown;
      }
    }
  }

  return { totalReach, adsWithReachData: rows.length, gender, age, countries };
}

function trending(brandId, days = 14) {
  const pageIds = pageIdsForBrand(brandId);
  if (!pageIds.length) return [];
  const ph = pageIds.map(() => '?').join(',');
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const history = db.prepare(`
    SELECT ad_id, fetch_date, rank FROM rank_history WHERE ad_page_id IN (${ph}) AND fetch_date >= ? ORDER BY ad_id, fetch_date ASC
  `).all(...pageIds, since);
  const byAd = {};
  for (const h of history) { (byAd[h.ad_id] ||= []).push(h); }
  const result = [];
  for (const [adId, points] of Object.entries(byAd)) {
    if (points.length < 2) continue;
    const first = points[0].rank; const last = points[points.length - 1].rank;
    if (last < first) result.push({ adId, points, rankChange: first - last });
  }
  return result.sort((a, b) => b.rankChange - a.rankChange).slice(0, 20);
}

function winningAds(brandId, limit = 20) {
  const pageIds = pageIdsForBrand(brandId);
  if (!pageIds.length) return [];
  const rows = latestSnapshot(pageIds);
  const dupCounts = {};
  for (const r of rows) dupCounts[r.duplicate_group] = (dupCounts[r.duplicate_group] || 0) + 1;
  const maxReach = Math.max(1, ...rows.map((r) => r.eu_total_reach || 0));
  const maxDup = Math.max(1, ...Object.values(dupCounts));
  const scored = rows.map((r) => {
    const activityDays = r.delivery_start ? Math.max(0, Math.round((Date.now() - new Date(r.delivery_start).getTime()) / 86400000)) : 0;
    const dupScore = (dupCounts[r.duplicate_group] || 1) / maxDup;
    const reachScore = (r.eu_total_reach || 0) / maxReach;
    const activityScore = Math.min(1, activityDays / 90);
    const score = Math.round((0.4 * dupScore + 0.35 * reachScore + 0.25 * activityScore) * 100);
    return { ...r, activityDays, duplicates: dupCounts[r.duplicate_group] || 1, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

function creativeTests(brandId) {
  const pageIds = pageIdsForBrand(brandId);
  if (!pageIds.length) return [];
  const ph = pageIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT substr(delivery_start,1,10) as day, SUM(is_active) as active, COUNT(*) - SUM(is_active) as inactive
    FROM ad_snapshots WHERE ad_page_id IN (${ph}) AND delivery_start IS NOT NULL GROUP BY day ORDER BY day ASC
  `).all(...pageIds);
}

function creativesGrid(brandId) {
  const pageIds = pageIdsForBrand(brandId);
  if (!pageIds.length) return [];
  const rows = latestSnapshot(pageIds);
  const dupCounts = {};
  for (const r of rows) dupCounts[r.duplicate_group] = (dupCounts[r.duplicate_group] || 0) + 1;
  return rows.map((r) => ({
    ...r, duplicates: dupCounts[r.duplicate_group] || 1,
    activityDays: r.delivery_start ? Math.max(0, Math.round((Date.now() - new Date(r.delivery_start).getTime()) / 86400000)) : null
  }));
}

/** Счётчик для карточки бренда в Ad Library: активные сейчас / всего когда-либо замечено */
function libraryStats(brandId) {
  const pageIds = pageIdsForBrand(brandId);
  if (!pageIds.length) return { active: 0, total: 0 };
  const ph = pageIds.map(() => '?').join(',');

  const totalRow = db
    .prepare(`SELECT COUNT(DISTINCT ad_id) as n FROM ad_snapshots WHERE ad_page_id IN (${ph})`)
    .get(...pageIds);

  const maxDateRow = db
    .prepare(`SELECT MAX(fetch_date) as d FROM ad_snapshots WHERE ad_page_id IN (${ph})`)
    .get(...pageIds);

  let active = 0;
  if (maxDateRow?.d) {
    const activeRow = db
      .prepare(`
        SELECT COUNT(DISTINCT ad_id) as n FROM ad_snapshots
        WHERE ad_page_id IN (${ph}) AND fetch_date = ? AND is_active = 1
      `)
      .get(...pageIds, maxDateRow.d);
    active = activeRow?.n || 0;
  }

  return { active, total: totalRow?.n || 0 };
}

module.exports = { metrics, euReach, trending, winningAds, creativeTests, creativesGrid, pageIdsForBrand, libraryStats };
