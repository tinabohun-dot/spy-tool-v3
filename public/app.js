const API = '';
let currentBrandId = null;
let currentBrand = null;
let currentPages = [];
let charts = {};
let adsData = [];
let adsPageFilter = 'all';
let adsSort = 'lastSeen';
let metricsPeriodDays = 7;

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }

// ---------- Редактор тегов (переиспользуется в модалках бренда и страницы) ----------
// Держит массив тегов в замыкании и перерисовывает чипы сам — вызывающему
// коду достаточно один раз инициализировать и потом просто прочитать getTags().
function initTagEditor(chipsEl, inputEl, initialTags = []) {
  let tags = [...initialTags];
  function render() {
    chipsEl.innerHTML = tags.map((t, i) => `
      <span class="tag-editor__chip">${t}<button type="button" data-i="${i}">×</button></span>
    `).join('');
  }
  chipsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-i]');
    if (!btn) return;
    tags.splice(+btn.dataset.i, 1);
    render();
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const tag = inputEl.value.trim();
    if (tag && !tags.includes(tag)) tags.push(tag);
    inputEl.value = '';
    render();
  });
  render();
  return { getTags: () => tags };
}

// ---------- Навигация ----------
$all('.side-nav__item').forEach((btn) => {
  btn.addEventListener('click', () => {
    $all('.side-nav__item').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    const view = btn.dataset.view;
    $('#view-library').hidden = view !== 'library';
    $('#view-jobs').hidden = view !== 'jobs';
    $('#view-analytics').hidden = view !== 'analytics';
    $('#view-sr').hidden = view !== 'sr';
    $('#view-ret').hidden = view !== 'ret';
    $('#view-brand').hidden = true;
    if (view === 'jobs') startJobsPolling(); else stopJobsPolling();
    if (view === 'analytics') initAnalyticsView();
    if (view === 'sr') initSrView();
    if (view === 'ret') initRetView();
  });
});

$('#back-to-library').addEventListener('click', () => {
  $('#view-brand').hidden = true;
  $('#view-library').hidden = false;
});

