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
      funnel: (f['Funnel'] || [])[0] || null,
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

function previousEquivalentPeriod(since, until) {
  const DAY = 86400000;
  const sinceDate = new Date(since + 'T00:00:00');
  const untilDate = new Date(until + 'T00:00:00');
  const lengthDays = Math.round((untilDate - sinceDate) / DAY) + 1;
  const prevUntilDate = new Date(sinceDate.getTime() - DAY);
  const prevSinceDate = new Date(prevUntilDate.getTime() - (lengthDays - 1) * DAY);
  return { since: prevSinceDate.toISOString().slice(0, 10), until: prevUntilDate.toISOString().slice(0, 10) };
}

// Вкладка "Продакшн": сколько задач дошло до "To Test" за период — по дням,
// видео/статика, разбивка по дизайнерам и воронкам, % к предыдущему периоду
// такой же длины, и сколько из произведённого реально "напущено" в Meta
// (Task ID встречается среди реальных объявлений в аккаунтах).
function pushTask(map, key, t) {
  (map[key] ||= []).push({ taskId: t.taskId, taskName: t.taskName });
}

async function productionReport(since, until, launchedTaskNumbers) {
  const { tasks } = await loadTasks();
  const inWindow = tasks.filter((t) => inRange(t.whenToTest, since, until));

  const byDay = {};
  const byDesigner = {};
  const byDesignerTasks = {};
  const byFunnel = {};
  let video = 0; let staticCount = 0; let launched = 0;

  for (const t of inWindow) {
    const day = t.whenToTest.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;

    if (t.creoType === 'Video') video++; else if (t.creoType === 'Static') staticCount++;

    const d = t.designer || '—';
    byDesigner[d] = (byDesigner[d] || 0) + 1;
    pushTask(byDesignerTasks, d, t);

    const funnel = t.funnel || '—';
    byFunnel[funnel] = (byFunnel[funnel] || 0) + 1;

    if (launchedTaskNumbers && t.taskId != null && launchedTaskNumbers.has(String(t.taskId))) launched++;
  }

  const prevPeriod = previousEquivalentPeriod(since, until);
  const prevTotal = tasks.filter((t) => inRange(t.whenToTest, prevPeriod.since, prevPeriod.until)).length;
  const pctChange = prevTotal ? Math.round(((inWindow.length - prevTotal) / prevTotal) * 100) : null;

  return {
    total: inWindow.length,
    prevTotal,
    pctChange,
    video,
    static: staticCount,
    launched,
    notLaunched: inWindow.length - launched,
    byDay: Object.entries(byDay).map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day)),
    byDesigner: Object.fromEntries(Object.entries(byDesigner).sort((a, b) => b[1] - a[1])),
    byDesignerTasks,
    byFunnel: Object.fromEntries(Object.entries(byFunnel).sort((a, b) => b[1] - a[1]))
  };
}

// Вкладка "CP": сколько задач CP поставили в очередь (перевели в "To Do") по
// дням, видео/статика, разбивка по тому, какой CP поставил задачу. Не
// зависит от Design/UA — отдельная метрика по своей дате.
async function cpReport(since, until) {
  const { tasks } = await loadTasks();
  const inWindow = tasks.filter((t) => inRange(t.whenToDo, since, until));

  const byDay = {};
  const byCp = {};
  const byCpTasks = {};
  let video = 0; let staticCount = 0;

  for (const t of inWindow) {
    const day = t.whenToDo.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
    if (t.creoType === 'Video') video++; else if (t.creoType === 'Static') staticCount++;
    const cp = t.cp || '—';
    byCp[cp] = (byCp[cp] || 0) + 1;
    pushTask(byCpTasks, cp, t);
  }

  const prevPeriod = previousEquivalentPeriod(since, until);
  const prevTotal = tasks.filter((t) => inRange(t.whenToDo, prevPeriod.since, prevPeriod.until)).length;
  const pctChange = prevTotal ? Math.round(((inWindow.length - prevTotal) / prevTotal) * 100) : null;

  return {
    total: inWindow.length,
    prevTotal,
    pctChange,
    video,
    static: staticCount,
    byDay: Object.entries(byDay).map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day)),
    byCp: Object.fromEntries(Object.entries(byCp).sort((a, b) => b[1] - a[1])),
    byCpTasks
  };
}

