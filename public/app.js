const API = '';
let currentBrandId = null;
let currentPages = [];
let charts = {};
let adsData = [];
let adsStatusFilter = 'all';
let adsPageFilter = 'all';

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }

// ---------- Навигация ----------
$all('.side-nav__item').forEach((btn) => {
  btn.addEventListener('click', () => {
    $all('.side-nav__item').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    const view = btn.dataset.view;
    $('#search-form').hidden = view !== 'search';
    $('#view-library').hidden = view !== 'library';
    $('#view-search').hidden = view !== 'search';
    $('#view-jobs').hidden = view !== 'jobs';
    $('#view-analytics').hidden = view !== 'analytics';
    $('#view-brand').hidden = true;
    if (view === 'jobs') startJobsPolling(); else stopJobsPolling();
    if (view === 'analytics') initAnalyticsView();
  });
});

$('#back-to-library').addEventListener('click', () => {
  $('#view-brand').hidden = true;
  $('#view-library').hidden = false;
});

// ---------- Ad Library: список брендов ----------
let allBrands = [];
const LOGO_COLORS = ['#d95f2b', '#2ea56f', '#3b6fd9', '#a259d9', '#d9a03b', '#d94f6f'];

function logoColor(name) {
  let sum = 0;
  for (const ch of name) sum += ch.charCodeAt(0);
  return LOGO_COLORS[sum % LOGO_COLORS.length];
}

async function loadBrands() {
  allBrands = await fetch('/api/brands').then((r) => r.json());
  populateCategoryFilter();
  renderBrandsGrid();
}

function populateCategoryFilter() {
  const select = $('#category-filter');
  const current = select.value;
  const categories = [...new Set(allBrands.map((b) => b.category).filter(Boolean))].sort();
  select.innerHTML = '<option value="">Все категории</option>' +
    categories.map((c) => `<option value="${c}">${c}</option>`).join('');
  select.value = categories.includes(current) ? current : '';
}

function renderBrandsGrid() {
  const query = $('#brand-search').value.trim().toLowerCase();
  const category = $('#category-filter').value;

  const filtered = allBrands.filter((b) => {
    const matchesQuery = !query || b.name.toLowerCase().includes(query);
    const matchesCategory = !category || b.category === category;
    return matchesQuery && matchesCategory;
  });

  $('#tracked-count-pill').textContent = `Tracked (${allBrands.length})`;

  const grid = $('#brands-grid');
  grid.innerHTML = '';
  if (!filtered.length) {
    grid.innerHTML = allBrands.length
      ? '<p class="empty-note">Ничего не найдено — попробуй другой запрос или сбрось фильтр.</p>'
      : '<p class="empty-note">Пока нет ни одного бренда — добавь первый.</p>';
    return;
  }

  for (const b of filtered) {
    const initials = b.name.trim().slice(0, 2);
    const active = b.stats?.active ?? 0;
    const total = b.stats?.total ?? 0;
    const card = document.createElement('article');
    card.className = 'brand-card';
    card.innerHTML = `
      <div class="brand-card__top">
        <div class="brand-card__logo" style="background:${logoColor(b.name)}">${initials}</div>
        <div>
          <div class="brand-card__name">${b.name}</div>
          <div class="brand-card__category">${b.category || '—'}</div>
        </div>
      </div>
      <div class="brand-card__stats">
        <span class="brand-card__count">
          <span class="brand-card__dot ${active > 0 ? 'is-active' : ''}"></span>
          ${active} / ${total} active ads
        </span>
        <span class="brand-card__platform">∞</span>
      </div>
    `;
    card.addEventListener('click', () => openBrand(b));
    grid.appendChild(card);
  }
}

$('#brand-search').addEventListener('input', renderBrandsGrid);
$('#category-filter').addEventListener('change', renderBrandsGrid);

$('#add-brand-btn').addEventListener('click', () => $('#add-brand-dialog').showModal());
$all('[data-close]').forEach((b) => b.addEventListener('click', (e) => e.target.closest('dialog').close()));

$('#add-brand-form').addEventListener('submit', async (e) => {
  const name = $('#new-brand-name').value.trim();
  const category = $('#new-brand-category').value.trim();
  if (!name) return;
  await fetch('/api/brands', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, category })
  });
  $('#new-brand-name').value = '';
  $('#new-brand-category').value = '';
  loadBrands();
});

// ---------- Карточка бренда ----------
async function openBrand(brand) {
  currentBrandId = brand.id;
  currentPages = brand.pages;
  adsStatusFilter = 'all';
  adsPageFilter = 'all';
  $('#view-library').hidden = true;
  $('#view-brand').hidden = false;
  $('#brand-title').textContent = brand.name;
  $('#brand-sub').textContent = brand.category || '';
  $('#brand-stats-overview').textContent = brand.stats
    ? `Всего по всем аккаунтам: ${brand.stats.active} активных из ${brand.stats.total} креативов`
    : '';
  renderPages(brand.pages);
  populateAdsPageFilter();
  await loadTab('metrics');
}

