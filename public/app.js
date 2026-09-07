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

function initAnalyticsView() {
  if (analyticsInited) return;
  analyticsInited = true;
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  $('#analytics-until').value = today.toISOString().slice(0, 10);
  $('#analytics-since').value = weekAgo.toISOString().slice(0, 10);
  loadAnalytics($('#analytics-since').value, $('#analytics-until').value);
}

$('#analytics-filters').addEventListener('submit', (e) => {
  e.preventDefault();
  loadAnalytics($('#analytics-since').value, $('#analytics-until').value);
});

async function loadAnalytics(since, until) {
  $('#analytics-status').textContent = 'Загружаю...';
  $('#analytics-content').innerHTML = '';
  try {
    const params = new URLSearchParams({ since, until });
    const resp = await fetch(`/api/analytics?${params}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Ошибка запроса');
    $('#analytics-status').textContent = '';
    renderAnalytics(data);
  } catch (err) {
    $('#analytics-status').textContent = 'Ошибка: ' + err.message;
  }
}

function money(n) {
  return n == null ? '—' : '$' + Math.round(n).toLocaleString('ru-RU');
}

function renderAnalyticsSummary(summary, count) {
  return `
    <div class="panel-grid analytics-summary">
      <div class="panel-card"><h3>Расход</h3><p class="big-number">${money(summary.totalSpend)}</p></div>
      <div class="panel-card"><h3>Покупки</h3><p class="big-number">${summary.totalPurchases}</p></div>
      <div class="panel-card"><h3>CPA</h3><p class="big-number">${summary.overallCpa ? '$' + summary.overallCpa.toFixed(2) : '—'}</p></div>
      <div class="panel-card">
        <h3>Success Rate</h3>
        <p class="big-number">${Math.round(summary.successRate * 100)}%</p>
        <p class="hint">${summary.successCount} из ${count} креативов</p>
      </div>
    </div>`;
}

function renderCreativeCard(c) {
  const badge = GRADE_BADGE_COLORS[c.grade] || { bg: '#eee', color: '#333' };
  const extras = [];
  if (c.mergedCount > 1) extras.push(`<div>×${c.mergedCount} копий</div>`);
  if (c.accounts?.length > 1) extras.push(`<div>${c.accounts.join(' / ')}</div>`);
  return `
    <article class="card">
      <header class="card__header">
        <span>${c.name}</span>
        <span class="grade-badge" style="background:${badge.bg};color:${badge.color}">${c.grade}</span>
      </header>
      <div class="card__preview">${c.previewUrl ? `<img class="card__thumb" src="${c.previewUrl}" />` : 'нет превью'}</div>
      <dl class="card__meta card__meta--wide">
        <div>Spend: ${money(c.spend)}</div>
        <div>Purchases: ${c.purchases}</div>
        <div>CPA: ${c.cpa ? '$' + c.cpa.toFixed(2) : '—'}</div>
        <div>CTR: ${(c.ctr * 100).toFixed(2)}%</div>
        ${extras.join('')}
      </dl>
    </article>`;
}

function renderCreativeGrid(creatives) {
  if (!creatives.length) return '<p class="empty-note">Нет данных за выбранный период.</p>';
  return `<div class="grid grid--ads">${creatives.map(renderCreativeCard).join('')}</div>`;
}

function renderAnalytics(data) {
  let html = '<h2>Все креативы (все аккаунты)</h2>';
  html += renderAnalyticsSummary(data.overall.summary, data.overall.creatives.length);
  html += renderCreativeGrid(data.overall.creatives);

  for (const accName of data.accounts) {
    const acc = data.byAccount[accName];
    html += `<h2 class="analytics-account-heading">${accName}</h2>`;
    html += renderAnalyticsSummary(acc.summary, acc.creatives.length);
    html += renderCreativeGrid(acc.creatives);
  }
  $('#analytics-content').innerHTML = html;
}

// ---------- Старт ----------
loadBrands();
