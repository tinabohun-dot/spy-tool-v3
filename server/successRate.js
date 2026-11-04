// Success Rate по воронкам и тегам — расчёт один в один как в личном
// Google Apps Script пользователя (calculateSuccessRates): успешный креатив =
// Promising / Test / Scale / Alpha, воронка креатива = кампания, где он
// потратил больше всего, теги подтягиваются из Airtable по Task ID.
const metaMarketing = require('./metaMarketing');
const airtable = require('./airtable');

const SUCCESS_GRADES = metaMarketing.SUCCESS_GRADES;
const ALL_GRADES = ['Bedolaga', 'Promising', 'Test', 'Scale', 'Alpha'];
const GRADE_RANK = { Bedolaga: 1, Promising: 2, Test: 3, Scale: 4, Alpha: 5 };

const DIMENSIONS = [
  ['Format', 'Format'], ['Flow', 'Flow'], ['ConceptType', 'Concept Type'], ['Concept', 'Concept'],
  ['Theme', 'Theme'], ['Pain', 'Pain'], ['ModelType', 'Model Type'], ['Visual', 'Visual'],
  ['VisualAngle', 'Visual Angle'], ['Gender', 'Gender'], ['Audience', 'Audience'],
  ['CP', 'CP'], ['Designer', 'Designer'], ['Source', 'Source']
];

const sum = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0);
const ratio = (a, b) => (b > 0 ? a / b : 0);
const reached = (recs, grades) => recs.filter((r) => grades.includes(r.grade)).length;

function conversions(recs) {
  const pPlus = reached(recs, ['Promising', 'Test', 'Scale', 'Alpha']);
  const tPlus = reached(recs, ['Test', 'Scale', 'Alpha']);
  const sPlus = reached(recs, ['Scale', 'Alpha']);
  const alpha = reached(recs, ['Alpha']);
  return [
    { label: 'Promising → Test', from: pPlus, to: tPlus, pct: ratio(tPlus, pPlus) },
    { label: 'Test → Scale', from: tPlus, to: sPlus, pct: ratio(sPlus, tPlus) },
    { label: 'Scale → Alpha', from: sPlus, to: alpha, pct: ratio(alpha, sPlus) }
  ];
}

function block(recs) {
  const spend = sum(recs, (r) => r.spend);
  const success = recs.filter((r) => SUCCESS_GRADES.includes(r.grade));
  const successSpend = sum(success, (r) => r.spend);
  return {
    total: recs.length,
    spend,
    grades: ALL_GRADES.map((g) => {
      const inGrade = recs.filter((r) => r.grade === g);
      const gSpend = sum(inGrade, (r) => r.spend);
      return { grade: g, count: inGrade.length, pct: ratio(inGrade.length, recs.length), spend: gSpend, spendPct: ratio(gSpend, spend) };
    }),
    success: {
      count: success.length,
      spend: successSpend,
      sr: ratio(success.length, recs.length),
      srSpend: ratio(successSpend, spend)
    },
    conversions: conversions(recs),
    top: success
      .slice()
      .sort((a, b) => GRADE_RANK[b.grade] - GRADE_RANK[a.grade] || b.purchases - a.purchases)
      .map((r) => ({ taskId: r.taskId, name: r.name, grade: r.grade, purchases: r.purchases, cpa: r.cpa, spend: r.spend })),
    bestBelow: recs
      .filter((r) => !SUCCESS_GRADES.includes(r.grade) && r.purchases > 0)
      .sort((a, b) => b.purchases - a.purchases)
      .slice(0, 3)
      .map((r) => ({ taskId: r.taskId, name: r.name, grade: r.grade, purchases: r.purchases, cpa: r.cpa, spend: r.spend }))
  };
}

function dimensionTable(recs, key) {
  const values = [...new Set(recs.map((r) => r[key]))];
  return values.map((value) => {
    const inVal = recs.filter((r) => r[key] === value);
    const count = (g) => inVal.filter((r) => r.grade === g).length;
    const spend = sum(inVal, (r) => r.spend);
    const success = inVal.filter((r) => SUCCESS_GRADES.includes(r.grade));
    const successSpend = sum(success, (r) => r.spend);
    const [pt, ts, sa] = conversions(inVal);
    return {
      value, total: inVal.length,
      Promising: count('Promising'), Test: count('Test'), Scale: count('Scale'), Alpha: count('Alpha'),
      success: success.length,
      sr: ratio(success.length, inVal.length),
      spend,
      srSpend: ratio(successSpend, spend),
      promisingToTest: pt.pct, testToScale: ts.pct, scaleToAlpha: sa.pct
    };
  }).sort((a, b) => b.total - a.total);
}

function dimensions(recs, withFunnel) {
  const out = {};
  for (const [key] of DIMENSIONS) out[key] = dimensionTable(recs, key);
  if (withFunnel) out.Funnel = dimensionTable(recs, 'funnel');
  return out;
}