function populateAdsPageFilter() {
  const select = $('#ads-page-filter');
  select.innerHTML = '<option value="all">Все аккаунты</option>' + currentPages.map((p) =>
    `<option value="${p.id}">${p.page_name || p.page_id}</option>`
  ).join('');
  select.value = 'all';
  $all('#ads-status-filter .segmented__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.status === 'all'));
}

function renderPages(pages) {
  const row = $('#brand-pages');
  if (!pages.length) { row.innerHTML = '<span class="hint">Ad Page ещё не добавлены</span>'; return; }
  const isAll = adsPageFilter === 'all';
  const chips = [`<button type="button" class="page-chip${isAll ? ' is-active' : ''}" data-page-id="all">Все аккаунты</button>`]
    .concat(pages.map((p) => {
      const active = String(adsPageFilter) === String(p.id);
      return `<button type="button" class="page-chip${active ? ' is-active' : ''}" data-page-id="${p.id}">${p.page_name || p.page_id} (${p.platform})</button>`;
    }));
  row.innerHTML = chips.join('');
}

$('#brand-pages').addEventListener('click', (e) => {
  const chip = e.target.closest('.page-chip');
  if (!chip) return;
  adsPageFilter = chip.dataset.pageId;
  renderPages(currentPages);
  $('#ads-page-filter').value = adsPageFilter;
  activateTab('ads');
});

$('#add-page-btn').addEventListener('click', () => $('#add-page-dialog').showModal());

$('#add-page-form').addEventListener('submit', async (e) => {
  const input = $('#new-page-input').value.trim();
  const page_name = $('#new-page-name').value.trim();
  if (!input || !currentBrandId) return;
  const resp = await fetch(`/api/brands/${currentBrandId}/pages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'meta', input, page_name })
  });
  const data = await resp.json();
  if (!resp.ok) { alert('Ошибка: ' + data.error); return; }
  $('#new-page-input').value = '';
  $('#new-page-name').value = '';
  const brands = await fetch('/api/brands').then((r) => r.json());
  const updated = brands.find((b) => b.id === currentBrandId);
  currentPages = updated.pages;
  adsPageFilter = 'all';
  adsStatusFilter = 'all';
  $('#brand-stats-overview').textContent = updated.stats
    ? `Всего по всем аккаунтам: ${updated.stats.active} активных из ${updated.stats.total} креативов`
    : '';
  renderPages(currentPages);
  populateAdsPageFilter();
  await loadTab('metrics');
});

$('#refresh-brand-btn').addEventListener('click', async () => {
  $('#refresh-brand-btn').textContent = 'Собираю...';
  try {
    await fetch(`/api/brands/${currentBrandId}/refresh`, { method: 'POST' });
    await loadTab($('.tab.is-active').dataset.tab);
  } finally {
    $('#refresh-brand-btn').textContent = '↻ Обновить сейчас';
  }
});

// ---------- Вкладки ----------
function activateTab(name) {
  $all('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  $all('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.id === `tab-${name}`));
  loadTab(name);
}

$all('.tab').forEach((tab) => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
});

async function loadTab(name) {
  if (!currentBrandId) return;
  if (name === 'metrics') return renderMetrics();
  if (name === 'eu-reach') return renderEuReach();
  if (name === 'trending') return renderTrending();
  if (name === 'winning') return renderWinning();
  if (name === 'creative-tests') return renderCreativeTests();
  if (name === 'ads') return renderAdsGrid();
}

function destroyChart(key) { if (charts[key]) { charts[key].destroy(); delete charts[key]; } }

async function renderMetrics() {
  const data = await fetch(`/api/brands/${currentBrandId}/metrics`).then((r) => r.json());
  if (!data) return;

  // публикации по дням (суммарно по форматам)
  const days = [...new Set(data.byDay.map((r) => r.day))].sort();
  const counts = days.map((d) => data.byDay.filter((r) => r.day === d).reduce((s, r) => s + r.n, 0));
  destroyChart('byDay');
  charts.byDay = new Chart($('#chart-by-day'), {
    type: 'line',
    data: { labels: days, datasets: [{ label: 'Объявлений', data: counts, borderColor: '#d95f2b', tension: 0.3 }] },
    options: { plugins: { legend: { display: false } } }
  });

  const { last30, pctChange } = data.adsPublished;
  const pctHtml = pctChange === null ? ''
    : `<span class="big-number__pct ${pctChange >= 0 ? 'big-number__pct--up' : 'big-number__pct--down'}">${pctChange >= 0 ? '↗' : '↘'}${pctChange}%</span>`;
  $('#ads-published-number').innerHTML = `${last30}${pctHtml}`;

  renderFormatBar(data.formatCount);
  renderBarList('#destination-bars', data.destinations);
  renderBarList('#lang-bars', data.languages);
  renderBarList('#platform-bars', data.platforms);
}

const FORMAT_COLORS = { image: '#d95f2b', video: '#2ea56f', unknown: '#c9c9c4' };

function renderFormatBar(formatCount) {
  const order = ['image', 'video', 'unknown'];
  const total = order.reduce((s, k) => s + (formatCount[k] || 0), 0) || 1;
  $('#format-stacked-bar').innerHTML = order
    .filter((k) => formatCount[k])
    .map((k) => `<span class="stacked-bar__seg" style="width:${(formatCount[k] / total) * 100}%;background:${FORMAT_COLORS[k]}"></span>`)
    .join('');
  $('#format-legend').innerHTML = order
    .map((k) => `<span><span class="stacked-bar__dot" style="background:${FORMAT_COLORS[k]}"></span>${k} ${Math.round((formatCount[k] || 0) / total * 100)}%</span>`)
    .join('');
}

const CATEGORY_COLORS = [
  '#4285f4', '#2ea56f', '#f4b400', '#d95f2b', '#a142f4',
  '#00acc1', '#e91e8c', '#8d6e63', '#607d8b', '#c9a227'
];

function renderBarList(sel, obj, sortByValue = true) {
  let entries = Object.entries(obj);
  entries = sortByValue ? entries.sort((a, b) => b[1] - a[1]).slice(0, 8) : entries;
  const max = Math.max(1, ...entries.map((e) => e[1]));
  $(sel).innerHTML = entries.map(([label, val], i) => `
    <div class="bar-row">
      <span class="bar-row__label">${label}</span>
      <span class="bar-row__track"><span class="bar-row__fill" style="width:${(val / max) * 100}%;background:${CATEGORY_COLORS[i % CATEGORY_COLORS.length]}"></span></span>
      <span class="bar-row__value">${val}</span>
    </div>`).join('') || '<p class="hint">Пока нет данных</p>';
}

const AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];

async function renderEuReach() {
  const data = await fetch(`/api/brands/${currentBrandId}/eu-reach`).then((r) => r.json());
  $('#eu-reach-total').textContent = data ? data.totalReach.toLocaleString('ru-RU') : '—';
  if (!data) return;

  renderBarList('#eu-gender-bars', {
    'Мужчины': data.gender.male,
    'Женщины': data.gender.female,
    ...(data.gender.unknown ? { 'Не указано': data.gender.unknown } : {})
  });

  const ageEntries = Object.entries(data.age).sort((a, b) => AGE_ORDER.indexOf(a[0]) - AGE_ORDER.indexOf(b[0]));
  renderBarList('#eu-age-bars', Object.fromEntries(ageEntries), false);

  renderBarList('#eu-country-bars', data.countries);
}

async function renderTrending() {
  const data = await fetch(`/api/brands/${currentBrandId}/trending`).then((r) => r.json());
  $('#trending-list').innerHTML = data.length
    ? data.map((t) => `<div class="trending-item"><span>${t.adId}</span><span>рост ранга: +${t.rankChange}</span></div>`).join('')
    : '<p class="empty-note">Пока недостаточно истории (нужно 2+ сбора снепшотов).</p>';
}

async function renderWinning() {
  const data = await fetch(`/api/brands/${currentBrandId}/winning`).then((r) => r.json());
  $('#winning-tbody').innerHTML = data.map((r) => `
    <tr>
      <td>${(r.creative_body || '').slice(0, 60)}</td>
      <td>${r.activityDays} дн.</td>
      <td>${r.duplicates}</td>
      <td>${r.score}</td>
    </tr>`).join('') || '<tr><td colspan="4">Нет данных — собери снепшот.</td></tr>';
}

async function renderCreativeTests() {
  const data = await fetch(`/api/brands/${currentBrandId}/creative-tests`).then((r) => r.json());
  destroyChart('creativeTests');
  charts.creativeTests = new Chart($('#chart-creative-tests'), {
    type: 'bar',
    data: {
      labels: data.map((d) => d.day),
      datasets: [
        { label: 'Active', data: data.map((d) => d.active), backgroundColor: '#2ea56f' },
        { label: 'Inactive', data: data.map((d) => d.inactive), backgroundColor: '#c9c9c4' }
      ]
    },
    options: { scales: { x: { stacked: true }, y: { stacked: true } } }
  });
}

async function renderAdsGrid() {
  adsData = await fetch(`/api/brands/${currentBrandId}/ads`).then((r) => r.json());
  applyAdsFilters();
}

function applyAdsFilters() {
  const grid = $('#ads-grid');
  grid.innerHTML = '';
  const pagesById = Object.fromEntries(currentPages.map((p) => [p.id, p]));
  const filtered = adsData.filter((ad) => {
    if (adsStatusFilter === 'active' && !ad.is_active) return false;
    if (adsStatusFilter === 'inactive' && ad.is_active) return false;
    if (adsPageFilter !== 'all' && String(ad.ad_page_id) !== String(adsPageFilter)) return false;
    return true;
  });
  if (!filtered.length) { grid.innerHTML = '<p class="empty-note">Нет данных по выбранным фильтрам.</p>'; return; }
  for (const ad of filtered) {
    const page = pagesById[ad.ad_page_id];
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <header class="card__header">
        <span>${ad.format}</span>
        <span class="card__status ${ad.is_active ? 'card__status--active' : 'card__status--inactive'}">${ad.is_active ? 'active' : 'inactive'}</span>
      </header>
      ${page ? `<div class="card__page-name">${page.page_name || page.page_id}</div>` : ''}
      <div class="card__preview">${ad.thumbnail_url ? `<img class="card__thumb" src="${ad.thumbnail_url}" />` : 'нет превью'}</div>
      <p class="card__body">${(ad.creative_body || '').slice(0, 100)}</p>
      <dl class="card__meta">
        <div>${ad.activityDays ?? '—'} дн.</div>
        <div>${ad.duplicates} дублей</div>
        <div>reach: ${ad.eu_total_reach ?? '—'}</div>
      </dl>
      <footer class="card__footer">
        <a class="card__link" href="${ad.snapshot_url}" target="_blank" rel="noopener">Открыть ↗</a>
      </footer>`;
    grid.appendChild(card);
  }
}

$('#ads-status-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('.segmented__btn');
  if (!btn) return;
  adsStatusFilter = btn.dataset.status;
  $all('#ads-status-filter .segmented__btn').forEach((b) => b.classList.toggle('is-active', b === btn));
  applyAdsFilters();
});

$('#ads-page-filter').addEventListener('change', (e) => {
  adsPageFilter = e.target.value;
  renderPages(currentPages);
  applyAdsFilters();
});

// ---------- Быстрый поиск (независимая простая фича) ----------
$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  const countries = $('#countries').value.trim();
  const status = $all('input[name=status]').find((r) => r.checked).value;
  $('#results-status').textContent = 'Ищу...';
  $('#results-grid').innerHTML = '';
  try {
    const params = new URLSearchParams({ q, countries, status, limit: 25 });
    const data = await fetch(`/api/search?${params}`).then((r) => r.json());
    $('#results-title').textContent = `Результаты по «${q}»`;
    $('#results-status').textContent = `Найдено: ${data.ads.length}`;
    renderSearchGrid(data.ads);
  } catch (err) {
    $('#results-status').textContent = 'Ошибка: ' + err.message;
  }
});

