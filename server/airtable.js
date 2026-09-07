// Airtable — креативный продакшн (Task ID, CP, Designer, Creo Type, статусы и
// даты переходов). Названия "When 'X'" полей не хардкодим построчно, а сами
// вычисляем из реальных данных при каждой загрузке — так не зависим от
// точного стиля кавычек/регистра, с которым их создали в интерфейсе Airtable.
const BASE_URL = 'https://api.airtable.com/v0';
const CACHE_TTL_MS = 5 * 60 * 1000;

function config() {
  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableId = process.env.AIRTABLE_TABLE_ID;
  if (!token || !baseId || !tableId) {
    const err = new Error('AIRTABLE_TOKEN / AIRTABLE_BASE_ID / AIRTABLE_TABLE_ID не заданы в server/.env');
    err.status = 500;
    throw err;
  }
  return { token, baseId, tableId };
}

async function fetchAllRawRecords() {
  const { token, baseId, tableId } = config();
  const records = [];
  let offset = null;
  do {
    const url = new URL(`${BASE_URL}/${baseId}/${tableId}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const json = await resp.json();
    if (json.error) { const err = new Error('Airtable: ' + (json.error.message || JSON.stringify(json.error))); err.status = resp.status; throw err; }
    records.push(...(json.records || []));
    offset = json.offset || null;
  } while (offset);
  return records;
}

// Из реальных ключей полей вида "When 'To Test'" / "When \"To do\"" достаём
// нормализованное (нижний регистр) имя стадии -> точное имя поля.
function detectWhenFieldMap(records) {
  const map = {};
  for (const r of records) {
    for (const key of Object.keys(r.fields)) {
      const m = key.match(/^When\s+['"](.+?)['"]$/i);
      if (m) map[m[1].toLowerCase()] = key;
    }
  }
  return map;
}

function pick(fields, whenMap, stageLabel) {
  const key = whenMap[stageLabel.toLowerCase()];
  return key ? fields[key] || null : null;
}

let cache = null; // { at, tasks, whenMap }
async function loadTasks() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;
  const records = await fetchAllRawRecords();
  const whenMap = detectWhenFieldMap(records);

  const tasks = records.map((r) => {
    const f = r.fields;
    return {
      recordId: r.id,
      taskId: f['Task ID'] ?? null,
      taskName: f['Task Name'] || '',
      creoType: f['Creo Type'] === 'V' ? 'Video' : f['Creo Type'] === 'S' ? 'Static' : (f['Creo Type'] || null),
      cp: f['CP'] || null,
      designer: f['Designer'] || null,
      status: f['Status'] || null,
      created: f['Created'] || null,
      whenInProgress: pick(f, whenMap, 'In Progress'),
      whenToTest: pick(f, whenMap, 'To Test'),
      whenToDo: pick(f, whenMap, 'To Do') || pick(f, whenMap, 'To do'),
      whenSentUA: pick(f, whenMap, 'Sent UA') || pick(f, whenMap, 'Send UA')
    };
  });

  cache = { at: Date.now(), tasks, whenMap };
  return cache;
}

function inRange(dateStr, since, until) {
  if (!dateStr) return false;
  const day = dateStr.slice(0, 10);
  return day >= since && day <= until;
}

// Вкладка "Продакшн": сколько задач дошло до "To Test" за период, видео/статика,
// и отдельная разбивка по дизайнерам.
async function productionReport(since, until) {
  const { tasks } = await loadTasks();
  const inWindow = tasks.filter((t) => inRange(t.whenToTest, since, until));
  const byDesigner = {};
  let video = 0; let staticCount = 0;
  for (const t of inWindow) {
    if (t.creoType === 'Video') video++; else if (t.creoType === 'Static') staticCount++;
    const d = t.designer || '—';
    if (!byDesigner[d]) byDesigner[d] = { designer: d, total: 0, video: 0, static: 0 };
    byDesigner[d].total++;
    if (t.creoType === 'Video') byDesigner[d].video++; else if (t.creoType === 'Static') byDesigner[d].static++;
  }
  return {
    total: inWindow.length,
    video,
    static: staticCount,
    byDesigner: Object.values(byDesigner).sort((a, b) => b.total - a.total)
  };
}

// Вкладка "CP": сколько задач перевели в "To Do" по дням, видео/статика,
// и разбивка по тому, кто из CP поставил задачу.
async function cpReport(since, until) {
  const { tasks } = await loadTasks();
  const inWindow = tasks.filter((t) => inRange(t.whenToDo, since, until));
  const byDay = {};
  const byCp = {};
  let video = 0; let staticCount = 0;
  for (const t of inWindow) {
    const day = t.whenToDo.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
    const cp = t.cp || '—';
    if (!byCp[cp]) byCp[cp] = { cp, total: 0, video: 0, static: 0 };
    byCp[cp].total++;
    if (t.creoType === 'Video') { byCp[cp].video++; video++; }
    else if (t.creoType === 'Static') { byCp[cp].static++; staticCount++; }
  }
  return {
    total: inWindow.length,
    video,
    static: staticCount,
    byDay: Object.entries(byDay).map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day)),
    byCp: Object.values(byCp).sort((a, b) => b.total - a.total)
  };
}

// Вкладка "Утилизация": сколько задач вошло в "To Test" за период, сколько из
// них уже дошло до "Sent UA" (и за сколько часов), сколько ещё висит.
// Важно: поле "When Sent UA" только что подключено — для задач ДО его
// включения completed будет 0 даже если они реально давно отправлены,
// это ограничение данных, а не баг.
async function utilizationReport(since, until) {
  const { tasks } = await loadTasks();
  const enteredToTest = tasks.filter((t) => inRange(t.whenToTest, since, until));
  const completed = enteredToTest.filter((t) => t.whenSentUA);
  const pending = enteredToTest.filter((t) => !t.whenSentUA);
  const durationsHours = completed
    .map((t) => (new Date(t.whenSentUA) - new Date(t.whenToTest)) / 3600000)
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  const avgHours = durationsHours.length ? durationsHours.reduce((s, h) => s + h, 0) / durationsHours.length : null;
  const medianHours = durationsHours.length ? durationsHours[Math.floor(durationsHours.length / 2)] : null;

  return {
    enteredToTest: enteredToTest.length,
    completed: completed.length,
    pending: pending.length,
    avgHours,
    medianHours,
    pendingTasks: pending.map((t) => ({
      taskId: t.taskId, taskName: t.taskName, whenToTest: t.whenToTest, designer: t.designer, cp: t.cp
    }))
  };
}

module.exports = { loadTasks, inRange, productionReport, cpReport, utilizationReport };