async function successRateReport(since, until) {
  const allRows = await metaMarketing.fetchAllAccountsInsights(since, until);
  const creatives = metaMarketing.groupRowsByCreative(allRows).map(metaMarketing.buildCreativeEntry);

  let tasksByTaskId = {};
  try {
    const { tasks } = await airtable.loadTasks();
    for (const t of tasks) if (t.taskId != null) tasksByTaskId[String(t.taskId).trim()] = t;
  } catch (err) {
    console.warn('[success-rate] Airtable недоступен, теги будут Unknown:', err.message);
  }

  let withoutAirtable = 0;
  const recs = creatives.map((c) => {
    const m = String(c.name || '').trim().match(/^(\d+)/);
    const taskId = m ? m[1] : null;
    const at = taskId ? tasksByTaskId[taskId] : null;
    if (!at) withoutAirtable++;
    const tags = (at && at.tags) || {};
    const rec = {
      taskId, name: c.name, grade: c.grade, spend: c.spend, purchases: c.purchases, cpa: c.cpa,
      funnel: c.primaryFunnel || 'Другое',
      Format: (at && at.creoType) || 'Unknown',
      CP: (at && at.cp) || 'Unknown',
      Designer: (at && at.designer) || 'Unknown'
    };
    for (const [key] of DIMENSIONS) if (!(key in rec)) rec[key] = tags[key] || 'Unknown';
    return rec;
  });

  const funnelNames = [...new Set(recs.map((r) => r.funnel))];
  const funnels = funnelNames.map((name) => {
    const subset = recs.filter((r) => r.funnel === name);
    return { name, ...block(subset), dimensions: dimensions(subset, false) };
  }).sort((a, b) => b.total - a.total);

  return {
    since, until,
    categories: [...DIMENSIONS.map(([key, label]) => ({ key, label })), { key: 'Funnel', label: 'Funnel' }],
    withoutAirtable,
    overall: { ...block(recs), dimensions: dimensions(recs, true) },
    funnels
  };
}

// Эффективность тестирования: от теста до покупки. Тестом считаем креатив,
// на который реально потрачены деньги (spend > 0); "дал покупку" —
// purchases > 0. Воронка креатива — кампания с наибольшим spend (как в SR).
async function testingReport(since, until) {
  const allRows = await metaMarketing.fetchAllAccountsInsights(since, until);
  const all = metaMarketing.groupRowsByCreative(allRows).map(metaMarketing.buildCreativeEntry);
  const creatives = all.filter((c) => c.spend > 0);
  const zeroSpend = all.length - creatives.length;

  const pack = (c) => {
    const m = String(c.name || '').trim().match(/^(\d+)/);
    return { taskId: m ? m[1] : null, name: c.name, grade: c.grade, purchases: c.purchases, cpa: c.cpa, spend: c.spend };
  };

  // Дизайнер и CP креатива — из Airtable по Task ID (начало названия).
  const tasksByTaskId = {};
  try {
    const { tasks } = await airtable.loadTasks();
    for (const t of tasks) if (t.taskId != null) tasksByTaskId[String(t.taskId).trim()] = t;
  } catch (err) {
    console.warn('[testing] Airtable недоступен, дизайнеры/CP будут Unknown:', err.message);
  }
  const personOf = (c, field) => {
    const m = String(c.name || '').trim().match(/^(\d+)/);
    const t = m ? tasksByTaskId[m[1]] : null;
    return (t && t[field]) || 'Unknown';
  };
  const byPerson = (field) => {
    const names = [...new Set(creatives.map((c) => personOf(c, field)))];
    return names.map((name) => {
      const subset = creatives.filter((c) => personOf(c, field) === name);
      const pSpend = sum(subset, (c) => c.spend);
      const pPurchases = sum(subset, (c) => c.purchases);
      const pBuyers = subset.filter((c) => c.purchases > 0).length;
      const pSuccess = subset.filter((c) => SUCCESS_GRADES.includes(c.grade)).length;
      return {
        name, creatives: subset.length, spend: pSpend, purchases: pPurchases,
        cpa: pPurchases > 0 ? pSpend / pPurchases : null,
        buyers: pBuyers, buyersPct: ratio(pBuyers, subset.length),
        success: pSuccess, sr: ratio(pSuccess, subset.length),
        purchasesShare: ratio(pPurchases, purchases),
        list: subset.slice().sort((a, b) => b.purchases - a.purchases || b.spend - a.spend).map(pack)
      };
    }).sort((a, b) => b.creatives - a.creatives);
  };

  const spend = sum(creatives, (c) => c.spend);
  const purchases = sum(creatives, (c) => c.purchases);
  const buyers = creatives.filter((c) => c.purchases > 0);
  const nonBuyers = creatives.filter((c) => c.purchases === 0);
  const wastedSpend = sum(nonBuyers, (c) => c.spend);

  const names = [...new Set(creatives.map((c) => c.primaryFunnel || 'Другое'))];
  const funnels = names.map((name) => {
    const subset = creatives.filter((c) => (c.primaryFunnel || 'Другое') === name);
    const fSpend = sum(subset, (c) => c.spend);
    const fPurchases = sum(subset, (c) => c.purchases);
    const fBuyers = subset.filter((c) => c.purchases > 0).length;
    return {
      name, creatives: subset.length, spend: fSpend, purchases: fPurchases,
      cpa: fPurchases > 0 ? fSpend / fPurchases : null,
      buyers: fBuyers, buyersPct: ratio(fBuyers, subset.length),
      purchasesShare: ratio(fPurchases, purchases)
    };
  }).sort((a, b) => b.spend - a.spend);

  const byPurchases = buyers.slice().sort((a, b) => b.purchases - a.purchases);
  const standout = byPurchases.slice(0, 3).map(pack);
  const bestCpa = buyers.filter((c) => c.purchases >= 5 && c.cpa != null).sort((a, b) => a.cpa - b.cpa)[0];
  if (bestCpa && !standout.some((x) => x.name === bestCpa.name)) standout.push(pack(bestCpa));

  return {
    since, until,
    total: {
      creatives: creatives.length, spend, purchases,
      cpa: purchases > 0 ? spend / purchases : null,
      buyers: buyers.length, buyersPct: ratio(buyers.length, creatives.length),
      nonBuyers: nonBuyers.length, nonBuyersPct: ratio(nonBuyers.length, creatives.length),
      wastedSpend, wastedPct: ratio(wastedSpend, spend)
    },
    funnels,
    byDesigner: byPerson('designer'),
    byCp: byPerson('cp'),
    standout,
    zeroSpend
  };
}