function renderSearchGrid(ads) {
  const grid = $('#results-grid');
  const tpl = $('#card-template');
  grid.innerHTML = '';
  for (const ad of ads) {
    const node = tpl.content.cloneNode(true);
    node.querySelector('.card__page').textContent = ad.page_name || '—';
    const isActive = !ad.ad_delivery_stop_time;
    const statusEl = node.querySelector('.card__status');
    statusEl.textContent = isActive ? 'active' : 'inactive';
    statusEl.classList.add(isActive ? 'card__status--active' : 'card__status--inactive');
    node.querySelector('.card__body').textContent = (ad.ad_creative_bodies || [])[0] || '(без текста)';
    node.querySelector('.card__link').href = ad.ad_snapshot_url;

    const img = node.querySelector('.card__thumb');
    const toggle = node.querySelector('.card__preview-toggle');
    if (ad.thumbnail_url) {
      img.src = ad.thumbnail_url;
      img.hidden = false;
      toggle.textContent = ad.format === 'video' ? '▶ Видео — открыть' : 'Открыть полностью';
      img.addEventListener('click', () => window.open(ad.ad_snapshot_url, '_blank'));
    }
    toggle.addEventListener('click', () => window.open(ad.ad_snapshot_url, '_blank'));
    grid.appendChild(node);
  }
}

