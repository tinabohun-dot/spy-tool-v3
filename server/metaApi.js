const API_VERSION = 'v20.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}/ads_archive`;

// Все страны, поддерживаемые Meta для ad_reached_countries. Используется при
// сборе снепшотов по отслеживаемым Ad Page, т.к. заранее не известно, в каких
// странах реально показываются объявления конкретной страницы — фильтр по
// одной стране (например, только US) молча возвращает 0 объявлений, если
// реклама там не шла.
const ALL_REACHED_COUNTRIES = [
  'BR', 'IN', 'GB', 'US', 'CA', 'AR', 'AU', 'AT', 'BE', 'CL', 'CN', 'CO', 'HR', 'DK', 'DO', 'EG',
  'FI', 'FR', 'DE', 'GR', 'HK', 'ID', 'IE', 'IL', 'IT', 'JP', 'JO', 'KW', 'LB', 'MY', 'MX', 'NL',
  'NZ', 'NG', 'NO', 'PK', 'PA', 'PE', 'PH', 'PL', 'RU', 'SA', 'RS', 'SG', 'ZA', 'KR', 'ES', 'SE',
  'CH', 'TW', 'TH', 'TR', 'AE', 'VE', 'PT', 'LU', 'BG', 'CZ', 'SI', 'IS', 'SK', 'LT', 'TT', 'BD',
  'LK', 'KE', 'HU', 'MA', 'CY', 'JM', 'EC', 'RO', 'BO', 'GT', 'CR', 'QA', 'SV', 'HN', 'NI', 'PY',
  'UY', 'PR', 'BA', 'PS', 'TN', 'BH', 'VN', 'GH', 'MU', 'UA', 'MT', 'BS', 'MV', 'OM', 'MK', 'LV',
  'EE', 'IQ', 'DZ', 'AL', 'NP', 'MO', 'ME', 'SN', 'GE', 'BN', 'UG', 'GP', 'BB', 'AZ', 'TZ', 'LY',
  'MQ', 'CM', 'BW', 'ET', 'KZ', 'NA', 'MG', 'NC', 'MD', 'FJ', 'BY', 'JE', 'GU', 'YE', 'ZM', 'IM',
  'HT', 'KH', 'AW', 'PF', 'AF', 'BM', 'GY', 'AM', 'MW', 'AG', 'RW', 'GG', 'GM', 'FO', 'LC', 'KY',
  'BZ', 'VC', 'MN', 'MZ', 'ML', 'AO', 'GF', 'UZ', 'DJ', 'BF', 'MC', 'TG', 'GL', 'GA', 'GI', 'CD',
  'KG', 'PG', 'BT', 'KN', 'SZ', 'LS', 'LA', 'LI', 'MP', 'SR', 'SC', 'VG', 'TC', 'DM', 'MR', 'AX',
  'SM', 'SL', 'NE', 'CG', 'AI', 'YT', 'CV', 'GN', 'TM', 'BI', 'TJ', 'VU', 'SB', 'ER', 'WS', 'AS',
  'FK', 'GQ', 'TO', 'KM', 'PW', 'FM', 'CF', 'SO', 'MH', 'VA', 'TD', 'KI', 'ST', 'TV', 'NR', 'RE',
  'LR', 'ZW', 'CI', 'MM', 'AN', 'AQ', 'BQ', 'BV', 'IO', 'CX', 'CC', 'CK', 'CW', 'TF', 'GW', 'HM',
  'XK', 'MS', 'NU', 'NF', 'PN', 'BL', 'SH', 'MF', 'PM', 'SX', 'GS', 'SS', 'SJ', 'TL', 'TK', 'UM',
  'WF', 'EH', 'SY'
];

const FIELDS = [
  'id','page_name','page_id','ad_creative_bodies','ad_creative_link_captions',
  'ad_creative_link_titles','ad_creative_link_descriptions','ad_snapshot_url',
  'ad_delivery_start_time','ad_delivery_stop_time','publisher_platforms','languages',
  'estimated_audience_size','eu_total_reach','age_country_gender_reach_breakdown',
  'target_ages','target_gender','target_locations'
].join(',');

function buildUrl({ searchTerms, pageIds, countries, activeStatus, platforms, after, limit }) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    const err = new Error('META_ACCESS_TOKEN не задан. Добавь его в server/.env');
    err.status = 500;
    throw err;
  }
  const url = new URL(BASE_URL);
  url.searchParams.set('access_token', token);
  url.searchParams.set('ad_type', 'ALL');
  url.searchParams.set('ad_reached_countries', JSON.stringify(countries || ['US']));
  url.searchParams.set('ad_active_status', activeStatus || 'ALL');
  url.searchParams.set('fields', FIELDS);
  url.searchParams.set('limit', String(limit || 100));

  if (pageIds && pageIds.length) {
    url.searchParams.set('search_page_ids', JSON.stringify(pageIds));
  } else if (searchTerms) {
    url.searchParams.set('search_terms', searchTerms);
  } else {
    const err = new Error('Нужно указать searchTerms или pageIds');
    err.status = 400;
    throw err;
  }
  if (platforms && platforms.length > 0) url.searchParams.set('publisher_platforms', JSON.stringify(platforms));
  if (after) url.searchParams.set('after', after);
  return url.toString();
}

async function searchAdsPage(params) {
  const resp = await fetch(buildUrl(params));
  const json = await resp.json();
  if (!resp.ok) {
    const message = json?.error?.message || 'Ошибка запроса к Meta Ad Library API';
    const err = new Error(message);
    err.status = resp.status;
    err.metaError = json?.error;
    throw err;
  }
  return {
    ads: json.data || [],
    nextCursor: json.paging?.cursors?.after || null,
    hasNext: Boolean(json.paging?.next)
  };
}

async function searchAds({ searchTerms, countries = ['US'], activeStatus = 'ACTIVE', platforms = [], after, limit = 25 }) {
  return searchAdsPage({ searchTerms, countries, activeStatus, platforms, after, limit });
}

async function fetchAllAdsForPage({ pageId, countries = ALL_REACHED_COUNTRIES, maxPages = 20 }) {
  let after;
  let all = [];
  for (let i = 0; i < maxPages; i++) {
    const { ads, nextCursor, hasNext } = await searchAdsPage({
      pageIds: [pageId], countries, activeStatus: 'ALL', limit: 100, after
    });
    all = all.concat(ads);
    if (!hasNext || !nextCursor) break;
    after = nextCursor;
  }
  return all;
}

module.exports = { searchAds, fetchAllAdsForPage };
