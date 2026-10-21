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

module.exports = { successRateReport };