// ---------- Сбор данных: статус по Ad Page ----------
let jobsPollTimer = null;

function startJobsPolling() {
  renderJobs();
  if (jobsPollTimer) return;
  jobsPollTimer = setInterval(renderJobs, 2000);
}

function stopJobsPolling() {
  if (jobsPollTimer) { clearInterval(jobsPollTimer); jobsPollTimer = null; }
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('ru-RU');
}

async function renderJobs() {
  const jobs = await fetch('/api/jobs').then((r) => r.json());
  const list = $('#jobs-list');
  if (!jobs.length) { list.innerHTML = '<p class="empty-note">Ad Page ещё не добавлены ни в одном бренде.</p>'; return; }

  list.innerHTML = jobs.map((j) => {
    let statusHtml;
    if (j.status === 'running') {
      const progress = j.total ? `${j.processed} / ${j.total}` : 'ищу объявления...';
      statusHtml = `<span class="job-status job-status--running"><span class="job-spinner"></span>Собираю: ${progress}</span>`;
    } else if (j.status === 'success') {
      statusHtml = `<span class="job-status job-status--success">✓ Готово в ${formatTime(j.finishedAt)} · ${j.total} объявлений</span>`;
    } else if (j.status === 'error') {
      statusHtml = `<span class="job-status job-status--error">✕ Ошибка в ${formatTime(j.finishedAt)}: ${j.error || 'неизвестно'}</span>`;
    } else {
      statusHtml = '<span class="job-status job-status--idle">Сбор ещё не запускался в этой сессии сервера</span>';
    }

    const dataHtml = j.existingCount
      ? `<div class="job-row__data">В базе: ${j.existingCount} объявлений (посл. сбор ${formatDate(j.lastFetchDate)})</div>`
      : '<div class="job-row__data job-row__data--empty">В базе пока нет объявлений по этой странице</div>';

    const buttonHtml = j.status === 'running'
      ? ''
      : `<button type="button" class="btn btn--small job-row__refresh" data-page-id="${j.pageId}">↻ Собрать</button>`;

    return `
      <div class="job-row">
        <div class="job-row__names">
          <div class="job-row__brand">${j.brandName}</div>
          <div class="job-row__page">${j.pageName}</div>
          ${dataHtml}
        </div>
        <div class="job-row__right">
          ${statusHtml}
          ${buttonHtml}
        </div>
      </div>`;
  }).join('');
}

