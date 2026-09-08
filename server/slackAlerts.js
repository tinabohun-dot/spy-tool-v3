// Ежедневная проверка (11:00 по Варшаве) — появились ли среди своих
// креативов (Аналитика, metaMarketing) новые с грейдом Promising и выше за
// прошедшие сутки. Каждый такой креатив шлём в Slack один раз — ключ
// (название) сохраняем в notified_top_creatives, чтобы не дублировать
// уведомление на следующих проверках.
const db = require('./db');
const metaMarketing = require('./metaMarketing');
const airtable = require('./airtable');

// Достаём ссылку на видео в Google Drive по ведущему номеру задачи в имени
// креатива (как и везде в приложении — "398_V_N1_..." -> 398), сверяясь с
// полем "Creatives GDrive URL" в Airtable.
async function findDriveUrl(creativeName) {
  const m = (creativeName || '').match(/^(\d+)/);
  if (!m) return null;
  try {
    const { tasks } = await airtable.loadTasks();
    const task = tasks.find((t) => String(t.taskId) === m[1]);
    return task?.driveUrl || null;
  } catch (e) {
    console.error('[slack-alert] Не удалось получить GDrive-ссылку из Airtable:', e.message);
    return null;
  }
}

function warsawDateString(daysAgo = 0) {
  const now = new Date(Date.now() - daysAgo * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(now);
}

// Те же цвета, что и у бейджа грейда в самом приложении (GRADE_BADGE_COLORS
// в app.js) — используются как цветная полоса слева у сообщения в Slack.
const GRADE_COLORS = {
  'Alpha': '#1b5e20',
  'Scale': '#0d47a1',
  'Test': '#e65100',
  'Promising': '#4a148c',
  'Bad': '#7f0000',
  'No purchases': '#b71c1c'
};

async function postToSlack(payload) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) { console.warn('SLACK_WEBHOOK_URL не задан в server/.env — пропускаю отправку'); return; }
  const resp = await fetch(webhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  if (!resp.ok) console.error('Slack webhook ответил ошибкой:', resp.status, await resp.text().catch(() => ''));
}

async function postCreativeAlert(c, headline, driveUrl) {
  const lines = [
    `Grade: *${c.grade}* · Воронка: ${c.funnel || '—'} · Аккаунты: ${(c.accounts || []).join(', ')}`,
    `Spend: $${Math.round(c.spend)} · Purchases: ${c.purchases} · CPA: ${c.cpa ? '$' + c.cpa.toFixed(2) : '—'}`
  ];
  if (driveUrl) lines.push(driveUrl);
  await postToSlack({
    attachments: [{
      color: GRADE_COLORS[c.grade] || '#999999',
      title: `${headline}: ${c.name}`,
      text: lines.join('\n'),
      ...(c.previewUrl ? { image_url: c.previewUrl } : {})
    }]
  });
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
  await metaMarketing.attachPreviews(upgraded);

  console.log(`[slack-alert] ${since}: ${topCreatives.length} креативов Promising+, ${upgraded.length} поднялись по грейду`);

  for (const c of upgraded) {
    const prevGrade = lastKnownGrade(c.name);
    const headline = prevGrade ? `🚀 ${prevGrade} → ${c.grade}` : `🚀 Новый в ${c.grade}`;
    const driveUrl = await findDriveUrl(c.name);
    await postCreativeAlert(c, headline, driveUrl);
    markNotified(c.name, c.grade);
  }
}

// Разовая ручная рассылка — все текущие топ-креативы (Promising+) за
// указанную дату (по умолчанию вчера), без проверки "уже писали или нет".
// Для пересылки уже отправленных ранее креативов в новом формате (с
// превью/цветом) — не трогает notified_top_creatives.
async function resendTopCreatives(daysAgo = 1) {
  const day = warsawDateString(daysAgo);
  const allRows = await metaMarketing.fetchAllAccountsInsights(day, day);
  const creatives = metaMarketing.groupRowsByCreative(allRows).map(metaMarketing.buildCreativeEntry);
  const topCreatives = creatives.filter((c) => metaMarketing.SUCCESS_GRADES.includes(c.grade));
  await metaMarketing.attachPreviews(topCreatives);

  console.log(`[slack-alert] resend ${day}: ${topCreatives.length} креативов Promising+`);
  for (const c of topCreatives) {
    const driveUrl = await findDriveUrl(c.name);
    await postCreativeAlert(c, '🚀 Топ-креатив', driveUrl);
  }
}

module.exports = { checkNewTopCreatives, resendTopCreatives };