// Вкладка "UA": сколько задач UA запустили (перевели в "Sent UA") по дням, с
// разбивкой по ВОРОНКЕ (не по CP — сколько запустил конкретный человек тут
// не важно), видео/статика с разбивкой по номерам задач, и утилизация
// очереди "Ready to Test" (сколько ждёт запуска и какая доля реально ушла).
async function uaReport(since, until) {
  const { tasks } = await loadTasks();
  const inWindow = tasks.filter((t) => inRange(t.whenSentUA, since, until));

  const byDay = {};
  const byFunnel = {};
  const byDayFunnel = {};
  const byDayFunnelTasks = {};
  const byFunnelTasksByDay = {};
  const formatTasks = { Video: [], Static: [] };
  let video = 0; let staticCount = 0;

  for (const t of inWindow) {
    const day = t.whenSentUA.slice(0, 10);
    const funnel = t.funnel || '—';
    byDay[day] = (byDay[day] || 0) + 1;

    if (t.creoType === 'Video') { video++; formatTasks.Video.push({ taskId: t.taskId, taskName: t.taskName }); }
    else if (t.creoType === 'Static') { staticCount++; formatTasks.Static.push({ taskId: t.taskId, taskName: t.taskName }); }

    byFunnel[funnel] = (byFunnel[funnel] || 0) + 1;

    (byDayFunnel[day] ||= {});
    byDayFunnel[day][funnel] = (byDayFunnel[day][funnel] || 0) + 1;
    (byDayFunnelTasks[day] ||= {});
    pushTask(byDayFunnelTasks[day], funnel, t);
    (byFunnelTasksByDay[funnel] ||= {});
    pushTask(byFunnelTasksByDay[funnel], day, t);
  }

  const prevPeriod = previousEquivalentPeriod(since, until);
  const prevTotal = tasks.filter((t) => inRange(t.whenSentUA, prevPeriod.since, prevPeriod.until)).length;
  const pctChange = prevTotal ? Math.round(((inWindow.length - prevTotal) / prevTotal) * 100) : null;

  // Airtable не хранит дату входа в статус "Ready Test", поэтому запас —
  // это то, что СЕЙЧАС стоит в этом статусе (снимок на текущий момент, не
  // привязан к периоду). "Передано в To Test за период" и "Запущено за
  // период" — обычные метрики по датам. Утилизация — какая доля из пула
  // (текущий запас + то, что уже запущено из него за период) реально ушла.
  const readyTestBacklogNow = tasks.filter((t) => t.status === 'Ready Test').length;
  const newToTestInPeriod = tasks.filter((t) => inRange(t.whenToTest, since, until)).length;
  const launchedInPeriod = inWindow.length;
  const availablePool = readyTestBacklogNow + launchedInPeriod;
  const utilizationPct = availablePool > 0 ? Math.round((launchedInPeriod / availablePool) * 100) : null;

  return {
    total: inWindow.length,
    prevTotal,
    pctChange,
    video,
    static: staticCount,
    byDay: Object.entries(byDay).map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day)),
    byDayFunnel,
    byDayFunnelTasks,
    byFunnel: Object.fromEntries(Object.entries(byFunnel).sort((a, b) => b[1] - a[1])),
    byFunnelTasksByDay,
    formatTasks,
    readyTest: {
      backlogNow: readyTestBacklogNow,
      newToTestInPeriod,
      launchedInPeriod,
      utilizationPct
    }
  };
}

module.exports = { loadTasks, inRange, productionReport, cpReport, uaReport };