$('#jobs-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.job-row__refresh');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Запускаю...';
  await fetch(`/api/pages/${btn.dataset.pageId}/refresh`, { method: 'POST' });
  renderJobs();
});

// ---------- Аналитика: перформанс своих рекламных кабинетов ----------
const GRADE_BADGE_COLORS = {
  'Promising': { bg: '#e1bee7', color: '#4a148c' },
  'Test': { bg: '#ffe0b2', color: '#e65100' },
  'Scale': { bg: '#bbdefb', color: '#0d47a1' },
  'Alpha': { bg: '#c8e6c9', color: '#1b5e20' },
  'Bad': { bg: '#e6b8b8', color: '#7f0000' },
  'No purchases': { bg: '#ffcdd2', color: '#b71c1c' }
};

let analyticsInited = false;
let analyticsData = null;
let analyticsAccountFilter = 'all';
let analyticsGradeFilter = '';
let analyticsTypeFilter = '';
let analyticsFunnelFilter = '';
let analyticsNameFilter = '';
let analyticsSort = { key: 'spend', dir: 'desc' };
let analyticsVisibleCreatives = [];
let analyticsSubtab = 'creatives';
const analyticsSubtabLoaded = {};

function initAnalyticsView() {
  if (analyticsInited) return;
  analyticsInited = true;
  setAnalyticsPeriod(7);
  loadActiveSubtab();
}

function setAnalyticsPeriod(days) {
  const today = new Date();
  const from = new Date(today.getTime() - days * 86400000);
  $('#analytics-until').value = today.toISOString().slice(0, 10);
  $('#analytics-since').value = from.toISOString().slice(0, 10);
  $all('#analytics-period-presets .segmented__btn').forEach((b) => b.classList.toggle('is-active', +b.dataset.days === days));
}

function loadActiveSubtab() {
  const since = $('#analytics-since').value;
  const until = $('#analytics-until').value;
  if (analyticsSubtab === 'creatives') return loadAnalytics(since, until);
  if (analyticsSubtab === 'production') return loadProduction(since, until);
  if (analyticsSubtab === 'cp') return loadCp(since, until);
  if (analyticsSubtab === 'ua') return loadUa(since, until);
}

$('#analytics-subtabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  analyticsSubtab = btn.dataset.subtab;
  $all('#analytics-subtabs .tab').forEach((b) => b.classList.toggle('is-active', b === btn));
  $all('#view-analytics .tab-panel').forEach((p) => p.classList.toggle('is-active', p.id === `subtab-${analyticsSubtab}`));
  loadActiveSubtab();
});

$('#analytics-period-presets').addEventListener('click', (e) => {
  const btn = e.target.closest('.segmented__btn');
  if (!btn) return;
  setAnalyticsPeriod(+btn.dataset.days);
  loadActiveSubtab();
});

$('#analytics-filters').addEventListener('submit', (e) => {
  e.preventDefault();
  $all('#analytics-period-presets .segmented__btn').forEach((b) => b.classList.remove('is-active'));
  loadActiveSubtab();
});