$('#edit-brand-btn').addEventListener('click', () => openEditBrandDialog(currentBrand));
$('#delete-brand-btn').addEventListener('click', async () => {
  if (!(await deleteBrand(currentBrand))) return;
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

function renderTagChips(tags) {
  return (tags || []).map((t) => `<span class="tag-chip">${t}</span>`).join('');
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
        <div class="brand-card__actions">
          <button type="button" class="brand-card__action brand-card__action--edit" title="Редактировать">✎</button>
          <button type="button" class="brand-card__action brand-card__action--danger" title="Удалить">✕</button>
        </div>
      </div>
      ${b.tags?.length ? `<div class="tag-chips">${renderTagChips(b.tags)}</div>` : ''}
      <div class="brand-card__stats">
        <span class="brand-card__count">
          <span class="brand-card__dot ${active > 0 ? 'is-active' : ''}"></span>
          ${active} / ${total} active ads
        </span>
        <span class="brand-card__platform">∞</span>
      </div>
    `;
    card.addEventListener('click', () => openBrand(b));
    $('.brand-card__action--edit', card).addEventListener('click', (e) => { e.stopPropagation(); openEditBrandDialog(b); });
    $('.brand-card__action--danger', card).addEventListener('click', (e) => { e.stopPropagation(); deleteBrand(b); });
    grid.appendChild(card);
  }
}

$('#brand-search').addEventListener('input', renderBrandsGrid);
$('#category-filter').addEventListener('change', renderBrandsGrid);

// ---------- Ad Library: Scaling (топ креативов по всем брендам сразу) ----------
$('#scaling-pill').addEventListener('click', () => {
  $('#scaling-pill').classList.add('is-active');
  $('#tracked-count-pill').classList.remove('is-active');
  $('#brands-grid').hidden = true;
  $('#scaling-view').hidden = false;
  loadScaling();
});

$('#tracked-count-pill').addEventListener('click', () => {
  $('#tracked-count-pill').classList.add('is-active');
  $('#scaling-pill').classList.remove('is-active');
  $('#scaling-view').hidden = true;
  $('#brands-grid').hidden = false;
});

async function loadScaling() {
  const rows = await fetch('/api/scaling').then((r) => r.json());
  $('#scaling-tbody').innerHTML = rows.length ? rows.map((r) => `
    <tr>
      <td>${r.thumbnail_url ? `<img class="thumb" src="${r.thumbnail_url}" />` : ''}</td>
      <td>${r.brandName}</td>
      <td>${(r.creative_body || '').slice(0, 80)}</td>
      <td>${r.duplicates}</td>
      <td>${(r.totalReach || 0).toLocaleString('ru-RU')}</td>
      <td>${r.score}</td>
      <td><a class="card__link" href="${r.snapshot_url}" target="_blank" rel="noopener">Открыть ↗</a></td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty-note">Пока нет активных креативов с дублями — собери снепшоты по брендам.</td></tr>';
}

$all('[data-close]').forEach((b) => b.addEventListener('click', (e) => e.target.closest('dialog').close()));

// Одна и та же модалка используется и для создания, и для редактирования —
// editingBrandId === null значит "создаём новый".
let editingBrandId = null;
let brandTagEditor = null;

function openAddBrandDialog() {
  editingBrandId = null;
  $('#add-brand-title').textContent = 'Новый бренд';
  $('#add-brand-submit').textContent = 'Создать';
  $('#new-brand-name').value = '';
  $('#new-brand-category').value = '';
  brandTagEditor = initTagEditor($('#brand-tags-chips'), $('#brand-tags-input'), []);
  $('#add-brand-dialog').showModal();
}

function openEditBrandDialog(brand) {
  editingBrandId = brand.id;
  $('#add-brand-title').textContent = 'Редактировать бренд';
  $('#add-brand-submit').textContent = 'Сохранить';
  $('#new-brand-name').value = brand.name;
  $('#new-brand-category').value = brand.category || '';
  brandTagEditor = initTagEditor($('#brand-tags-chips'), $('#brand-tags-input'), brand.tags || []);
  $('#add-brand-dialog').showModal();
}

async function deleteBrand(brand) {
  if (!confirm(`Удалить бренд "${brand.name}" вместе со всеми его страницами и собранными объявлениями? Это необратимо.`)) return false;
  await fetch(`/api/brands/${brand.id}`, { method: 'DELETE' });
  loadBrands();
  return true;
}

$('#add-brand-btn').addEventListener('click', openAddBrandDialog);

$('#add-brand-form').addEventListener('submit', async (e) => {
  const name = $('#new-brand-name').value.trim();
  const category = $('#new-brand-category').value.trim();
  const tags = brandTagEditor.getTags();
  if (!name) return;
  if (editingBrandId) {
    const updated = await fetch(`/api/brands/${editingBrandId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category, tags })
    }).then((r) => r.json());
    // Если редактировали бренд, чья карточка сейчас открыта — обновляем и её,
    // а не только список брендов на предыдущем экране.
    if (currentBrandId === editingBrandId) {
      currentBrand = { ...currentBrand, ...updated };
      $('#brand-title').textContent = currentBrand.name;
      $('#brand-sub').textContent = currentBrand.category || '';
      $('#brand-tags-view').innerHTML = renderTagChips(currentBrand.tags);
    }
  } else {
    await fetch('/api/brands', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category, tags })
    });
  }
  loadBrands();
});

// ---------- Карточка бренда ----------
async function openBrand(brand) {
  currentBrandId = brand.id;
  currentBrand = brand;
  currentPages = brand.pages;
  adsPageFilter = 'all';
  adsSort = 'lastSeen';
  metricsPeriodDays = 7;
  $('#metrics-period').value = '7';
  $('#view-library').hidden = true;
  $('#view-brand').hidden = false;
  $('#brand-title').textContent = brand.name;
  $('#brand-sub').textContent = brand.category || '';
  $('#brand-tags-view').innerHTML = renderTagChips(brand.tags);
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
    const days = $('#collect-period').value;
    await fetch(`/api/brands/${currentBrandId}/refresh?days=${days}`, { method: 'POST' });
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
  const data = await fetch(`/api/brands/${currentBrandId}/metrics?days=${metricsPeriodDays}`).then((r) => r.json());
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

  const { current, pctChange } = data.adsPublished;
  const pctHtml = pctChange === null ? ''
    : `<span class="big-number__pct ${pctChange >= 0 ? 'big-number__pct--up' : 'big-number__pct--down'}">${pctChange >= 0 ? '↗' : '↘'}${pctChange}%</span>`;
  $('#ads-published-number').innerHTML = `${current}${pctHtml}`;

  renderFormatBar(data.formatCount);
  renderBarList('#destination-bars', data.destinations, true, { asLink: true });
  renderBarList('#lang-bars', data.languages);
  renderBarList('#platform-bars', data.platforms);
}

$('#metrics-period').addEventListener('change', (e) => {
  metricsPeriodDays = +e.target.value;
  renderMetrics();
});

const FORMAT_COLORS = { image: '#d95f2b', video: '#2ea56f', unknown: '#c9c9c4', removed: '#8d8d86' };
const FORMAT_LABELS = { removed: 'аккаунт отключён' };

function renderFormatBar(formatCount) {
  const order = ['image', 'video', 'unknown', 'removed'];
  const total = order.reduce((s, k) => s + (formatCount[k] || 0), 0) || 1;
  $('#format-stacked-bar').innerHTML = order
    .filter((k) => formatCount[k])
    .map((k) => `<span class="stacked-bar__seg" style="width:${(formatCount[k] / total) * 100}%;background:${FORMAT_COLORS[k]}"></span>`)
    .join('');
  $('#format-legend').innerHTML = order
    .filter((k) => formatCount[k])
    .map((k) => `<span><span class="stacked-bar__dot" style="background:${FORMAT_COLORS[k]}"></span>${FORMAT_LABELS[k] || k} ${Math.round((formatCount[k] || 0) / total * 100)}%</span>`)
    .join('');
}

const CATEGORY_COLORS = [
  '#4285f4', '#2ea56f', '#f4b400', '#d95f2b', '#a142f4',
  '#00acc1', '#e91e8c', '#8d6e63', '#607d8b', '#c9a227'
];

// Как renderBarList, но каждая строка кликабельна и разворачивает список
// конкретных задач (Task ID + название), которые попали в счётчик этого
// человека — чтобы можно было сверить цифру со списком задач в Airtable.
function renderBarListWithTasks(sel, counts, tasksByKey) {
  let entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map((e) => e[1]));
  $(sel).innerHTML = entries.map(([label, val], i) => {
    const tasks = tasksByKey?.[label] || [];
    const taskList = tasks.map((t) => `<li>${t.taskId != null ? `#${t.taskId}` : ''} ${t.taskName || ''}</li>`).join('');
    return `
      <div class="bar-row bar-row--expandable" data-key="${label}">
        <span class="bar-row__label">${label}</span>
        <span class="bar-row__track"><span class="bar-row__fill" style="width:${(val / max) * 100}%;background:${CATEGORY_COLORS[i % CATEGORY_COLORS.length]}"></span></span>
        <span class="bar-row__value">${val}</span>
      </div>
      <ul class="bar-row__tasks" hidden>${taskList}</ul>`;
  }).join('') || '<p class="hint">Пока нет данных</p>';
}

document.addEventListener('click', (e) => {
  const row = e.target.closest('.bar-row--expandable');
  if (!row) return;
  const list = row.nextElementSibling;
  if (list && list.classList.contains('bar-row__tasks')) list.hidden = !list.hidden;
});

function formatTag(creoType) {
  if (creoType === 'Video') return '<span class="fmt-tag fmt-tag--video">V</span> ';
  if (creoType === 'Static') return '<span class="fmt-tag fmt-tag--static">S</span> ';
  if (creoType === 'Longread') return '<span class="fmt-tag fmt-tag--longread">L</span> ';
  return '';
}

function formatSummary(tasks) {
  const v = tasks.filter((t) => t.creoType === 'Video').length;
  const st = tasks.filter((t) => t.creoType === 'Static').length;
  const l = tasks.filter((t) => t.creoType === 'Longread').length;
  const parts = [];
  if (v) parts.push(`${v} видео`);
  if (st) parts.push(`${st} статика`);
  if (l) parts.push(`${l} лонгрид`);
  return parts.length ? `(${parts.join(' · ')})` : '';
}

// Как renderBarListWithTasks, но список задач при разворачивании
// сгруппирован по дням (для "По воронке" в UA — период может быть
// многодневным, и важно видеть, сколько и какие номера ушли именно в
// какой день, а не единым списком).
function renderFunnelBarWithDayGroups(sel, byFunnel, tasksByDayPerFunnel) {
  const entries = Object.entries(byFunnel).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map((e) => e[1]));
  $(sel).innerHTML = entries.map(([funnel, val], i) => {
    const byDay = tasksByDayPerFunnel?.[funnel] || {};
    const days = Object.keys(byDay).sort();
    const groups = days.map((day) => {
      const tasks = byDay[day];
      const items = tasks.map((t) => `<li>${formatTag(t.creoType)}${t.taskId != null ? `#${t.taskId}` : ''} ${t.taskName || ''}</li>`).join('');
      return `<li class="bar-row__day-group"><strong>${day} — ${tasks.length} шт.</strong> <span class="bar-row__fmt-summary">${formatSummary(tasks)}</span><ul>${items}</ul></li>`;
    }).join('');
    return `
      <div class="bar-row bar-row--expandable" data-key="${funnel}">
        <span class="bar-row__label">${funnel}</span>
        <span class="bar-row__track"><span class="bar-row__fill" style="width:${(val / max) * 100}%;background:${CATEGORY_COLORS[i % CATEGORY_COLORS.length]}"></span></span>
        <span class="bar-row__value">${val}</span>
      </div>
      <ul class="bar-row__tasks" hidden>${groups}</ul>`;
  }).join('') || '<p class="hint">Пока нет данных</p>';
}

// Формат (Video/Static) с кликабельной легендой — показывает список
// конкретных задач того формата в отдельном списке под ней.
function renderFormatWithTasks(barSel, legendSel, tasksSel, formatTasks) {
  const video = formatTasks.Video || [];
  const staticTasks = formatTasks.Static || [];
  const longreadTasks = formatTasks.Longread || [];
  renderGenericStackedBar(barSel, legendSel, [
    { label: 'Video', value: video.length, color: '#2ea56f' },
    { label: 'Static', value: staticTasks.length, color: '#d95f2b' },
    { label: 'Longread', value: longreadTasks.length, color: '#4285f4' }
  ]);
  const byLabel = { Video: video, Static: staticTasks, Longread: longreadTasks };
  const taskListEl = $(tasksSel);
  taskListEl.hidden = true;
  $all('span', $(legendSel)).forEach((span) => {
    const label = span.textContent.trim().split(' ')[0];
    const tasks = byLabel[label];
    if (!tasks) return;
    span.addEventListener('click', () => {
      const alreadyShowingThis = !taskListEl.hidden && taskListEl.dataset.label === label;
      if (alreadyShowingThis) { taskListEl.hidden = true; return; }
      taskListEl.dataset.label = label;
      taskListEl.innerHTML = tasks.map((t) => `<li>${t.taskId != null ? `#${t.taskId}` : ''} ${t.taskName || ''}</li>`).join('') || '<li>Нет задач</li>';
      taskListEl.hidden = false;
    });
  });
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function renderBarList(sel, obj, sortByValue = true, opts = {}) {
  let entries = Object.entries(obj);
  entries = sortByValue ? entries.sort((a, b) => b[1] - a[1]).slice(0, 8) : entries;
  const max = Math.max(1, ...entries.map((e) => e[1]));
  $(sel).innerHTML = entries.map(([label, val], i) => `
    <div class="bar-row">
      <span class="bar-row__label">${opts.asLink && DOMAIN_RE.test(label) ? `<a href="https://${label}" target="_blank" rel="noopener">${label} ↗</a>` : label}</span>
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

const ADS_SORTERS = {
  lastSeen: (ad) => ad.delivery_start || '',
  duration: (ad) => ad.activityDays ?? -1,
  euReach: (ad) => ad.eu_total_reach ?? -1,
  duplicates: (ad) => ad.duplicates ?? 0
};

function applyAdsFilters() {
  const grid = $('#ads-grid');
  grid.innerHTML = '';
  const pagesById = Object.fromEntries(currentPages.map((p) => [p.id, p]));

  // "Все креативы" показывает только то, что реально сейчас в эфире и уже
  // прошло минимальную обкатку — неактивные и совсем свежие (меньше 3 дней)
  // запуски только шумят списком тестов. Полную картину по всем запускам
  // (включая неактивные) даёт вкладка Creative tests — её эти фильтры не
  // затрагивают, у неё свой источник данных.
  const filtered = adsData.filter((ad) => {
    if (!ad.is_active) return false;
    if ((ad.activityDays ?? 0) < 3) return false;
    if (adsPageFilter !== 'all' && String(ad.ad_page_id) !== String(adsPageFilter)) return false;
    return true;
  });
  const getSortValue = ADS_SORTERS[adsSort] || ADS_SORTERS.lastSeen;
  filtered.sort((a, b) => {
    const av = getSortValue(a); const bv = getSortValue(b);
    return av < bv ? 1 : av > bv ? -1 : 0;
  });
  if (!filtered.length) { grid.innerHTML = '<p class="empty-note">Нет данных по выбранным фильтрам.</p>'; return; }
  for (const ad of filtered) {
    const page = pagesById[ad.ad_page_id];
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <header class="card__header">
        <span>${ad.format === 'removed' ? 'аккаунт отключён' : ad.format}</span>
        <span class="card__status ${ad.is_active ? 'card__status--active' : 'card__status--inactive'}">${ad.is_active ? 'active' : 'inactive'}</span>
      </header>
      ${page ? `<div class="card__page-name">${page.page_name || page.page_id}</div>` : ''}
      <div class="card__preview">${ad.thumbnail_url ? `<img class="card__thumb" src="${ad.thumbnail_url}" />` : (ad.format === 'removed' ? 'превью недоступно — Meta отключила аккаунт/страницу за нарушение рекламных стандартов' : 'нет превью')}</div>
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

$('#ads-page-filter').addEventListener('change', (e) => {
  adsPageFilter = e.target.value;
  renderPages(currentPages);
  applyAdsFilters();
});

$('#ads-sort').addEventListener('change', (e) => {
  adsSort = e.target.value;
  applyAdsFilters();
});

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

let currentJobs = [];

async function renderJobs() {
  const jobs = await fetch('/api/jobs').then((r) => r.json());
  currentJobs = jobs;
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
    const tagsHtml = j.tags?.length ? `<div class="job-row__tags tag-chips">${renderTagChips(j.tags)}</div>` : '';

    const buttonHtml = j.status === 'running'
      ? ''
      : `<button type="button" class="btn btn--small job-row__refresh" data-page-id="${j.pageId}">↻ Собрать</button>`;

    return `
      <div class="job-row">
        <div class="job-row__names">
          <div class="job-row__brand">${j.brandName}</div>
          <div class="job-row__page">${j.pageName}</div>
          ${dataHtml}
          ${tagsHtml}
        </div>
        <div class="job-row__right">
          ${statusHtml}
          ${buttonHtml}
          <button type="button" class="btn btn--small job-row__edit" data-page-id="${j.pageId}">✎ Изменить</button>
          <button type="button" class="btn btn--small btn--danger job-row__delete" data-page-id="${j.pageId}">✕ Удалить</button>
        </div>
      </div>`;
  }).join('');
}

$('#jobs-list').addEventListener('click', async (e) => {
  const refreshBtn = e.target.closest('.job-row__refresh');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Запускаю...';
    await fetch(`/api/pages/${refreshBtn.dataset.pageId}/refresh`, { method: 'POST' });
    renderJobs();
    return;
  }
  const deleteBtn = e.target.closest('.job-row__delete');
  if (deleteBtn) {
    const pageName = deleteBtn.closest('.job-row').querySelector('.job-row__page').textContent;
    if (!confirm(`Удалить "${pageName}" вместе со всеми собранными по ней объявлениями? Это необратимо.`)) return;
    deleteBtn.disabled = true;
    await fetch(`/api/pages/${deleteBtn.dataset.pageId}`, { method: 'DELETE' });
    renderJobs();
    return;
  }
  const editBtn = e.target.closest('.job-row__edit');
  if (editBtn) {
    const job = currentJobs.find((j) => String(j.pageId) === editBtn.dataset.pageId);
    if (job) openEditPageDialog(job);
  }
});

let editingPageId = null;
let pageTagEditor = null;

function openEditPageDialog(job) {
  editingPageId = job.pageId;
  $('#edit-page-name').value = job.pageName || '';
  pageTagEditor = initTagEditor($('#page-tags-chips'), $('#page-tags-input'), job.tags || []);
  $('#edit-page-dialog').showModal();
}

$('#edit-page-form').addEventListener('submit', async (e) => {
  const page_name = $('#edit-page-name').value.trim();
  const tags = pageTagEditor.getTags();
  await fetch(`/api/pages/${editingPageId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_name, tags })
  });
  renderJobs();
});

// ---------- Аналитика: перформанс своих рекламных кабинетов ----------
const GRADE_BADGE_COLORS = {
  'Promising': { bg: '#e1bee7', color: '#4a148c' },
  'Test': { bg: '#ffe0b2', color: '#e65100' },
  'Scale': { bg: '#bbdefb', color: '#0d47a1' },
  'Alpha': { bg: '#c8e6c9', color: '#1b5e20' },
  'Bedolaga': { bg: '#e6b8b8', color: '#7f0000' }
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
// Мультивыбор в пределах каждого измерения (несколько стран, несколько
// возрастов и т.д. одновременно) — но гео нельзя совместить с возрастом/
// гендером, это ограничение самого Meta API (см. fetchAllAccountsInsightsBreakdown),
// а не что-то, что можно снять на фронте.
let audienceFilter = { gender: [], age: [], country: [] };
let audienceSort = { key: 'spend', dir: 'desc' };
const analyticsSubtabLoaded = {};

function initAnalyticsView() {
  if (analyticsInited) return;
  analyticsInited = true;
  setAnalyticsPeriod(0);
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
  if (analyticsSubtab === 'tops') return loadTops(since, until);
  if (analyticsSubtab === 'formats') return loadFormats(since, until);
  if (analyticsSubtab === 'users') return loadUsers(since, until);
  if (analyticsSubtab === 'audience') return loadAudience(since, until);
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
  if (!btn || btn.id === 'analytics-closed-week-btn') return;
  setAnalyticsPeriod(+btn.dataset.days);
  loadActiveSubtab();
});

// "Закрытая неделя" — последняя полностью завершившаяся календарная неделя
// пн-вс (не скользящие 7 дней): если сегодня, скажем, вторник 22.09, ближайший
// понедельник — 21.09, а закрытая неделя — та, что перед ним, 14.09-20.09.
function setClosedWeekPeriod() {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=вс, 1=пн, ... 6=сб
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const thisMonday = new Date(today.getTime() - daysSinceMonday * 86400000);
  const closedWeekStart = new Date(thisMonday.getTime() - 7 * 86400000);
  const closedWeekEnd = new Date(thisMonday.getTime() - 1 * 86400000);
  $('#analytics-since').value = closedWeekStart.toISOString().slice(0, 10);
  $('#analytics-until').value = closedWeekEnd.toISOString().slice(0, 10);
  $all('#analytics-period-presets .segmented__btn').forEach((b) => b.classList.toggle('is-active', b.id === 'analytics-closed-week-btn'));
}

$('#analytics-closed-week-btn').addEventListener('click', () => {
  setClosedWeekPeriod();
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
    const campaignMode = $('#analytics-campaign-filter').value;
    if (campaignMode) params.set('campaignMode', campaignMode);
    if (analyticsCountryFilter.countries.length) {
      params.set('countries', analyticsCountryFilter.countries.join(','));
      params.set('countryMode', analyticsCountryFilter.mode);
    }
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

// Один креатив, объединённый из нескольких аккаунтов, может числиться сразу
// в нескольких воронках (c.funnel вида "Sensory Kid / Brain Activation") —
// список для фильтра строим по отдельным воронкам, а не по этим составным
// строкам целиком, иначе такой креатив нельзя было бы найти ни по одной из
// них.
function populateFunnelFilter() {
  const funnels = [...new Set(analyticsData.overall.creatives.flatMap((c) => (c.funnel || '—').split(' / ')))].sort();
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
// ---------- Фильтр по странам (include / exclude) ----------
// Один и тот же виджет используется в "Все креативы" и в Retention: id
// элементов строятся из префикса (country-toggle / ret-country-toggle ...).
let regionNames = null;
try { regionNames = new Intl.DisplayNames(['ru'], { type: 'region' }); } catch (e) { /* без названий — покажем коды */ }

function countryName(code) {
  try { return (regionNames && regionNames.of(code)) || code; } catch (e) { return code; }
}
function countryFlag(code) {
  if (!/^[A-Z]{2}$/.test(code)) return '🏳️';
  return String.fromCodePoint(...[...code].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65));
}

function setupCountryFilter({ prefix, getPeriod, onApply }) {
  const el = (name) => $(`#${prefix}-${name}`);
  const state = { countries: [], mode: 'include' };
  let pending = new Set();
  let options = { key: null, list: [] };

  function updateLabel() {
    const n = state.countries.length;
    el('toggle').textContent = n ? `🌍 выбрано: ${n} ▴` : '🌍 все страны ▴';
    el('toggle').classList.toggle('is-active', n > 0);
    el('note').hidden = n === 0;
  }

  function renderList() {
    const q = el('search').value.trim().toLowerCase();
    const rows = options.list
      .filter((c) => !q || countryName(c.code).toLowerCase().includes(q) || c.code.toLowerCase() === q)
      .map((c) => `<label class="country-row"><input type="checkbox" value="${c.code}" ${pending.has(c.code) ? 'checked' : ''} />
        <span>${countryFlag(c.code)} ${srEsc(countryName(c.code))}</span><span class="country-row__spend">${srMoney(c.spend)}</span></label>`);
    el('list').innerHTML = rows.join('') || '<p class="hint">Ничего не найдено</p>';
  }

  async function open() {
    pending = new Set(state.countries);
    el('popover').hidden = false;
    el('search').value = '';
    const { since, until } = getPeriod();
    const key = since + '|' + until;
    if (options.key !== key) {
      el('list').innerHTML = '<p class="hint">Загружаю страны...</p>';
      try {
        options = { key, list: await fetchJson(`/api/analytics/countries?${new URLSearchParams({ since, until })}`) };
      } catch (err) {
        el('list').innerHTML = `<p class="hint">Ошибка: ${srEsc(err.message)}</p>`;
        return;
      }
    }
    renderList();
  }
  const close = () => { el('popover').hidden = true; };

  el('toggle').addEventListener('click', () => { if (el('popover').hidden) open(); else close(); });
  el('close').addEventListener('click', close);
  el('search').addEventListener('input', renderList);
  el('list').addEventListener('change', (e) => {
    if (e.target.type !== 'checkbox') return;
    if (e.target.checked) pending.add(e.target.value); else pending.delete(e.target.value);
  });
  el('clear').addEventListener('click', () => { pending = new Set(); renderList(); });
  el('apply').addEventListener('click', () => {
    state.countries = [...pending];
    updateLabel();
    close();
    onApply();
  });
  el('mode').addEventListener('click', (e) => {
    const btn = e.target.closest('.segmented__btn');
    if (!btn) return;
    state.mode = btn.dataset.mode;
    $all(`#${prefix}-mode .segmented__btn`).forEach((b) => b.classList.toggle('is-active', b === btn));
    if (state.countries.length) onApply();
  });
  document.addEventListener('click', (e) => {
    if (!el('popover').hidden && !e.target.closest(`#${prefix}-filter`)) close();
  });
  return state;
}

const analyticsCountryFilter = setupCountryFilter({
  prefix: 'country',
  getPeriod: () => ({ since: $('#analytics-since').value, until: $('#analytics-until').value }),
  onApply: () => loadAnalytics($('#analytics-since').value, $('#analytics-until').value)
});

$('#analytics-campaign-filter').addEventListener('change', () => loadAnalytics($('#analytics-since').value, $('#analytics-until').value));
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
      <td>${c.previewUrl ? `<img class="thumb" src="${c.previewUrl}" data-ad-id="${c.adId}" data-ad-name="${c.name}" title="Кликни, чтобы посмотреть живое превью" />` : ''}</td>
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

// Клик по превьюшке — открыть живой рендер объявления с воспроизведением
// видео (как в самом Ads Manager), а не только статичную картинку
// thumbnail_url, которая и так уже в таблице.
async function openAdPreview(adId, adName) {
  $('#ad-preview-title').textContent = adName || '';
  $('#ad-preview-content').innerHTML = 'Загружаю превью...';
  $('#ad-preview-dialog').showModal();
  try {
    const resp = await fetch(`/api/marketing/ad-preview/${adId}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Ошибка запроса');
    $('#ad-preview-content').innerHTML = data.html;
  } catch (err) {
    $('#ad-preview-content').innerHTML = 'Не удалось загрузить превью: ' + err.message;
  }
}

for (const tbodyId of ['#analytics-tbody', '#tops-tbody', '#ret-tbody', '#drop-detail', '#viz-charts']) {
  $(tbodyId).addEventListener('click', (e) => {
    const img = e.target.closest('.thumb[data-ad-id]');
    if (!img) return;
    openAdPreview(img.dataset.adId, img.dataset.adName);
  });
}

const GRADE_RANK = { 'Alpha': 5, 'Scale': 4, 'Test': 3, 'Promising': 2, 'Bedolaga': 1 };

// Общая сортировка для любой таблицы креативов (Все креативы, Аудитория —
// обе рендерят один и тот же набор полей через renderAnalyticsRow), чтобы
// поведение клика по колонке было идентичным и не расходилось при правках.
function sortCreatives(creatives, { key, dir }) {
  return [...creatives].sort((a, b) => {
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
    if (analyticsFunnelFilter && !(c.funnel || '—').split(' / ').includes(analyticsFunnelFilter)) return false;
    if (analyticsNameFilter && !c.name.toLowerCase().includes(analyticsNameFilter)) return false;
    return true;
  });

  creatives = sortCreatives(creatives, analyticsSort);
  const { key } = analyticsSort;

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

const SUCCESS_GRADES = ['Promising', 'Test', 'Scale', 'Alpha'];

async function loadTops(since, until) {
  $('#analytics-status').textContent = 'Загружаю...';
  try {
    const params = new URLSearchParams({ since, until });
    const resp = await fetch(`/api/analytics?${params}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Ошибка запроса');
    $('#analytics-status').textContent = '';

    const tops = data.overall.creatives
      .filter((c) => SUCCESS_GRADES.includes(c.grade))
      .sort((a, b) => b.spend - a.spend);

    $('#tops-tbody').innerHTML = tops.length
      ? tops.map(renderAnalyticsRow).join('')
      : '<tr><td colspan="33" class="empty-note">Нет креативов с грейдом Promising и выше за период.</td></tr>';
  } catch (err) {
    $('#analytics-status').textContent = 'Ошибка: ' + err.message;
  }
}

$('#send-tops-slack-btn').addEventListener('click', async () => {
  const since = $('#analytics-since').value;
  const until = $('#analytics-until').value;
  const btn = $('#send-tops-slack-btn');
  const status = $('#send-tops-slack-status');
  if (!confirm(`Отправить в Slack все креативы Promising+ за ${since}–${until}?`)) return;
  btn.disabled = true;
  status.textContent = 'Отправляю...';
  try {
    const resp = await fetch('/api/slack/send-top-creatives', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since, until })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Ошибка запроса');
    status.textContent = `Готово: отправлено ${data.sent} креативов.`;
  } catch (err) {
    status.textContent = 'Ошибка: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

async function loadFormats(since, until) {
  $('#analytics-status').textContent = 'Загружаю...';
  try {
    const data = await fetchJson(`/api/analytics/formats?${new URLSearchParams({ since, until })}`);
    $('#analytics-status').textContent = '';

    renderGenericStackedBar('#formats-format-bar', '#formats-format-legend', [
      { label: 'Video', value: data.format.Video || 0, color: '#2ea56f' },
      { label: 'Static', value: data.format.Static || 0, color: '#d95f2b' },
      { label: 'Longread', value: data.format.Longread || 0, color: '#4285f4' }
    ]);
    renderBarList('#formats-platform-bars', data.platform);
    renderBarList('#formats-funnel-bars', data.funnel);
  } catch (err) {
    $('#analytics-status').textContent = 'Ошибка: ' + err.message;
  }
}

async function loadUsers(since, until) {
  $('#analytics-status').textContent = 'Загружаю...';
  try {
    const data = await fetchJson(`/api/analytics/users?${new URLSearchParams({ since, until })}`);
    $('#analytics-status').textContent = '';

    $('#users-reach-number').textContent = num(data.totalReach);
    renderBarList('#users-gender-bars', data.gender);
    renderBarList('#users-age-bars', data.age);
    renderBarList('#users-country-bars', data.countries);
  } catch (err) {
    $('#analytics-status').textContent = 'Ошибка: ' + err.message;
  }
}

// ---------- Аудитория: метрики по креативам с фильтром по одному срезу
// (гендер/возраст/гео) за раз — совместить гео с возрастом/гендером Meta не
// позволяет в одном запросе, см. комментарий у fetchAllAccountsInsightsBreakdown.
const AUDIENCE_GENDER_LABELS = { male: 'Мужчины', female: 'Женщины', unknown: 'Неизвестно' };
const AUDIENCE_DIMENSION_LABELS = { gender: 'гендер', age: 'возраст', country: 'гео' };

function renderAudienceBars(sel, summary, dimension, order) {
  let entries = Object.entries(summary).map(([key, v]) => [key, v.purchases]).filter(([, val]) => val > 0);
  if (order) {
    const known = order.filter((k) => k in summary && summary[k].purchases > 0).map((k) => [k, summary[k].purchases]);
    const rest = entries.filter(([k]) => !order.includes(k));
    entries = known.concat(rest);
  } else {
    entries.sort((a, b) => b[1] - a[1]);
  }
  const max = Math.max(1, ...entries.map((e) => e[1]));
  $(sel).innerHTML = entries.length ? entries.map(([key, val], i) => {
    const active = audienceFilter[dimension].includes(key);
    const label = dimension === 'gender' ? (AUDIENCE_GENDER_LABELS[key] || key) : key;
    return `
      <div class="bar-row bar-row--clickable${active ? ' is-active' : ''}" data-dimension="${dimension}" data-value="${key}">
        <span class="bar-row__label">${label}</span>
        <span class="bar-row__track"><span class="bar-row__fill" style="width:${(val / max) * 100}%;background:${CATEGORY_COLORS[i % CATEGORY_COLORS.length]}"></span></span>
        <span class="bar-row__value">${val}</span>
      </div>`;
  }).join('') : '<p class="hint">Пока нет данных</p>';
}

function renderAudienceSummary(summary, count) {
  $('#audience-summary').innerHTML = `
    <div class="panel-card"><h3>Расход</h3><p class="big-number">${money(summary.totalSpend)}</p></div>
    <div class="panel-card"><h3>Покупки</h3><p class="big-number">${summary.totalPurchases}</p></div>
    <div class="panel-card"><h3>CPA</h3><p class="big-number">${summary.overallCpa ? '$' + summary.overallCpa.toFixed(2) : '—'}</p></div>
    <div class="panel-card">
      <h3>Success Rate</h3>
      <p class="big-number">${Math.round(summary.successRate * 100)}%</p>
      <p class="hint">${summary.successCount} из ${count} креативов</p>
    </div>`;
}

function describeAudienceFilter() {
  const parts = [];
  if (audienceFilter.gender.length) parts.push(`гендер = ${audienceFilter.gender.map((g) => AUDIENCE_GENDER_LABELS[g] || g).join(', ')}`);
  if (audienceFilter.age.length) parts.push(`возраст = ${audienceFilter.age.join(', ')}`);
  if (audienceFilter.country.length) parts.push(`гео = ${audienceFilter.country.join(', ')}`);
  return parts.length ? `Фильтр: ${parts.join('; ')}` : 'Фильтр не выбран — показаны все креативы';
}

function hasAudienceFilter() {
  return audienceFilter.gender.length || audienceFilter.age.length || audienceFilter.country.length;
}

// Каждый клик по бару (гендер/возраст/гео) перезапускает загрузку — если
// кликнуть по двум значениям быстро подряд, второй запрос может ответить
// раньше первого, и более медленный первый ответ, придя позже, затрёт уже
// показанный корректный результат. Пропускаем рендер любого ответа, для
// которого успел уйти более новый запрос.
let audienceRequestSeq = 0;
async function loadAudience(since, until) {
  const seq = ++audienceRequestSeq;
  $('#analytics-status').textContent = 'Загружаю...';
  try {
    const params = new URLSearchParams({ since, until });
    for (const g of audienceFilter.gender) params.append('gender', g);
    for (const a of audienceFilter.age) params.append('age', a);
    for (const c of audienceFilter.country) params.append('country', c);

    const data = await fetchJson(`/api/analytics/audience?${params}`);
    if (seq !== audienceRequestSeq) return;
    $('#analytics-status').textContent = '';

    renderAudienceBars('#audience-gender-bars', data.genderSummary, 'gender');
    renderAudienceBars('#audience-age-bars', data.ageSummary, 'age', AGE_ORDER);
    renderAudienceBars('#audience-country-bars', data.countrySummary, 'country');

    $('#audience-active-filter').textContent = describeAudienceFilter();
    $('#audience-clear-filter').hidden = !hasAudienceFilter();

    renderAudienceSummary(data.summary, data.creatives.length);
    const sorted = sortCreatives(data.creatives, audienceSort);
    $all('#audience-table th[data-sort]').forEach((th) => th.classList.toggle('is-sorted', th.dataset.sort === audienceSort.key));
    $('#audience-tbody').innerHTML = sorted.length
      ? sorted.map(renderAnalyticsRow).join('')
      : '<tr><td colspan="33" class="empty-note">Нет данных по выбранному фильтру.</td></tr>';
  } catch (err) {
    if (seq !== audienceRequestSeq) return;
    $('#analytics-status').textContent = 'Ошибка: ' + err.message;
  }
}

function handleAudienceBarClick(e) {
  const row = e.target.closest('.bar-row--clickable');
  if (!row) return;
  const { dimension, value } = row.dataset;
  // Гео исключает возраст/гендер и наоборот — совместить их в одном запросе
  // не даёт сам Meta API, так что выбор одного явно сбрасывает другую группу,
  // а не молча её игнорирует.
  if (dimension === 'country') { audienceFilter.age = []; audienceFilter.gender = []; }
  else { audienceFilter.country = []; }
  const arr = audienceFilter[dimension];
  const idx = arr.indexOf(value);
  if (idx === -1) arr.push(value); else arr.splice(idx, 1);
  loadAudience($('#analytics-since').value, $('#analytics-until').value);
}
$('#audience-gender-bars').addEventListener('click', handleAudienceBarClick);
$('#audience-age-bars').addEventListener('click', handleAudienceBarClick);
$('#audience-country-bars').addEventListener('click', handleAudienceBarClick);

$('#audience-clear-filter').addEventListener('click', () => {
  audienceFilter = { gender: [], age: [], country: [] };
  loadAudience($('#analytics-since').value, $('#analytics-until').value);
});

$('#audience-table thead').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  audienceSort = audienceSort.key === key
    ? { key, dir: audienceSort.dir === 'desc' ? 'asc' : 'desc' }
    : { key, dir: 'desc' };
  loadAudience($('#analytics-since').value, $('#analytics-until').value);
});

async function loadProduction(since, until) {
  $('#analytics-status').textContent = 'Загружаю...';
  try {
    const data = await fetchJson(`/api/analytics/production?${new URLSearchParams({ since, until })}`);
    $('#analytics-status').textContent = '';

    const pctHtml = data.pctChange === null ? ''
      : `<span class="big-number__pct ${data.pctChange >= 0 ? 'big-number__pct--up' : 'big-number__pct--down'}">${data.pctChange >= 0 ? '↗' : '↘'}${data.pctChange}%</span>`;
    $('#production-number').innerHTML = `${data.total}${pctHtml}`;

    const days = data.byDay.map((d) => d.day);
    const designers = Object.keys(data.byDesigner);
    destroyChart('productionByDay');
    charts.productionByDay = new Chart($('#chart-production-by-day'), {
      type: 'bar',
      data: {
        labels: days,
        datasets: designers.map((d, i) => ({
          label: d,
          data: days.map((day) => data.byDayDesigner[day]?.[d] || 0),
          backgroundColor: CATEGORY_COLORS[i % CATEGORY_COLORS.length]
        }))
      },
      options: {
        plugins: { legend: { display: designers.length > 1 } },
        scales: { x: { stacked: true }, y: { stacked: true, ticks: { precision: 0 } } }
      }
    });

    renderGenericStackedBar('#production-launched-bar', '#production-launched-legend', [
      { label: 'Напущено', value: data.launched, color: '#2ea56f' },
      { label: 'Ещё нет', value: data.notLaunched, color: '#c9c9c4' }
    ]);

    renderFunnelBarWithDayGroups('#production-designer-bars', data.byDesigner, data.byDesignerTasksByDay);
    renderDesignerFormatTable('#production-format-table', data, days, designers);
    renderBarList('#production-funnel-bars', data.byFunnel);
  } catch (err) {
    $('#analytics-status').textContent = 'Ошибка: ' + err.message;
  }
}

// Таблица "кто что делает": строки — дизайнеры, колонки — дни, в ячейке
// сколько видео (V) и статики (S) сдал дизайнер в этот день; справа итог за
// период и полоска соотношения видео/статика.
function renderDesignerFormatTable(sel, data, days, designers) {
  if (!designers.length) { $(sel).innerHTML = '<p class="hint">Пока нет данных</p>'; return; }
  const cell = (f) => {
    if (!f) return '<span class="fmt-cell fmt-cell--empty">—</span>';
    const parts = [];
    if (f.Video) parts.push(`<span class="fmt-tag fmt-tag--video">${f.Video}V</span>`);
    if (f.Static) parts.push(`<span class="fmt-tag fmt-tag--static">${f.Static}S</span>`);
    if (f.Longread) parts.push(`<span class="fmt-tag fmt-tag--longread">${f.Longread}L</span>`);
    if (f.Other) parts.push(`<span class="fmt-tag">${f.Other}?</span>`);
    return parts.join(' ');
  };
  const head = `<tr><th>Дизайнер</th>${days.map((d) => `<th>${d.slice(5)}</th>`).join('')}<th>Итого</th><th>Видео / статика / лонгрид</th></tr>`;
  const rows = designers.map((d) => {
    const tot = data.byDesignerFormat[d];
    const sum = (tot.Video + tot.Static + (tot.Longread || 0) + tot.Other) || 1;
    const bar = `<span class="stacked-bar stacked-bar--mini"><span class="stacked-bar__seg" style="width:${tot.Video / sum * 100}%;background:#2ea56f"></span><span class="stacked-bar__seg" style="width:${tot.Static / sum * 100}%;background:#d95f2b"></span><span class="stacked-bar__seg" style="width:${(tot.Longread || 0) / sum * 100}%;background:#4285f4"></span></span>`;
    return `<tr><td><strong>${d}</strong></td>${days.map((day) => `<td>${cell(data.byDayDesignerFormat[day]?.[d])}</td>`).join('')}<td>${cell(tot)}</td><td>${bar}</td></tr>`;
  }).join('');
  $(sel).innerHTML = `<div class="fmt-table-wrap"><table class="fmt-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

function renderPctBigNumber(sel, total, pctChange) {
  const pctHtml = pctChange === null ? ''
    : `<span class="big-number__pct ${pctChange >= 0 ? 'big-number__pct--up' : 'big-number__pct--down'}">${pctChange >= 0 ? '↗' : '↘'}${pctChange}%</span>`;
  $(sel).innerHTML = `${total}${pctHtml}`;
}

// Рендер для CP: день/CP/формат. Столбик по дню разбит по CP, кто именно
// поставил задачи в этот день (как в UA-отчёте, но по CP вместо воронки).
function renderDailyReport(prefix, data) {
  renderPctBigNumber(`#${prefix}-number`, data.total, data.pctChange);

  const days = data.byDay.map((d) => d.day);
  const cps = [...new Set(days.flatMap((day) => Object.keys(data.byDayCp[day] || {})))];
  const datasets = cps.map((cp, i) => ({
    label: cp,
    data: days.map((day) => data.byDayCp[day]?.[cp] || 0),
    backgroundColor: CATEGORY_COLORS[i % CATEGORY_COLORS.length]
  }));

  destroyChart(prefix + 'ByDay');
  charts[prefix + 'ByDay'] = new Chart($(`#chart-${prefix}-by-day`), {
    type: 'bar',
    data: { labels: days, datasets },
    options: {
      plugins: { legend: { display: cps.length > 1 } },
      scales: { x: { stacked: true }, y: { stacked: true } }
    }
  });

  renderGenericStackedBar(`#${prefix}-format-bar`, `#${prefix}-format-legend`, [
    { label: 'Video', value: data.video, color: '#2ea56f' },
    { label: 'Static', value: data.static, color: '#d95f2b' },
    { label: 'Longread', value: data.longread || 0, color: '#4285f4' }
  ]);

  renderFunnelBarWithDayGroups(`#${prefix}-bars`, data.byCp, data.byCpTasksByDay);
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

function renderUaReport(data) {
  renderPctBigNumber('#ua-number', data.total, data.pctChange);

  const days = data.byDay.map((d) => d.day);
  const funnels = [...new Set(days.flatMap((day) => Object.keys(data.byDayFunnel[day] || {})))];
  const datasets = funnels.map((funnel, i) => ({
    label: funnel,
    data: days.map((day) => data.byDayFunnel[day]?.[funnel] || 0),
    backgroundColor: CATEGORY_COLORS[i % CATEGORY_COLORS.length]
  }));

  destroyChart('uaByDay');
  charts.uaByDay = new Chart($('#chart-ua-by-day'), {
    type: 'bar',
    data: { labels: days, datasets },
    options: {
      plugins: { legend: { display: funnels.length > 1 } },
      scales: { x: { stacked: true }, y: { stacked: true } }
    }
  });

  renderFormatWithTasks('#ua-format-bar', '#ua-format-legend', '#ua-format-tasks', data.formatTasks);
  renderFunnelBarWithDayGroups('#ua-bars', data.byFunnel, data.byFunnelTasksByDay);

  const rt = data.readyTest;
  $('#ua-util-new').textContent = rt.newToTestInPeriod;
  $('#ua-util-backlog').textContent = rt.backlogNow;
  $('#ua-util-launched').textContent = rt.launchedInPeriod;
  $('#ua-util-pct').textContent = rt.utilizationPct != null ? rt.utilizationPct + '%' : '—';
}

async function loadUa(since, until) {
  $('#analytics-status').textContent = 'Загружаю...';
  try {
    const data = await fetchJson(`/api/analytics/ua?${new URLSearchParams({ since, until })}`);
    $('#analytics-status').textContent = '';
    renderUaReport(data);
  } catch (err) {
    $('#analytics-status').textContent = 'Ошибка: ' + err.message;
  }
}

// ---------- Success Rate (отдельный раздел в левом меню) ----------
let srInited = false;
let srSubtab = 'sr';

function setSrPeriod(days) {
  const today = new Date();
  $('#sr-until').value = today.toISOString().slice(0, 10);
  $('#sr-since').value = new Date(today.getTime() - days * 86400000).toISOString().slice(0, 10);
  $all('#sr-period-presets .segmented__btn').forEach((b) => b.classList.toggle('is-active', +b.dataset.days === days));
}

function loadSrActiveSubtab() {
  const since = $('#sr-since').value;
  const until = $('#sr-until').value;
  if (srSubtab === 'sr') return loadSuccessRate(since, until);
  if (srSubtab === 'testing') return loadTesting(since, until);
}

function initSrView() {
  if (srInited) return;
  srInited = true;
  setSrPeriod(0);
  loadSrActiveSubtab();
}

$('#sr-subtabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  srSubtab = btn.dataset.subtab;
  $all('#sr-subtabs .tab').forEach((b) => b.classList.toggle('is-active', b === btn));
  $all('#view-sr .tab-panel').forEach((p) => p.classList.toggle('is-active', p.id === `subtab-${srSubtab}`));
  loadSrActiveSubtab();
});

$('#sr-period-presets').addEventListener('click', (e) => {
  const btn = e.target.closest('.segmented__btn');
  if (!btn || btn.id === 'sr-closed-week-btn') return;
  setSrPeriod(+btn.dataset.days);
  loadSrActiveSubtab();
});

$('#sr-closed-week-btn').addEventListener('click', () => {
  const today = new Date();
  const daysSinceMonday = (today.getDay() + 6) % 7;
  const thisMonday = new Date(today.getTime() - daysSinceMonday * 86400000);
  $('#sr-since').value = new Date(thisMonday.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  $('#sr-until').value = new Date(thisMonday.getTime() - 86400000).toISOString().slice(0, 10);
  $all('#sr-period-presets .segmented__btn').forEach((b) => b.classList.toggle('is-active', b.id === 'sr-closed-week-btn'));
  loadSrActiveSubtab();
});

$('#sr-filters').addEventListener('submit', (e) => {
  e.preventDefault();
  $all('#sr-period-presets .segmented__btn').forEach((b) => b.classList.remove('is-active'));
  loadSrActiveSubtab();
});

// ---------- Retention (отдельный раздел в левом меню) ----------
let retInited = false;
let retData = null;
let retSort = { key: 'p50r', dir: 'desc' };

function setRetPeriod(days) {
  const today = new Date();
  $('#ret-until').value = today.toISOString().slice(0, 10);
  $('#ret-since').value = new Date(today.getTime() - days * 86400000).toISOString().slice(0, 10);
  $all('#ret-period-presets .segmented__btn').forEach((b) => b.classList.toggle('is-active', +b.dataset.days === days));
}

function initRetView() {
  if (retInited) return;
  retInited = true;
  $('#ret-sort').value = retSort.key;
  setRetPeriod(7);
  loadRetention();
}

async function loadRetention() {
  $('#ret-status').textContent = 'Загружаю...';
  try {
    const params = new URLSearchParams({ since: $('#ret-since').value, until: $('#ret-until').value });
    const mode = $('#ret-campaign').value;
    if (mode) params.set('campaignMode', mode);
    if (retCountryFilter.countries.length) {
      params.set('countries', retCountryFilter.countries.join(','));
      params.set('countryMode', retCountryFilter.mode);
    }
    retData = await fetchJson(`/api/analytics/retention?${params}`);
    $('#ret-status').textContent = '';
    const funnels = [...new Set(retData.creatives.map((c) => c.funnel))].sort();
    const sel = $('#ret-funnel-filter');
    const prev = sel.value;
    sel.innerHTML = '<option value="">Все воронки</option>' + funnels.map((f) => `<option value="${srEsc(f)}">${srEsc(f)}</option>`).join('');
    if (funnels.includes(prev)) sel.value = prev;
    renderRetention();
  } catch (err) {
    $('#ret-status').textContent = 'Ошибка: ' + err.message;
  }
}

const retRate = (a, b) => (b > 0 ? a / b : 0);
// Кривая удержания Meta: элемент i — % запусков видео, дожививших до i-й секунды.
const retSec = (c, sec) => (c.curve && c.curve[sec] != null ? c.curve[sec] / 100 : null);
function retDerive(c) {
  return {
    ...c,
    hook: retRate(c.views3s, c.impressions),
    t3: retSec(c, 3), t5: retSec(c, 5), t10: retSec(c, 10), t15: retSec(c, 15),
    avgPct: c.videoLength > 0 && c.avgWatch ? Math.min(1, c.avgWatch / c.videoLength) : null,
    p25r: retRate(c.p25, c.plays), p50r: retRate(c.p50, c.plays), p75r: retRate(c.p75, c.plays), p100r: retRate(c.p100, c.plays),
    ctr: retRate(c.linkClicks, c.impressions),
    lpvRate: retRate(c.landingViews, c.linkClicks),
    buyRate: retRate(c.purchases, c.landingViews)
  };
}

function retBarCell(v) {
  if (v == null) return '<td class="ret-cell">—</td>';
  const w = Math.min(100, v * 100);
  return `<td class="ret-cell" style="background:linear-gradient(90deg,#cfe9dc ${w}%,transparent ${w}%)">${srPct(v)}</td>`;
}

function renderRetention() {
  if (!retData) return;
  const minImpr = +$('#ret-min-impr').value || 0;
  const funnel = $('#ret-funnel-filter').value;
  const { key, dir } = retSort;
  const mult = dir === 'asc' ? 1 : -1;
  const list = retData.creatives.map(retDerive)
    .filter((c) => c.impressions >= minImpr && (!funnel || c.funnel === funnel))
    .sort((a, b) => {
      const x = a[key], y = b[key];
      // Пустые значения (например, CPA без покупок) всегда в конце списка.
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * mult;
    });
  $all('#ret-table th[data-sort]').forEach((th) => {
    th.classList.toggle('is-sorted', th.dataset.sort === key && dir === 'desc');
    th.classList.toggle('is-sorted-asc', th.dataset.sort === key && dir === 'asc');
  });

  const sum = (k) => list.reduce((s, c) => s + (c[k] || 0), 0);
  // [подпись, значение, от чего считаем процент]: Hook Rate и CTR — от показов,
  // 25–100% — от Plays (так их считает Meta), LPV — от кликов, покупки — от LPV.
  const steps = [
    ['Показы', sum('impressions'), null],
    ['Plays', sum('plays'), ['показов', sum('impressions')]],
    ['3-сек. просмотры', sum('views3s'), ['показов', sum('impressions')]],
    ['25%', sum('p25'), ['Plays', sum('plays')]],
    ['50%', sum('p50'), ['Plays', sum('plays')]],
    ['75%', sum('p75'), ['Plays', sum('plays')]],
    ['100%', sum('p100'), ['Plays', sum('plays')]],
    ['Клики по ссылке', sum('linkClicks'), ['показов', sum('impressions')]],
    ['Просмотры лендинга', sum('landingViews'), ['кликов', sum('linkClicks')]],
    ['Покупки', sum('purchases'), ['LPV', sum('landingViews')]]
  ];
  $('#ret-funnel').innerHTML = `<div class="ret-funnel__title">Путь зрителя по ${list.length} креативам <span class="hint">— процент под числом считается от указанной базы</span></div>
    <div class="ret-steps">${steps.map(([label, v, base]) => {
      const conv = base && base[1] ? `<small>${srPct(v / base[1], v / base[1] < 0.1 ? 2 : 1)} <em>от ${base[0]}</em></small>` : '';
      return `<div class="ret-step"><div class="ret-step__label">${label}</div><div class="ret-step__val">${Math.round(v).toLocaleString('ru-RU')}${conv}</div></div>`;
    }).join('')}</div>`;

  $('#ret-tbody').innerHTML = list.map((c, i) => {
    const gc = GRADE_BADGE_COLORS[c.grade] || { bg: '#eee', color: '#333' };
    return `<tr>
      <td>${i + 1}</td>
      <td>${c.previewUrl ? `<img class="thumb ret-thumb" src="${c.previewUrl}" loading="lazy" data-ad-id="${c.adId}" data-ad-name="${srEsc(c.name)}" title="Кликни, чтобы посмотреть крео" />` : ''}</td>
      <td class="ret-name" title="${srEsc(c.name)}">${srEsc(c.name)}</td>
      <td><span class="grade-badge" style="background:${gc.bg};color:${gc.color}">${c.grade}</span></td>
      <td>${srEsc(c.funnel)}</td><td>${srMoney(c.spend)}</td><td>${c.impressions.toLocaleString('ru-RU')}</td>
      ${retBarCell(c.hook)}<td>${Math.round(c.plays).toLocaleString('ru-RU')}</td>
      ${retBarCell(c.t3)}${retBarCell(c.t5)}${retBarCell(c.t10)}${retBarCell(c.t15)}
      ${retBarCell(c.p25r)}${retBarCell(c.p50r)}${retBarCell(c.p75r)}${retBarCell(c.p100r)}
      <td>${c.avgWatch ? c.avgWatch.toFixed(1) + 's' : '—'}</td>
      <td>${c.videoLength ? Math.round(c.videoLength) + 's' : '—'}</td>
      ${retBarCell(c.avgPct)}
      <td class="ret-sep">${c.linkClicks}</td><td>${srPct(c.ctr, 2)}</td><td>${c.landingViews}</td><td>${srPct(c.lpvRate)}</td>
      <td><strong>${c.purchases}</strong></td><td>${srPct(c.buyRate)}</td><td>${c.cpa ? '$' + Math.round(c.cpa) : '—'}</td></tr>`;
  }).join('') || '<tr><td colspan="27" class="hint">Нет видео-креативов под эти фильтры</td></tr>';

  retFiltered = list;
  const t = retData.totals || { all: retData.creatives.length, video: retData.creatives.length, nonVideo: 0 };
  const hiddenByFilter = retData.creatives.length - list.length;
  $('#ret-scope').textContent = `Показано ${list.length} из ${t.video} видео-креативов за период. ` +
    (hiddenByFilter > 0 ? `Скрыто ${hiddenByFilter}: меньше ${minImpr} показов${funnel ? ' или другая воронка' : ''} (фильтр «Мин. показов» — поставь 0, чтобы увидеть все). ` : '') +
    (retData.curveNote?.failed ? `⚠ Meta не отдала удержание по секундам (3/5/10/15 сек), попробуй обновить через минуту: ${retData.curveNote.error}. ` : '') +
    (retData.curveNote?.allCountries ? 'Удержание по секундам (3/5/10/15 сек) Meta считает только по всем странам сразу, поэтому эти колонки не учитывают фильтр по странам. ' : '') +
    (t.nonVideo > 0 ? `Ещё ${t.nonVideo} креативов (статика, лонгриды) здесь не показываются — у них нет метрик просмотра видео; они есть в «Аналитика → Все креативы».` : '');
  if ($('#subtab-ret-drop').classList.contains('is-active')) renderDropoff();
  if ($('#subtab-ret-viz').classList.contains('is-active')) renderViz();
}

let retFiltered = [];
let retSubtab = 'ret-top';

// ---------- Доходимость: где отваливаются зрители ----------
const DROP_VIDEO = [
  ['Ушли до 25%', '#d9534f'], ['25 → 50%', '#e8793a'], ['50 → 75%', '#f2b94c'], ['75 → 100%', '#9cc66a'], ['Досмотрели до конца', '#2ea56f']
];
const DROP_CLICK = [['Не дошли до лендинга', '#d9534f'], ['Дошли, не купили', '#f2b94c'], ['Купили', '#2ea56f']];

function dropAggregate(items) {
  const t = { impressions: 0, plays: 0, views3s: 0, p25: 0, p50: 0, p75: 0, p100: 0, linkClicks: 0, landingViews: 0, purchases: 0 };
  for (const c of items) for (const k of Object.keys(t)) t[k] += c[k] || 0;
  // Удержание по секундам (из кривой Meta), средневзвешенное по Plays.
  const withCurve = items.filter((c) => c.curve);
  const w = withCurve.reduce((a, c) => a + c.plays, 0);
  t.sec = w > 0 ? [3, 5, 10, 15].map((s) => withCurve.reduce((a, c) => a + (c.curve[s] || 0) * c.plays, 0) / w) : null;
  return t;
}
function dropSecParts(t) {
  if (!t.sec) return [0, 0, 0, 0, 0];
  const [a, b, c, d] = t.sec;
  return [100 - a, a - b, b - c, c - d, d].map((v) => Math.max(0, v));
}
const DROP_SEC = [
  ['Ушли до 3 сек', '#d9534f'], ['3 → 5 сек', '#e8793a'], ['5 → 10 сек', '#f2b94c'], ['10 → 15 сек', '#9cc66a'], ['Остались после 15 сек', '#2ea56f']
];

function dropVideoParts(t) {
  const pl = t.plays || 1;
  const parts = [(t.plays - t.p25) / pl, (t.p25 - t.p50) / pl, (t.p50 - t.p75) / pl, (t.p75 - t.p100) / pl, t.p100 / pl];
  return parts.map((v) => Math.max(0, v) * 100);
}
function dropClickParts(t) {
  const cl = t.linkClicks || 1;
  return [(t.linkClicks - t.landingViews) / cl, (t.landingViews - t.purchases) / cl, t.purchases / cl].map((v) => Math.max(0, v) * 100);
}

// "Воронка отсева": для каждого шага — сколько зрителей дошло (в % от первого
// шага блока и абсолютным числом) и сколько потерялось относительно предыдущего
// шага. Колонки — "Все" и каждая воронка отдельно, чтобы сравнивать
// проходимость воронок между собой.
const DROP_GROUPS = [
  ['До клика (показы = 100%)', '#4285f4', [['Показы', (t) => t.impressions], ['Plays', (t) => t.plays], ['3-сек. просмотры', (t) => t.views3s], ['Клики по ссылке', (t) => t.linkClicks]]],
  ['Просмотр видео (Plays = 100%)', '#2ea56f', [['Plays', (t) => t.plays], ['25%', (t) => t.p25], ['50%', (t) => t.p50], ['75%', (t) => t.p75], ['100%', (t) => t.p100]]],
  ['После клика (клики = 100%)', '#d95f2b', [['Клики', (t) => t.linkClicks], ['Просмотр лендинга', (t) => t.landingViews], ['Покупки', (t) => t.purchases]]]
];

function renderDropSummary(list) {
  const funnels = [...new Set(list.map((c) => c.funnel))]
    .map((name) => ({ name, items: list.filter((c) => c.funnel === name) }))
    .sort((a, b) => b.items.reduce((x, c) => x + c.impressions, 0) - a.items.reduce((x, c) => x + c.impressions, 0));
  const cols = [{ name: 'Все', t: dropAggregate(list), n: list.length }, ...funnels.map((f) => ({ name: f.name, t: dropAggregate(f.items), n: f.items.length }))];

  $('#drop-summary').innerHTML = DROP_GROUPS.map(([title, color, steps]) => {
    const head = `<tr><th>${title}</th>${cols.map((c) => `<th>${srEsc(c.name)}<small>${c.n} креат.</small></th>`).join('')}</tr>`;
    const rows = steps.map(([label, fn], i) => `<tr><td class="drop-table__step">${label}</td>${cols.map((c) => {
      const v = fn(c.t), base = steps[0][1](c.t), prev = i ? steps[i - 1][1](c.t) : 0;
      const pct = base > 0 ? v / base : 0;
      const lost = prev > 0 ? 1 - v / prev : null;
      const w = Math.max(0.6, Math.min(100, pct * 100));
      return `<td class="drop-table__cell" style="background:linear-gradient(90deg,${color}33 ${w}%,transparent ${w}%)">
        <strong>${srPct(pct, pct < 0.1 ? 2 : 1)}</strong> <small>${Math.round(v).toLocaleString('ru-RU')}</small>
        ${lost !== null && lost > 0 ? `<span class="drop-table__lost">−${srPct(lost, 1)}</span>` : ''}</td>`;
    }).join('')}</tr>`).join('');
    return `<div class="fmt-table-wrap"><table class="table drop-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
  }).join('');
}

let dropGroups = [];
let dropSelected = null;

// Таблица креативов с удержанием и путём после клика (общая для списка по
// клику в "Доходимости" и в "Воронке (график)"). items — уже retDerive'нутые.
function creativeListHtml(items, bySec) {
  const cell = (v) => (v == null ? '—' : srPct(v));
  const rows = items.map((c) => {
    const gc = GRADE_BADGE_COLORS[c.grade] || { bg: '#eee', color: '#333' };
    const rets = bySec ? [c.t3, c.t5, c.t10, c.t15] : [c.p25r, c.p50r, c.p75r, c.p100r];
    return `<tr>
      <td>${c.previewUrl ? `<img class="thumb ret-thumb" src="${c.previewUrl}" loading="lazy" data-ad-id="${c.adId}" data-ad-name="${srEsc(c.name)}" title="Кликни, чтобы посмотреть крео" />` : ''}</td>
      <td class="ret-name" title="${srEsc(c.name)}">${srEsc(c.name)}</td>
      <td><span class="grade-badge" style="background:${gc.bg};color:${gc.color}">${c.grade}</span></td>
      <td>${srMoney(c.spend)}</td><td>${c.impressions.toLocaleString('ru-RU')}</td><td>${Math.round(c.plays).toLocaleString('ru-RU')}</td>
      ${rets.map((v) => `<td>${cell(v)}</td>`).join('')}
      <td class="ret-sep">${c.linkClicks}</td><td>${c.landingViews}</td><td>${srPct(c.lpvRate)}</td><td><strong>${c.purchases}</strong></td><td>${c.cpa ? '$' + Math.round(c.cpa) : '—'}</td></tr>`;
  }).join('');
  const heads = bySec ? ['3 сек', '5 сек', '10 сек', '15 сек'] : ['25%', '50%', '75%', '100%'];
  return `<div class="table-scroll"><table class="table analytics-table"><thead><tr><th>Превью</th><th>Название</th><th>Grade</th><th>Spend</th><th>Показы</th><th>Plays</th>
    ${heads.map((h) => `<th>${h}</th>`).join('')}<th class="ret-sep">Клики</th><th>LPV</th><th>LPV / клики</th><th>Покупки</th><th>CPA</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// Список креативов выбранного столбика (воронки или одного креатива) с
// метриками удержания и путём после клика.
function renderDropDetail(label, scroll) {
  const g = dropGroups.find((x) => x.label === label);
  if (!g) return;
  dropSelected = label;
  const bySec = $('#drop-scale').value === 'sec';
  const items = g.items.map(retDerive).sort((a, b) => b.spend - a.spend);
  $('#drop-detail').innerHTML = `<h4>Креативы: ${srEsc(label)} <span class="hint">— ${items.length} шт., по убыванию spend</span></h4>${creativeListHtml(items, bySec)}`;
  $('#drop-detail').hidden = false;
  if (scroll) $('#drop-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function dropShortName(name) {
  const p = String(name || '').split('_');
  return '№' + p[0] + (p[2] ? ' ' + p[2] : '');
}

function renderDropCharts(groups) {
  const labels = groups.map((g) => g.label);
  const make = (canvasId, key, defs, partsFn) => {
    destroyChart(key);
    const rows = groups.map((g) => partsFn(g.t));
    charts[key] = new Chart($(canvasId), {
      type: 'bar',
      data: {
        labels,
        datasets: defs.map(([name, color], i) => ({ label: name, data: rows.map((r) => r[i]), backgroundColor: color }))
      },
      options: {
        indexAxis: 'y',
        maintainAspectRatio: false,
        onClick: (evt, els, chart) => {
          const hit = chart.getElementsAtEventForMode(evt, 'nearest', { intersect: false, axis: 'y' }, true)[0];
          if (hit) renderDropDetail(groups[hit.index].label, true);
        },
        onHover: (evt, els, chart) => { evt.native.target.style.cursor = 'pointer'; },
        plugins: {
          legend: { position: 'top' },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.x.toFixed(1)}%` } }
        },
        scales: {
          x: { stacked: true, max: 100, ticks: { callback: (v) => v + '%' } },
          y: { stacked: true }
        }
      }
    });
    $(canvasId).parentElement.style.height = Math.max(180, labels.length * 30 + 90) + 'px';
  };
  const bySec = $('#drop-scale').value === 'sec';
  $('#drop-video-hint').textContent = bySec
    ? 'Доля запусков видео, ушедших до 3, 5, 10 и 15 секунды (кривая удержания Meta). Зелёный справа — досмотрели дальше 15 секунд.'
    : 'Доля запусков видео (Plays), ушедших до отметки 25/50/75/100%. Чем больше зелёного справа, тем лучше креатив удерживает.';
  if (bySec) make('#chart-drop-video', 'dropVideo', DROP_SEC, dropSecParts);
  else make('#chart-drop-video', 'dropVideo', DROP_VIDEO, dropVideoParts);
  make('#chart-drop-click', 'dropClick', DROP_CLICK, dropClickParts);
}

function renderDropoff() {
  const list = retFiltered;
  if (!list.length) {
    $('#drop-summary').innerHTML = '<p class="hint">Нет видео-креативов под эти фильтры</p>';
    destroyChart('dropVideo'); destroyChart('dropClick');
    return;
  }
  const total = dropAggregate(list);
  renderDropSummary(list);

  let groups;
  if ($('#drop-group').value === 'funnels') {
    const names = [...new Set(list.map((c) => c.funnel))];
    groups = names.map((n) => { const items = list.filter((c) => c.funnel === n); return { label: n, items, t: dropAggregate(items), spend: items.reduce((a, c) => a + c.spend, 0) }; })
      .sort((a, b) => b.spend - a.spend);
  } else {
    const n = +$('#drop-top').value;
    groups = list.slice().sort((a, b) => b.spend - a.spend).slice(0, n).map((c) => ({ label: dropShortName(c.name), items: [c], t: dropAggregate([c]) }));
  }
  groups.unshift({ label: 'Все', items: list, t: total });
  dropGroups = groups;
  renderDropCharts(groups);
  if (dropSelected != null && !groups.some((g) => g.label === dropSelected)) { dropSelected = null; $('#drop-detail').hidden = true; }
  else if (dropSelected != null) renderDropDetail(dropSelected);
}

// ---------- Воронка (график): синий — дошли, штриховка — потеряли ----------
const VIZ_H = 260;

function vizSteps(t, path) {
  if (path === 'video') {
    const steps = [['Plays', t.plays]];
    if (t.sec) [['3 сек', 0], ['5 сек', 1], ['10 сек', 2], ['15 сек', 3]].forEach(([l, i]) => steps.push([l, t.plays * t.sec[i] / 100]));
    steps.push(['25%', t.p25], ['50%', t.p50], ['75%', t.p75], ['100%', t.p100]);
    return steps;
  }
  return [['Показы', t.impressions], ['Plays', t.plays], ['3-сек. просмотры', t.views3s], ['Клики', t.linkClicks], ['Просмотр лендинга', t.landingViews], ['Покупки', t.purchases]];
}

let vizGroups = [];

function vizChartHtml(title, count, steps, idx) {
  const base = steps[0][1] || 1;
  let prev = 1;
  const cols = steps.map(([label, v]) => {
    const pct = Math.max(0, v / base);
    const solid = Math.max(2, pct * VIZ_H);
    const hatch = Math.max(0, (prev - pct) * VIZ_H);
    const html = `<div class="viz__col">
      <div class="viz__stack">
        ${hatch > 0.5 ? `<div class="viz__hatch" style="height:${hatch}px"></div>` : ''}
        <div class="viz__solid" style="height:${solid}px"></div>
        <div class="viz__bubble" style="bottom:${solid}px"><b>${srPct(pct, pct < 0.1 ? 2 : 1)}</b><span>${Math.round(v).toLocaleString('ru-RU')}</span></div>
      </div>
      <div class="viz__label">${label}</div></div>`;
    prev = pct;
    return html;
  }).join('');
  return `<div class="panel-card viz-card" data-idx="${idx}"><h4>${srEsc(title)} <span class="hint">— ${count} креат.</span>
    <button type="button" class="btn btn--ghost viz-toggle">Показать креативы ▾</button></h4>
    <div class="viz">${cols}</div><div class="viz-list" hidden></div></div>`;
}

function renderViz() {
  const list = retFiltered;
  const path = $('#viz-path').value;
  if (!list.length) { $('#viz-charts').innerHTML = '<p class="hint">Нет видео-креативов под эти фильтры</p>'; return; }
  const funnels = [...new Set(list.map((c) => c.funnel))]
    .map((name) => ({ name, items: list.filter((c) => c.funnel === name) }))
    .sort((a, b) => b.items.reduce((x, c) => x + c.impressions, 0) - a.items.reduce((x, c) => x + c.impressions, 0));
  vizGroups = [{ label: 'Все воронки', items: list }, ...funnels.map((f) => ({ label: f.name, items: f.items }))];
  const total = retData ? retData.creatives.length : list.length;
  const minImpr = +$('#ret-min-impr').value || 0;
  $('#viz-scope').textContent = `На графиках ${list.length} из ${total} видео-креативов за период ${retData.since} — ${retData.until}. ` +
    `В расчёт попадают только видео (статика и лонгриды без метрик просмотра) с показами не меньше ${minImpr}` +
    ($('#ret-funnel-filter').value ? `, воронка «${$('#ret-funnel-filter').value}»` : '') +
    '. Увеличь период или снизь «Мин. показов», чтобы увидеть больше. Нажми «Показать креативы» у графика, чтобы увидеть список.';
  $('#viz-charts').innerHTML = vizGroups.map((g, i) => vizChartHtml(g.label, g.items.length, vizSteps(dropAggregate(g.items), path), i)).join('');
}

// Клик по кнопке (или по столбцу) раскрывает список креативов этого графика.
$('#viz-charts').addEventListener('click', (e) => {
  if (e.target.closest('.thumb')) return;
  const card = e.target.closest('.viz-card');
  if (!card || !(e.target.closest('.viz-toggle') || e.target.closest('.viz__col'))) return;
  const box = card.querySelector('.viz-list');
  if (box.hidden) {
    const g = vizGroups[+card.dataset.idx];
    const items = g.items.map(retDerive).sort((a, b) => b.spend - a.spend);
    box.innerHTML = creativeListHtml(items, $('#viz-path').value === 'video');
    box.hidden = false;
  } else {
    box.hidden = true;
  }
  card.querySelector('.viz-toggle').textContent = box.hidden ? 'Показать креативы ▾' : 'Скрыть креативы ▴';
});
$('#viz-path').addEventListener('change', renderViz);

$('#ret-subtabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  retSubtab = btn.dataset.subtab;
  $all('#ret-subtabs .tab').forEach((b) => b.classList.toggle('is-active', b === btn));
  $all('#view-ret .tab-panel').forEach((p) => p.classList.toggle('is-active', p.id === `subtab-${retSubtab}`));
  if (retSubtab === 'ret-drop') renderDropoff();
  if (retSubtab === 'ret-viz') renderViz();
});
$('#drop-group').addEventListener('change', () => {
  $('#drop-top').disabled = $('#drop-group').value === 'funnels';
  renderDropoff();
});
$('#drop-top').addEventListener('change', renderDropoff);
$('#drop-scale').addEventListener('change', renderDropoff);

$('#ret-sort').addEventListener('change', () => {
  retSort = { key: $('#ret-sort').value, dir: 'desc' };
  renderRetention();
});
$('#ret-table').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const key = th.dataset.sort;
  const textCol = ['name', 'grade', 'funnel'].includes(key);
  retSort = retSort.key === key
    ? { key, dir: retSort.dir === 'desc' ? 'asc' : 'desc' }
    : { key, dir: textCol ? 'asc' : 'desc' };
  const sel = $('#ret-sort');
  sel.value = [...sel.options].some((o) => o.value === key) ? key : '';
  renderRetention();
});
$('#ret-min-impr').addEventListener('input', renderRetention);
$('#ret-funnel-filter').addEventListener('change', renderRetention);
$('#ret-campaign').addEventListener('change', loadRetention);
const retCountryFilter = setupCountryFilter({
  prefix: 'ret-country',
  getPeriod: () => ({ since: $('#ret-since').value, until: $('#ret-until').value }),
  onApply: loadRetention
});
$('#ret-period-presets').addEventListener('click', (e) => {
  const btn = e.target.closest('.segmented__btn');
  if (!btn || btn.id === 'ret-closed-week-btn') return;
  setRetPeriod(+btn.dataset.days);
  loadRetention();
});
$('#ret-closed-week-btn').addEventListener('click', () => {
  const today = new Date();
  const thisMonday = new Date(today.getTime() - ((today.getDay() + 6) % 7) * 86400000);
  $('#ret-since').value = new Date(thisMonday.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  $('#ret-until').value = new Date(thisMonday.getTime() - 86400000).toISOString().slice(0, 10);
  $all('#ret-period-presets .segmented__btn').forEach((b) => b.classList.toggle('is-active', b.id === 'ret-closed-week-btn'));
  loadRetention();
});
$('#ret-filters').addEventListener('submit', (e) => {
  e.preventDefault();
  $all('#ret-period-presets .segmented__btn').forEach((b) => b.classList.remove('is-active'));
  loadRetention();
});

// ---------- Success Rate ----------
const SR_COLORS = { below: '#c9d0d6', Promising: '#f4c15d', Test: '#6bb5a0', Scale: '#5b82d6', Alpha: '#8b4be0' };
const SR_PILLS = ['#dfeafd', '#dff3e8', '#fdf0cf', '#fae1ec', '#e3ebf6', '#ece3f8'];
let srData = null;

function srEsc(v) {
  return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
const srPct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const srMoney = (x) => '$' + Math.round(x).toLocaleString('ru-RU');
const srCpa = (x) => (x ? '$' + Math.round(x) : '—');
const srTask = (t) => (t.taskId ? '№' + t.taskId : srEsc(t.name));

function srTopLabel(row, isOverall) {
  if (isOverall) {
    const byGrade = {};
    for (const t of row.top) (byGrade[t.grade] ||= []).push(srTask(t));
    return ['Alpha', 'Scale', 'Test', 'Promising'].filter((g) => byGrade[g])
      .map((g) => `${g} ${byGrade[g].join(' і ')}`).join(' • ');
  }
  if (row.top.length) {
    return row.top.slice(0, 4).map((t) => `${t.grade} ${srTask(t)} · ${t.purchases} покупок · CPA ${srCpa(t.cpa)}`).join('  ·  ');
  }
  return row.bestBelow.map((t) => `${srTask(t)} · ${t.purchases} покупок · CPA ${srCpa(t.cpa)}`).join('  ·  ');
}

function srRowHtml(row, label, pill, isOverall) {
  const g = Object.fromEntries(row.grades.map((x) => [x.grade, x]));
  const aboveCount = row.success.count;
  const segs = [
    { key: 'below', pct: g.Bedolaga.pct, count: g.Bedolaga.count },
    ...['Promising', 'Test', 'Scale', 'Alpha'].map((k) => ({ key: k, pct: g[k].pct, count: g[k].count }))
  ].filter((s) => s.count > 0);
  const bar = segs.map((s) => `<span class="sr-seg" style="width:${s.pct * 100}%;background:${SR_COLORS[s.key]}" title="${s.key === 'below' ? 'Bedolaga' : s.key}: ${s.count}">${s.key === 'below' ? `${srPct(s.pct)} (${s.count})` : ''}</span>`).join('');
  return `
    <div class="sr-row">
      <div class="sr-row__left">
        <span class="sr-pill" style="background:${pill}">${srEsc(label)}</span>
        <div class="sr-row__meta">Всего: ${row.total} &nbsp;•&nbsp; Promising+: ${aboveCount}</div>
      </div>
      <div class="sr-row__mid">
        <div class="sr-row__top">
          <span class="sr-row__tops">${srTopLabel(row, isOverall)}</span>
          ${aboveCount ? `<span class="sr-row__abovepct">${srPct(row.success.sr)} (${aboveCount})</span>` : ''}
        </div>
        <div class="sr-bar">${bar || '<span class="sr-seg sr-seg--empty">нет данных</span>'}</div>
      </div>
      <div class="sr-row__right">
        <div class="sr-big">${srPct(row.success.sr)}</div>
        <div class="sr-big__label">Success Rate</div>
      </div>
    </div>`;
}

function renderSuccessRate(data) {
  srData = data;
  const o = data.overall;
  $('#sr-subtitle').innerHTML = `<span>${o.total} КРЕАТИВОВ</span> &nbsp;•&nbsp; <span class="sr-subtitle__b">SUCCESS RATE ПО ВОРОНКАМ</span>`;

  $('#sr-board').innerHTML = [
    srRowHtml(o, 'Загалом', SR_PILLS[0], true),
    ...data.funnels.map((f, i) => srRowHtml(f, f.name, SR_PILLS[(i + 1) % SR_PILLS.length], false))
  ].join('');

  const tops = o.top.map(srTask);
  const list = tops.length > 1 ? tops.slice(0, -1).join(', ') + ' та ' + tops[tops.length - 1] : tops.join('');
  $('#sr-banner').textContent = tops.length
    ? `${o.success.count} ИЗ ${o.total} КРЕАТИВОВ ДОСТИГЛИ PROMISING+: ${list}`
    : `${o.total} КРЕАТИВОВ — НИКТО ПОКА НЕ ДОСТИГ PROMISING+`;
  const best = data.funnels.filter((f) => f.success.count).map((f) => `${f.name}: SR ${srPct(f.success.sr)}`).join('. ');
  const lead = o.top[0] ? `№${o.top[0].taskId} лидирует: ${o.top[0].purchases} покупок, CPA ${srCpa(o.top[0].cpa)}.` : '';
  $('#sr-banner-note').textContent = [best, lead].filter(Boolean).join(' ') +
    (data.withoutAirtable ? `  Креативов без записи в Airtable (теги Unknown): ${data.withoutAirtable}.` : '');

  const scope = $('#sr-scope');
  const prevScope = scope.value;
  scope.innerHTML = `<option value="">Загалом (все воронки)</option>` + data.funnels.map((f) => `<option value="${srEsc(f.name)}">${srEsc(f.name)}</option>`).join('');
  if ([...scope.options].some((op) => op.value === prevScope)) scope.value = prevScope;

  const cat = $('#sr-category');
  const prevCat = cat.value;
  cat.innerHTML = data.categories.map((c) => `<option value="${c.key}">${c.label}</option>`).join('');
  if ([...cat.options].some((op) => op.value === prevCat)) cat.value = prevCat;

  renderSrDetails();
}

function renderSrDetails() {
  if (!srData) return;
  const scopeName = $('#sr-scope').value;
  const key = $('#sr-category').value;
  const block = scopeName ? srData.funnels.find((f) => f.name === scopeName) : srData.overall;
  if (!block) return;
  const dims = block.dimensions[key];

  const gradeRows = block.grades.map((g) => `<tr><td><span class="grade-badge" style="background:${GRADE_BADGE_COLORS[g.grade].bg};color:${GRADE_BADGE_COLORS[g.grade].color}">${g.grade}</span></td><td>${g.count}</td><td>${srPct(g.pct)}</td><td>${srMoney(g.spend)}</td><td>${srPct(g.spendPct)}</td></tr>`).join('');
  const gradeTable = `<table class="table"><thead><tr><th>Grade</th><th>Count</th><th>% крео</th><th>Spend</th><th>% спенда</th></tr></thead><tbody>${gradeRows}
    <tr class="sr-total"><td>✅ Success Rate (P+T+S+A)</td><td>${block.success.count}</td><td>${srPct(block.success.sr)}</td><td>${srMoney(block.success.spend)}</td><td>${srPct(block.success.srSpend)}</td></tr></tbody></table>`;

  const convRows = block.conversions.map((c) => `<tr><td>${c.label}</td><td>${c.from}</td><td>${c.to}</td><td>${srPct(c.pct)}</td></tr>`).join('');
  const convTable = `<table class="table"><thead><tr><th>Переход</th><th>Достигли этапа</th><th>Дошли дальше</th><th>% конверсии</th></tr></thead><tbody>${convRows}</tbody></table>`;

  let dimTable = '<p class="hint">Нет данных</p>';
  if (dims && dims.length) {
    const rows = dims.map((d) => `<tr><td><strong>${srEsc(d.value)}</strong></td><td>${d.total}</td><td>${d.Promising}</td><td>${d.Test}</td><td>${d.Scale}</td><td>${d.Alpha}</td><td>${d.success}</td><td>${srPct(d.sr)}</td><td>${srMoney(d.spend)}</td><td>${srPct(d.srSpend)}</td><td>${srPct(d.promisingToTest, 0)}</td><td>${srPct(d.testToScale, 0)}</td><td>${srPct(d.scaleToAlpha, 0)}</td></tr>`).join('');
    dimTable = `<div class="fmt-table-wrap"><table class="table analytics-table"><thead><tr><th>${srEsc(key)}</th><th>Total</th><th>Promising</th><th>Test</th><th>Scale</th><th>Alpha</th><th>Success</th><th>SR (% крео)</th><th>Spend</th><th>SR (% спенда)</th><th>P→T</th><th>T→S</th><th>S→A</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  $('#sr-details').innerHTML = `
    <div class="sr-details__grid"><div><h4>Розбивка по грейдах</h4>${gradeTable}</div><div><h4>Конверсия между этапами</h4>${convTable}</div></div>
    <h4>По тегу: ${srEsc(key)}</h4>${dimTable}`;
}

$('#sr-scope').addEventListener('change', renderSrDetails);
$('#sr-category').addEventListener('change', renderSrDetails);

async function loadSuccessRate(since, until) {
  $('#sr-status').textContent = 'Загружаю...';
  try {
    const data = await fetchJson(`/api/analytics/success-rate?${new URLSearchParams({ since, until })}`);
    $('#sr-status').textContent = '';
    renderSuccessRate(data);
  } catch (err) {
    $('#sr-status').textContent = 'Ошибка: ' + err.message;
  }
}

// ---------- Эффективность тестирования ----------
const TST_COLORS = ['#0b6b5c', '#4a86d8', '#f2b94c', '#d95f2b', '#8b4be0', '#00acc1'];

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

let tstData = null;
let tstPeopleMode = 'byDesigner';

function renderTstPeople() {
  if (!tstData) return;
  const people = tstData[tstPeopleMode] || [];
  if (!people.length) { $('#tst-people').innerHTML = '<p class="hint">Нет данных</p>'; return; }
  const maxPct = Math.max(0.01, ...people.map((p) => p.buyersPct));
  const label = (n) => (n === 'Unknown' ? 'Нет в Airtable' : srEsc(n));
  $('#tst-people').innerHTML = `<div class="fmt-table-wrap"><table class="table tst-table"><thead><tr>
    <th>${tstPeopleMode === 'byCp' ? 'CP' : 'Дизайнер'}</th><th>Креативы</th><th>Затраты</th><th>Покупки</th><th>% всех покупок</th><th>CPA</th>
    <th>Дали покупку</th><th></th><th>SR Promising+</th></tr></thead><tbody>${people.map((p, i) => `
    <tr class="tst-person" data-i="${i}">
      <td><strong>${label(p.name)}</strong></td><td>${p.creatives}</td><td>${srMoney(p.spend)}</td><td>${p.purchases}</td>
      <td>${srPct(p.purchasesShare)}</td><td>${p.cpa ? '$' + Math.round(p.cpa) : '—'}</td>
      <td class="tst-green"><strong>${p.buyers} из ${p.creatives} · ${srPct(p.buyersPct)}</strong></td>
      <td class="tst-person__bar"><span style="width:${(p.buyersPct / maxPct) * 100}%"></span></td>
      <td>${p.success} из ${p.creatives} · ${srPct(p.sr)}</td>
    </tr>
    <tr class="tst-person__list" data-for="${i}" hidden><td colspan="9">${p.list.map((c) => {
      const gc = GRADE_BADGE_COLORS[c.grade];
      const fullName = String(c.name || '').replace(/\.(mp4|mov|jpg|jpeg|png)$/i, '');
      return `<div class="tst-person__item">
        <span class="grade-badge" style="background:${gc.bg};color:${gc.color}">${c.grade}</span>
        <span class="tst-person__name">${srEsc(fullName)}</span>
        <span class="tst-person__stat">${c.purchases} ${plural(c.purchases, 'покупка', 'покупки', 'покупок')} · CPA ${c.cpa ? '$' + Math.round(c.cpa) : '—'} · ${srMoney(c.spend)}</span></div>`;
    }).join('')}</td></tr>`).join('')}</tbody></table></div>`;
}

$('#tst-people').addEventListener('click', (e) => {
  const row = e.target.closest('.tst-person');
  if (!row) return;
  const list = $('#tst-people').querySelector(`.tst-person__list[data-for="${row.dataset.i}"]`);
  if (list) list.hidden = !list.hidden;
});

$('#tst-people-mode').addEventListener('click', (e) => {
  const btn = e.target.closest('.segmented__btn');
  if (!btn) return;
  tstPeopleMode = btn.dataset.mode;
  $all('#tst-people-mode .segmented__btn').forEach((b) => b.classList.toggle('is-active', b === btn));
  renderTstPeople();
});

function renderTesting(d) {
  const t = d.total;
  $('#tst-subtitle').textContent = `${t.creatives} КРЕАТИВОВ · ОТ ТЕСТА ДО ПОКУПКИ`;

  const kpi = (label, value, cls = '') => `<div class="tst-kpi"><div class="tst-kpi__label">${label}</div><div class="tst-kpi__value ${cls}">${value}</div></div>`;
  $('#tst-kpis').innerHTML = [
    kpi('Затраты', srMoney(t.spend), 'tst-green'),
    kpi('Покупки', t.purchases, 'tst-green'),
    kpi('CPA (blended)', t.cpa ? '$' + Math.round(t.cpa) : '—', 'tst-green'),
    kpi('Протестировано', t.creatives),
    kpi('Дали покупку', `${t.buyers} · ${srPct(t.buyersPct)}`, 'tst-green'),
    kpi('Без покупок', `${t.nonBuyers} · ${srPct(t.nonBuyersPct)}`, 'tst-orange')
  ].join('');

  const rows = d.funnels.map((f, i) => `<tr>
    <td><strong style="color:${i === 0 ? '#0b6b5c' : 'inherit'}">${srEsc(f.name)}</strong></td>
    <td>${f.creatives}</td><td>${srMoney(f.spend)}</td><td>${f.purchases}</td>
    <td>${f.cpa ? '$' + Math.round(f.cpa) : '—'}</td>
    <td class="tst-green"><strong>${f.buyers} из ${f.creatives} · ${srPct(f.buyersPct)}</strong></td></tr>`).join('');
  $('#tst-table').innerHTML = `<div class="fmt-table-wrap"><table class="table tst-table"><thead><tr><th>Воронка</th><th>Креативы</th><th>Затраты</th><th>Покупки</th><th>CPA</th><th>Дали покупку</th></tr></thead><tbody>${rows}</tbody></table></div>`;

  const byShare = d.funnels.slice().sort((a, b) => b.buyersPct - a.buyersPct);
  const maxPct = Math.max(0.01, ...byShare.map((f) => f.buyersPct));
  $('#tst-chart').innerHTML = byShare.map((f, i) => `
    <div class="tst-col-bar">
      <div class="tst-col-bar__val">${srPct(f.buyersPct)}</div>
      <div class="tst-col-bar__fill" style="height:${Math.max(2, (f.buyersPct / maxPct) * 150)}px;background:${TST_COLORS[i % TST_COLORS.length]}"></div>
      <div class="tst-col-bar__label">${srEsc(f.name)}</div>
    </div>`).join('') || '<p class="hint">Нет данных</p>';

  $('#tst-funnel').innerHTML = `
    <div class="tst-funnel__row">
      <div><div class="tst-funnel__big tst-green">${t.buyers} / ${t.creatives}</div><div class="hint">креативов дали покупку</div></div>
      <div><div class="tst-funnel__big tst-orange">${srMoney(t.wastedSpend)}</div><div class="hint">потрачено на ${t.nonBuyers} креативов без покупок · ${srPct(t.wastedPct)} бюджета</div></div>
    </div>
    <div class="tst-progress"><span style="width:${t.buyersPct * 100}%"></span></div>`;

  const withBuys = d.funnels.filter((f) => f.purchases > 0);
  const bestByPurchases = withBuys.slice().sort((a, b) => b.purchases - a.purchases)[0];
  const bestCpa = withBuys.slice().sort((a, b) => a.cpa - b.cpa)[0];
  const enough = d.funnels.filter((f) => f.creatives >= 5);
  const worst = enough.filter((f) => !bestByPurchases || f.name !== bestByPurchases.name).sort((a, b) => a.buyersPct - b.buyersPct)[0];
  const small = d.funnels.filter((f) => f.creatives < 5);
  const parts = [];
  if (bestByPurchases) {
    parts.push(`<div class="tst-concl"><div class="tst-concl__row"><strong class="tst-green">${srEsc(bestByPurchases.name)}</strong><span>${bestByPurchases.purchases} из ${t.purchases} покупок · ${srPct(bestByPurchases.purchasesShare)}</span></div>
      ${bestCpa ? `<div class="tst-concl__row"><span class="hint">Лучший CPA среди воронок (${srEsc(bestCpa.name)})</span><strong class="tst-green tst-concl__big">$${Math.round(bestCpa.cpa)}</strong></div>` : ''}</div>`);
  }
  if (worst) {
    parts.push(`<div class="tst-concl"><div class="tst-concl__row"><strong class="tst-orange">${srEsc(worst.name)}</strong><span>${worst.buyers} из ${worst.creatives} дали покупку · CPA ${worst.cpa ? '$' + Math.round(worst.cpa) : '—'}</span></div></div>`);
  }
  if (small.length) {
    parts.push(`<div class="hint">${small.map((f) => `${srEsc(f.name)}: ${f.creatives} ${plural(f.creatives, 'тест', 'теста', 'тестов')}, ${f.purchases} ${plural(f.purchases, 'покупка', 'покупки', 'покупок')}`).join('; ')}. Данных пока мало для вывода.</div>`);
  }
  $('#tst-conclusions').innerHTML = parts.join('') || '<p class="hint">Нет данных</p>';

  $('#tst-standout').innerHTML = d.standout.map((c, i) => `
    <div class="tst-stand">
      <strong class="tst-stand__id" style="color:${i % 2 ? '#7a4fd6' : '#e8793a'}">${c.taskId ? '№' + c.taskId : srEsc(c.name)}</strong>
      <span>${c.grade !== 'Bedolaga' ? c.grade + ' · ' : ''}${c.purchases} ${plural(c.purchases, 'покупка', 'покупки', 'покупок')} · CPA ${c.cpa ? '$' + (c.cpa < 100 ? c.cpa.toFixed(1).replace(/\.0$/, '') : Math.round(c.cpa)) : '—'}${c.grade === 'Bedolaga' ? ' · Bedolaga' : ''}</span>
    </div>`).join('') || '<p class="hint">Пока нет креативов с покупками</p>';

  tstData = d;
  renderTstPeople();

  $('#tst-footnote').textContent = d.zeroSpend ? `Не учтено креативов с $0 затрат: ${d.zeroSpend}.` : '';
}

async function loadTesting(since, until) {
  $('#sr-status').textContent = 'Загружаю...';
  try {
    const data = await fetchJson(`/api/analytics/testing?${new URLSearchParams({ since, until })}`);
    $('#sr-status').textContent = '';
    renderTesting(data);
  } catch (err) {
    $('#sr-status').textContent = 'Ошибка: ' + err.message;
  }
}

// Смена даты в поле "С"/"По" сразу перезагружает данные и снимает подсветку
// пресета ("Сегодня", "7 дней"...). Раньше нужно было ещё нажимать
// "Показать": если забыть, таблица показывала один период, а в полях стоял
// другой — и цифры в разных разделах расходились.
function bindDateAutoApply(sinceSel, untilSel, presetsSel, reload) {
  for (const sel of [sinceSel, untilSel]) {
    $(sel).addEventListener('change', () => {
      if (!$(sinceSel).value || !$(untilSel).value) return;
      $all(`${presetsSel} .segmented__btn`).forEach((b) => b.classList.remove('is-active'));
      reload();
    });
  }
}
bindDateAutoApply('#analytics-since', '#analytics-until', '#analytics-period-presets', () => loadActiveSubtab());
bindDateAutoApply('#sr-since', '#sr-until', '#sr-period-presets', () => loadSrActiveSubtab());
bindDateAutoApply('#ret-since', '#ret-until', '#ret-period-presets', () => loadRetention());

// ---------- Старт ----------
loadBrands();
