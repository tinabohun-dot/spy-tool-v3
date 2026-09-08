const crypto = require('crypto');
const db = require('./db');
const { fetchAllAdsForPage } = require('./metaApi');
const { inspectSnapshot } = require('./snapshotInspect');
const jobStatus = require('./jobStatus');

function todayStr() { return new Date().toISOString().slice(0, 10); }
function hashText(text) { return crypto.createHash('md5').update((text || '').trim().toLowerCase()).digest('hex'); }

async function fetchSnapshotForAdPage(adPage, days = 7) {
  jobStatus.startJob(adPage);
  try {
    return await runFetch(adPage, days);
  } catch (err) {
    jobStatus.failJob(adPage.id, err);
    throw err;
  }
}

// Собираем не весь исторический архив страницы, а только то, что реально
// нужно: объявления, которые сейчас активны (независимо от даты старта —
// долгоживущую активную кампанию не теряем из виду), плюс те, что стартовали
// в выбранном периоде (по умолчанию 7 дней). Старые остановленные тесты вне
// периода не тянем и не рендерим повторно каждый день — это и было основной
// причиной, по которой мы выжигали лимит Meta на рендер снепшотов.
function withinCollectionWindow(ad, days) {
  const isActive = !ad.ad_delivery_stop_time || new Date(ad.ad_delivery_stop_time) > new Date();
  if (isActive) return true;
  if (!ad.ad_delivery_start_time) return false;
  const since = new Date(Date.now() - days * 86400000);
  return new Date(ad.ad_delivery_start_time) >= since;
}

async function runFetch(adPage, days = 7) {
  const allAds = await fetchAllAdsForPage({ pageId: adPage.page_id });
  const ads = allAds.filter((ad) => withinCollectionWindow(ad, days));
  jobStatus.setTotal(adPage.id, ads.length);
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

  // inspectSnapshot рендерит каждое объявление headless-браузером — на страницах
  // с сотнями/тысячами объявлений последовательный await убил бы весь сбор на
  // часы. Обрабатываем параллельно (внутри snapshotInspect своя очередь на 4
  // одновременных вкладки) и пишем в БД сразу по готовности каждого объявления,
  // чтобы при прерывании процесса уже отрендеренные креативы не терялись.
  const rows = await Promise.all(ads.map(async (ad) => {
    const body = (ad.ad_creative_bodies || [])[0] || ad.ad_creative_link_titles?.[0] || '';
    const { format, thumbnail } = await inspectSnapshot(ad.ad_snapshot_url);
    const isActive = !ad.ad_delivery_stop_time || new Date(ad.ad_delivery_stop_time) > new Date();
    const row = {
      ad_page_id: adPage.id, ad_id: ad.id, creative_body: body,
      creative_title: ad.ad_creative_link_titles?.[0] || null,
      snapshot_url: ad.ad_snapshot_url || null, thumbnail_url: thumbnail, format,
      delivery_start: ad.ad_delivery_start_time || null, delivery_stop: ad.ad_delivery_stop_time || null,
      languages: JSON.stringify(ad.languages || []), platforms: JSON.stringify(ad.publisher_platforms || []),
      is_active: isActive ? 1 : 0, eu_total_reach: ad.eu_total_reach ?? null,
      reach_breakdown: JSON.stringify(ad.age_country_gender_reach_breakdown || []),
      link_caption: (ad.ad_creative_link_captions || [])[0] || null,
      duplicate_group: hashText(body), fetch_date: date
    };
    await insertSnapshot.run(row);
    jobStatus.incrementProcessed(adPage.id);
    return row;
  }));

  const ranked = [...rows].sort((a, b) => (b.eu_total_reach || 0) - (a.eu_total_reach || 0));
  const insertRank = db.prepare(`
    INSERT INTO rank_history (ad_page_id, ad_id, fetch_date, rank) VALUES (@ad_page_id, @ad_id, @fetch_date, @rank)
    ON CONFLICT(ad_page_id, ad_id, fetch_date) DO UPDATE SET rank=excluded.rank
  `);
  for (const [idx, item] of ranked.entries()) {
    await insertRank.run({ ad_page_id: item.ad_page_id, ad_id: item.ad_id, fetch_date: date, rank: idx + 1 });
  }

  jobStatus.finishJob(adPage.id, rows.length);
  return { count: rows.length, date };
}

module.exports = { fetchSnapshotForAdPage, todayStr };