async function loadAnalytics(since, until) {
  $('#analytics-status').textContent = 'Загружаю...';
  $('#analytics-summary').innerHTML = '';
  $('#analytics-account-chips').innerHTML = '';
  $('#analytics-tbody').innerHTML = '';
  try {
    const params = new URLSearchParams({ since, until });
    const resp = await fetch(`/api/analytics?${params}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Ошибка запроса');
    $('#analytics-status').textContent = '';
    analyticsData = data;
    analyticsAccountFilter = 'all';
    renderAnalyticsChips();
    populateFunnelFilter();
    renderAnalyticsView();
  } catch (err) {
    $('#analytics-status').textContent = 'Ошибка: ' + err.message;
  }
}

function populateFunnelFilter() {
  const funnels = [...new Set(analyticsData.overall.creatives.map((c) => c.funnel || '—'))].sort();
  const select = $('#analytics-funnel-filter');
  const current = select.value;
  select.innerHTML = '<option value="">Все воронки</option>' + funnels.map((f) => `<option value="${f}">${f}</option>`).join('');
  select.value = funnels.includes(current) ? current : '';
  analyticsFunnelFilter = select.value;
}

function money(n) {
  return n == null ? '—' : '$' + Math.round(n).toLocaleString('ru-RU');
}
function num(n) {
  return n == null ? '—' : Math.round(n).toLocaleString('ru-RU');
}
function pct(n) {
  return n == null ? '—' : (n * 100).toFixed(2) + '%';
}

function renderAnalyticsChips() {
  const chips = ['all', ...analyticsData.accounts];
  $('#analytics-account-chips').innerHTML = chips.map((name) => `
    <button type="button" class="page-chip${analyticsAccountFilter === name ? ' is-active' : ''}" data-account="${name}">
      ${name === 'all' ? 'Все аккаунты' : name}
    </button>`).join('');
}

$('#analytics-account-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.page-chip');
  if (!chip) return;
  analyticsAccountFilter = chip.dataset.account;
  renderAnalyticsChips();
  renderAnalyticsView();
});

$('#analytics-grade-filter').addEventListener('change', (e) => { analyticsGradeFilter = e.target.value; renderAnalyticsView(); });
$('#analytics-type-filter').addEventListener('change', (e) => { analyticsTypeFilter = e.target.value; renderAnalyticsView(); });
$('#analytics-funnel-filter').addEventListener('change', (e) => { analyticsFunnelFilter = e.target.value; renderAnalyticsView(); });
$('#analytics-name-filter').addEventListener('input', (e) => { analyticsNameFilter = e.target.value.toLowerCase(); renderAnalyticsView(); });

$('#analytics-table thead').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  analyticsSort = analyticsSort.key === key
    ? { key, dir: analyticsSort.dir === 'desc' ? 'asc' : 'desc' }
    : { key, dir: 'desc' };
  renderAnalyticsView();
});

function renderAnalyticsSummary(summary, count) {
  $('#analytics-summary').innerHTML = `
    <div class="panel-card"><h3>Расход</h3><p class="big-number">${money(summary.totalSpend)}</p></div>
    <div class="panel-card"><h3>Покупки</h3><p class="big-number">${summary.totalPurchases}</p></div>
    <div class="panel-card"><h3>CPA</h3><p class="big-number">${summary.overallCpa ? '$' + summary.overallCpa.toFixed(2) : '—'}</p></div>
    <div class="panel-card">
      <h3>Success Rate</h3>
      <p class="big-number">${Math.round(summary.successRate * 100)}%</p>
      <p class="hint">${summary.successCount} из ${count} креативов</p>
    </div>`;
}

function renderStatusBadge(c) {
  const total = c.totalCount ?? 1;
  const active = c.activeCount ?? 0;
  let bg, color, label;
  if (active === 0) { bg = '#e6b8b8'; color = '#7f0000'; label = 'Остановлен'; }
  else if (active === total) { bg = '#c8e6c9'; color = '#1b5e20'; label = 'Активен'; }
  else { bg = '#ffe0b2'; color = '#e65100'; label = `${active}/${total} активны`; }
  return `<span class="grade-badge" style="background:${bg};color:${color}">${label}</span>`;
}

function renderAnalyticsRow(c) {
  const badge = GRADE_BADGE_COLORS[c.grade] || { bg: '#eee', color: '#333' };
  const rowClass = 'grade-row--' + c.grade.replace(/\s+/g, '-');
  return `
    <tr class="${rowClass}">
      <td>${c.previewUrl ? `<img class="thumb" src="${c.previewUrl}" />` : ''}</td>
      <td class="analytics-table__name" title="${c.name}">${c.name}</td>
      <td>${c.type}</td>
      <td><span class="grade-badge" style="background:${badge.bg};color:${badge.color}">${c.grade}</span></td>
      <td>${c.funnel || '—'}</td>
      <td>${money(c.spend)}</td>
      <td>${c.purchases}</td>
      <td>${c.cpa ? '$' + c.cpa.toFixed(2) : '—'}</td>
      <td>${pct(c.ctr)}</td>
      <td>${num(c.impressions)}</td>
      <td>${num(c.reach)}</td>
      <td>${c.frequency.toFixed(1)}</td>
      <td>${num(c.clicks)}</td>
      <td>${num(c.uniqueClicks)}</td>
      <td>${num(c.linkClicks)}</td>
      <td>${num(c.landingViews)}</td>
      <td>${c.costPerLandingView ? '$' + c.costPerLandingView.toFixed(2) : '—'}</td>
      <td>${money(c.cpm)}</td>
      <td>${c.cpc ? '$' + c.cpc.toFixed(2) : '—'}</td>
      <td>${num(c.addToCart)}</td>
      <td>${num(c.leads)}</td>
      <td>${money(c.purchaseValue)}</td>
      <td>${c.videoPlays == null ? '—' : num(c.videoPlays)}</td>
      <td>${pct(c.hookRate)}</td>
      <td>${c.videoP25 == null ? '—' : num(c.videoP25)}</td>
      <td>${c.videoP50 == null ? '—' : num(c.videoP50)}</td>
      <td>${c.videoP75 == null ? '—' : num(c.videoP75)}</td>
      <td>${c.videoP100 == null ? '—' : num(c.videoP100)}</td>
      <td>${c.avgWatchTime == null ? '—' : c.avgWatchTime.toFixed(1) + 's'}</td>
      <td>${c.mergedCount > 1 ? '×' + c.mergedCount : '—'}</td>
      <td>${(c.accounts || []).join(' / ')}</td>
      <td>${c.campaignName}</td>
      <td>${renderStatusBadge(c)}</td>
    </tr>`;
}

function renderAnalyticsView() {
  if (!analyticsData) return;
  const source = analyticsAccountFilter === 'all'
    ? analyticsData.overall
    : analyticsData.byAccount[analyticsAccountFilter];

  renderAnalyticsSummary(source.summary, source.creatives.length);

  let creatives = source.creatives.filter((c) => {
    if (analyticsGradeFilter && c.grade !== analyticsGradeFilter) return false;
    if (analyticsTypeFilter && c.type !== analyticsTypeFilter) return false;
    if (analyticsFunnelFilter && (c.funnel || '—') !== analyticsFunnelFilter) return false;
    if (analyticsNameFilter && !c.name.toLowerCase().includes(analyticsNameFilter)) return false;
    return true;
  });

  const { key, dir } = analyticsSort;
  const GRADE_RANK = { 'Alpha': 5, 'Scale': 4, 'Test': 3, 'Promising': 2, 'Bad': 1, 'No purchases': 0 };
  creatives = [...creatives].sort((a, b) => {
    let cmp;
    if (key === 'grade') {
      cmp = (GRADE_RANK[a.grade] ?? -1) - (GRADE_RANK[b.grade] ?? -1);
    } else {
      const av = a[key]; const bv = b[key];
      if (typeof av === 'string' || typeof bv === 'string') cmp = String(av ?? '').localeCompare(String(bv ?? ''));
      else cmp = (av ?? -Infinity) - (bv ?? -Infinity);
    }
    return dir === 'asc' ? cmp : -cmp;
  });

  $all('#analytics-table th[data-sort]').forEach((th) => th.classList.toggle('is-sorted', th.dataset.sort === key));
  $('#analytics-tbody').innerHTML = creatives.length
    ? creatives.map(renderAnalyticsRow).join('')
    : '<tr><td colspan="34" class="empty-note">Нет данных по выбранным фильтрам.</td></tr>';

  analyticsVisibleCreatives = creatives;
  syncAnalyticsStickyOffset();
}

function syncAnalyticsStickyOffset() {
  const wrapper = $('#analytics-sticky-top');
  if (!wrapper) return;
  requestAnimationFrame(() => {
    document.documentElement.style.setProperty('--analytics-sticky-offset', wrapper.getBoundingClientRect().height + 'px');
  });
}

const ANALYTICS_CSV_COLUMNS = [
  ['Название', (c) => c.name],
  ['Тип', (c) => c.type],
  ['Активных копий', (c) => `${c.activeCount ?? 0}/${c.totalCount ?? 1}`],
  ['Grade', (c) => c.grade],
  ['Funnel', (c) => c.funnel || ''],
  ['Spend', (c) => c.spend],
  ['Purchases', (c) => c.purchases],
  ['CPA', (c) => c.cpa ?? ''],
  ['CTR', (c) => c.ctr],
  ['Impressions', (c) => c.impressions],
  ['Reach', (c) => c.reach],
  ['Frequency', (c) => c.frequency],
  ['Clicks', (c) => c.clicks],
  ['Unique Clicks', (c) => c.uniqueClicks],
  ['Link Clicks', (c) => c.linkClicks],
  ['Landing Views', (c) => c.landingViews],
  ['Cost per Landing View', (c) => c.costPerLandingView ?? ''],
  ['CPM', (c) => c.cpm],
  ['CPC', (c) => c.cpc ?? ''],
  ['Add to Cart', (c) => c.addToCart],
  ['Leads', (c) => c.leads],
  ['Purchase Value', (c) => c.purchaseValue],
  ['Video Plays', (c) => c.videoPlays ?? ''],
  ['Hook Rate', (c) => c.hookRate ?? ''],
  ['Video 25%', (c) => c.videoP25 ?? ''],
  ['Video 50%', (c) => c.videoP50 ?? ''],
  ['Video 75%', (c) => c.videoP75 ?? ''],
  ['Video 100%', (c) => c.videoP100 ?? ''],
  ['Avg Watch Time', (c) => c.avgWatchTime ?? ''],
  ['Копий', (c) => c.mergedCount],
  ['Аккаунты', (c) => (c.accounts || []).join(' / ')],
  ['Campaign Name', (c) => c.campaignName]
];

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function downloadAnalyticsCsv() {
  const header = ANALYTICS_CSV_COLUMNS.map(([label]) => csvCell(label)).join(',');
  const rows = analyticsVisibleCreatives.map((c) => ANALYTICS_CSV_COLUMNS.map(([, get]) => csvCell(get(c))).join(','));
  const csv = '﻿' + [header, ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const label = analyticsAccountFilter === 'all' ? 'all-accounts' : analyticsAccountFilter;
  a.href = url;
  a.download = `analytics_${label}_${$('#analytics-since').value}_${$('#analytics-until').value}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

$('#analytics-download-btn').addEventListener('click', downloadAnalyticsCsv);

// ---------- Продакшн / CP / Утилизация (Airtable) ----------
async function fetchJson(url) {
  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

function renderGenericStackedBar(barSel, legendSel, segments) {
  const total = segments.reduce((s, seg) => s + seg.value, 0) || 1;
  $(barSel).innerHTML = segments
    .filter((s) => s.value > 0)
    .map((s) => `<span class="stacked-bar__seg" style="width:${(s.value / total) * 100}%;background:${s.color}"></span>`)
    .join('');
  $(legendSel).innerHTML = segments
    .map((s) => `<span><span class="stacked-bar__dot" style="background:${s.color}"></span>${s.label} ${Math.round((s.value / total) * 100)}%</span>`)
    .join('');
}

async function loadProduction(since, until) {
  $('#analytics-status').textContent = 'Загружаю...';
  try {
    const data = await fetchJson(`/api/analytics/production?${new URLSearchParams({ since, until })}`);
    $('#analytics-status').textContent = '';

    const pctHtml = data.pctChange === null ? ''
      : `<span class="big-number__pct ${data.pctChange >= 0 ? 'big-number__pct--up' : 'big-number__pct--down'}">${data.pctChange >= 0 ? '↗' : '↘'}${data.pctChange}%</span>`;
    $('#production-number').innerHTML = `${data.total}${pctHtml}`;

    destroyChart('productionByDay');
    charts.productionByDay = new Chart($('#chart-production-by-day'), {
      type: 'line',
      data: { labels: data.byDay.map((d) => d.day), datasets: [{ label: 'Задач', data: data.byDay.map((d) => d.count), borderColor: '#d95f2b', tension: 0.3 }] },
      options: { plugins: { legend: { display: false } } }
    });

    renderGenericStackedBar('#production-launched-bar', '#production-launched-legend', [
      { label: 'Напущено', value: data.launched, color: '#2ea56f' },
      { label: 'Ещё нет', value: data.notLaunched, color: '#c9c9c4' }
    ]);

    renderBarList('#production-designer-bars', data.byDesigner);
    renderBarList('#production-funnel-bars', data.byFunnel);
  } catch (err) {
    $('#analytics-status').textContent = 'Ошибка: ' + err.message;
  }
}

function renderPctBigNumber(sel, total, pctChange) {
  const pctHtml = pctChange === null ? ''
    : `<span class="big-number__pct ${pctChange >= 0 ? 'big-number__pct--up' : 'big-number__pct--down'}">${pctChange >= 0 ? '↗' : '↘'}${pctChange}%</span>`;
  $(sel).innerHTML = `${total}${pctHtml}`;
}

// Общий рендер для CP и UA — обе метрики устроены одинаково (день/CP/формат),
// просто по разным полям-датам, поэтому и делаем не мешая друг другу.
function renderDailyReport(prefix, data) {
  renderPctBigNumber(`#${prefix}-number`, data.total, data.pctChange);

  destroyChart(prefix + 'ByDay');
  charts[prefix + 'ByDay'] = new Chart($(`#chart-${prefix}-by-day`), {
    type: 'bar',
    data: { labels: data.byDay.map((d) => d.day), datasets: [{ label: 'Задач', data: data.byDay.map((d) => d.count), backgroundColor: '#d95f2b' }] },
    options: { plugins: { legend: { display: false } } }
  });

  renderGenericStackedBar(`#${prefix}-format-bar`, `#${prefix}-format-legend`, [
    { label: 'Video', value: data.video, color: '#2ea56f' },
    { label: 'Static', value: data.static, color: '#d95f2b' }
  ]);

  renderBarList(`#${prefix}-bars`, data.byCp);
}

async function loadCp(since, until) {
  $('#analytics-status').textContent = 'Загружаю...';
  try {
    const data = await fetchJson(`/api/analytics/cp?${new URLSearchParams({ since, until })}`);
    $('#analytics-status').textContent = '';
    renderDailyReport('cp', data);
  } catch (err) {
    $('#analytics-status').textContent = 'Ошибка: ' + err.message;
  }
}

async function loadUa(since, until) {
  $('#analytics-status').textContent = 'Загружаю...';
  try {
    const data = await fetchJson(`/api/analytics/ua?${new URLSearchParams({ since, until })}`);
    $('#analytics-status').textContent = '';
    renderDailyReport('ua', data);
  } catch (err) {
    $('#analytics-status').textContent = 'Ошибка: ' + err.message;
  }
}

// ---------- Старт ----------
loadBrands();
