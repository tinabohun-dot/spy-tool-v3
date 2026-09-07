// Ежедневная проверка (11:00 по Варшаве) — появились ли среди своих
// креативов (Аналитика, metaMarketing) новые с грейдом Promising и выше за
// прошедшие сутки. Каждый такой креатив шлём в Slack один раз — ключ
// (название) сохраняем в notified_top_creatives, чтобы не дублировать
// уведомление на следующих проверках.
const db = require('./db');
const metaMarketing = require('./metaMarketing');

function warsawDateString(daysAgo = 0) {
  const now = new Date(Date.now() - daysAgo * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(now);
}

async function postToSlack(text) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) { console.warn('SLACK_WEBHOOK_URL не задан в server/.env — пропускаю отправку'); return; }
  const resp = await fetch(webhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text })
  });
  if (!resp.ok) console.error('Slack webhook ответил ошибкой:', resp.status, await resp.text().catch(() => ''));
}

// Тот же порядок грейдов, что и в сортировке аналитики на фронте — уведомляем
// только когда креатив поднялся ВЫШЕ по грейду, чем в прошлый раз, когда мы
// его видели (или раньше вообще не был в Promising+). Если держится на том
// же грейде или просел ниже — молчим.
const GRADE_RANK = { 'Alpha': 5, 'Scale': 4, 'Test': 3, 'Promising': 2, 'Bad': 1, 'No purchases': 0 };

function lastKnownGrade(key) {
  return db.prepare('SELECT grade FROM notified_top_creatives WHERE creative_key = ?').get(key)?.grade || null;
}

function isGradeUpgrade(key, grade) {
  const prevGrade = lastKnownGrade(key);
  if (!prevGrade) return true;
  return (GRADE_RANK[grade] ?? -1) > (GRADE_RANK[prevGrade] ?? -1);
}

function markNotified(key, grade) {
  db.prepare(`
    INSERT INTO notified_top_creatives (creative_key, grade, notified_at) VALUES (?, ?, ?)
    ON CONFLICT(creative_key) DO UPDATE SET grade = excluded.grade, notified_at = excluded.notified_at
  `).run(key, grade, new Date().toISOString());
}

async function checkNewTopCreatives() {
  const accNames = Object.keys(metaMarketing.accounts());
  if (!accNames.length) { console.warn('[slack-alert] META_MARKETING_ACCOUNTS не задан — пропускаю проверку'); return; }

  const since = warsawDateString(1);
  const until = warsawDateString(1);
  const allRows = await metaMarketing.fetchAllAccountsInsights(since, until);
  const creatives = metaMarketing.groupRowsByCreative(allRows).map(metaMarketing.buildCreativeEntry);

  const topCreatives = creatives.filter((c) => metaMarketing.SUCCESS_GRADES.includes(c.grade));
  const upgraded = topCreatives.filter((c) => isGradeUpgrade(c.name, c.grade));

  console.log(`[slack-alert] ${since}: ${topCreatives.length} креативов Promising+, ${upgraded.length} поднялись по грейду`);

  for (const c of upgraded) {
    const prevGrade = lastKnownGrade(c.name);
    const transition = prevGrade ? `${prevGrade} → *${c.grade}*` : `новый в *${c.grade}*`;
    const text = [
      `🚀 Креатив поднялся по грейду: *${c.name}*`,
      `${transition} · Воронка: ${c.funnel || '—'} · Аккаунты: ${(c.accounts || []).join(', ')}`,
      `Spend: $${Math.round(c.spend)} · Purchases: ${c.purchases} · CPA: ${c.cpa ? '$' + c.cpa.toFixed(2) : '—'}`
    ].join('\n');
    await postToSlack(text);
    markNotified(c.name, c.grade);
  }
}

module.exports = { checkNewTopCreatives };