// Недельная динамика: для каждой недели (пн–вс) креативы с расходом, расход,
// покупки, CPA и Positive-tier rate (доля креативов с грейдом Promising+,
// грейд считается по данным самой недели — одни и те же креативы могут
// встречаться в соседних неделях). Незавершённая неделя помечается partial и
// не участвует в "лучшая/слабая неделя" и в сравнении первой и последней.
const DAY_MS = 86400000;
const isoDay = (d) => d.toISOString().slice(0, 10);

function weekRanges(endDate, weeks) {
  const end = new Date(endDate + 'T00:00:00Z');
  const lastMonday = new Date(end.getTime() - ((end.getUTCDay() + 6) % 7) * DAY_MS);
  const todayIso = isoDay(new Date());
  return Array.from({ length: weeks }, (_, i) => {
    const monday = new Date(lastMonday.getTime() - (weeks - 1 - i) * 7 * DAY_MS);
    const sunday = new Date(monday.getTime() + 6 * DAY_MS);
    return { since: isoDay(monday), until: isoDay(sunday), partial: isoDay(sunday) >= todayIso };
  });
}

async function weeklyReport(endDate, weeks) {
  const ranges = weekRanges(endDate, weeks);
  const results = new Array(ranges.length);
  let next = 0;
  // Не больше 3 недель одновременно, чтобы не упереться в лимиты Meta.
  await Promise.all(Array.from({ length: Math.min(3, ranges.length) }, async () => {
    while (next < ranges.length) {
      const i = next++;
      const { since, until } = ranges[i];
      const rows = await metaMarketing.fetchAllAccountsInsights(since, until);
      const creatives = metaMarketing.groupRowsByCreative(rows).map(metaMarketing.buildCreativeEntry).filter((c) => c.spend > 0);
      const spend = sum(creatives, (c) => c.spend);
      const purchases = sum(creatives, (c) => c.purchases);
      const positive = creatives.filter((c) => SUCCESS_GRADES.includes(c.grade)).length;
      results[i] = {
        ...ranges[i],
        creatives: creatives.length, spend, purchases,
        cpa: purchases > 0 ? spend / purchases : null,
        positive, positiveRate: ratio(positive, creatives.length)
      };
    }
  }));

  const done = results.filter((w) => !w.partial && w.creatives > 0);
  const pool = done.length ? done : results.filter((w) => w.creatives > 0);
  const withCpa = pool.filter((w) => w.cpa != null);
  const best = withCpa.length ? withCpa.reduce((a, b) => (b.cpa < a.cpa ? b : a)) : null;
  const weakest = withCpa.length > 1 ? withCpa.reduce((a, b) => (b.cpa > a.cpa ? b : a)) : null;
  const mostPurchases = pool.length ? pool.reduce((a, b) => (b.purchases > a.purchases ? b : a)) : null;
  const first = pool[0] || null;
  const last = pool.length > 1 ? pool[pool.length - 1] : null;
  const change = (a, b) => (a > 0 ? (b - a) / a : null);
  return {
    weeks: results,
    best: best && best.since, weakest: weakest && weakest.since, mostPurchases: mostPurchases && mostPurchases.since,
    trend: first && last ? {
      from: first.since, to: last.since,
      purchasesPct: change(first.purchases, last.purchases),
      spendPct: change(first.spend, last.spend),
      rateFrom: first.positiveRate, rateTo: last.positiveRate,
      cpaFrom: first.cpa, cpaTo: last.cpa
    } : null
  };
}

module.exports = { successRateReport, testingReport, weeklyReport };
