// Ежедневная проверка — появились ли среди своих креативов (Аналитика,
// metaMarketing) новые с грейдом Promising и выше за последние 7 дней
// (скользящее окно, конец окна — вчера), а также упал ли кто-то из ранее
// топовых креативов ниже Promising (в Bad/No purchases).
// Запускается не по расписанию, а первым визитом на сайт после 10:00 по
// Варшаве (см. maybeRunMorningTopCreoCheck в index.js) — на бесплатном
// Render процесс спит без запросов, и cron на точное время мог просто не
// сработать. Каждый поднявшийся по грейду креатив шлём в Slack один раз —
// ключ (название) сохраняем в notified_top_creatives, чтобы не дублировать
// уведомление на следующих проверках.
const db = require('./db');
const metaMarketing = require('./metaMarketing');
const googleDrive = require('./googleDrive');

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

// Slack не умеет красить отдельные слова в тексте сообщения — ближайший
// рабочий аналог цвета грейда прямо у слова это цветной эмодзи-кружок.
const GRADE_EMOJI = {
  'Alpha': '🟢',
  'Scale': '🔵',
  'Test': '🟠',
  'Promising': '🟣',
  'Bad': '🔴',
  'No purchases': '🔴'
};

async function postToSlack(payload) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) { console.warn('SLACK_WEBHOOK_URL не задан в server/.env — пропускаю отправку'); return; }
  const resp = await fetch(webhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  if (!resp.ok) console.error('Slack webhook ответил ошибкой:', resp.status, await resp.text().catch(() => ''));
}

// Общий грейд считается по сумме всех аккаунтов, где запущен креатив, — но
// сумма может маскировать, что результат на самом деле тянет один аккаунт, а
// на другом покупок нет вовсе. Поэтому дополнительно раскладываем purchases/
// CPA по каждому аккаунту (не пересчитывая сам грейд) — только когда
// аккаунтов больше одного, иначе разбивка совпадала бы с итогом.
function buildAccountBreakdown(creative, allRows) {
  const rowsByAccount = {};
  for (const row of allRows) {
    if (!creative.adIds.includes(row.ad_id)) continue;
    (rowsByAccount[row._accountName] ||= []).push(row);
  }
  return Object.entries(rowsByAccount).map(([account, rows]) => {
    const merged = metaMarketing.buildCreativeEntry(metaMarketing.groupRowsByCreative(rows)[0]);
    return { account, purchases: merged.purchases, cpa: merged.cpa };
  });
}

async function postCreativeAlert(c, direction = 'up') {
  const emoji = GRADE_EMOJI[c.grade] || '⚪';
  const driveUrl = await googleDrive.findFileLinkByName(c.name);
  const lines = [
    `Grade: ${emoji} *${c.grade}*`,
    `Воронка: ${c.funnel || '—'}`,
    `Аккаунты: ${(c.accounts || []).join(', ')}`,
    `Spend: $${Math.round(c.spend)} · Purchases: ${c.purchases} · CPA: ${c.cpa ? '$' + c.cpa.toFixed(2) : '—'}`
  ];
  if (c.accountBreakdown?.length > 1) {
    lines.push('Разбивка по аккаунтам:');
    for (const b of c.accountBreakdown) {
      lines.push(`   • ${b.account}: ${b.purchases} purchases${b.cpa ? ' · CPA $' + b.cpa.toFixed(2) : ''}`);
    }
  }
  const title = direction === 'down'
    ? `📉 Креатив упал по грейду: ${c.name}`
    : `🚀 Креатив поднялся по грейду: ${c.name}`;
  await postToSlack({
    attachments: [{
      color: GRADE_COLORS[c.grade] || '#999999',
      title,
      ...(driveUrl ? { title_link: driveUrl } : {}),
      text: lines.join('\n'),
      ...(c.previewUrl ? { image_url: c.previewUrl } : {})
    }]
  });
}

// Тот же порядок грейдов, что и в сортировке аналитики на фронте — уведомляем
// только когда креатив поднялся ВЫШЕ по грейду, чем в прошлый раз, когда мы
// его видели (или раньше вообще не был в Promising+). Если держится на том
// же грейде или просел ниже — молчим (падение из Promising+ в Bad/No purchases
// ловит отдельно isGradeDowngrade).
const GRADE_RANK = { 'Alpha': 5, 'Scale': 4, 'Test': 3, 'Promising': 2, 'Bad': 1, 'No purchases': 0 };

async function lastKnownGrade(key) {
  const row = await db.prepare('SELECT grade FROM notified_top_creatives WHERE creative_key = ?').get(key);
  return row?.grade || null;
}

async function isGradeUpgrade(key, grade) {
  const prevGrade = await lastKnownGrade(key);
  if (!prevGrade) return true;
  return (GRADE_RANK[grade] ?? -1) > (GRADE_RANK[prevGrade] ?? -1);
}

// Симметрично isGradeUpgrade: сообщаем о падении только если раньше уже
// писали про этот креатив как про Promising+ (иначе не о чем — он никогда и
// не был в топе), а сейчас он выпал из Promising+ совсем (в Bad/No purchases).
// Просадка внутри самого топа (напр. Alpha -> Test) не считается — молчим, как
// и раньше.
async function isGradeDowngrade(key, grade) {
  const prevGrade = await lastKnownGrade(key);
  if (!prevGrade) return false;
  const promisingRank = GRADE_RANK['Promising'];
  return (GRADE_RANK[prevGrade] ?? -1) >= promisingRank && (GRADE_RANK[grade] ?? -1) < promisingRank;
}

async function markNotified(key, grade) {
  await db.prepare(`
    INSERT INTO notified_top_creatives (creative_key, grade, notified_at) VALUES (?, ?, ?)
    ON CONFLICT(creative_key) DO UPDATE SET grade = excluded.grade, notified_at = excluded.notified_at
  `).run(key, grade, new Date().toISOString());
}

async function checkNewTopCreatives() {
  const accNames = Object.keys(metaMarketing.accounts());
  if (!accNames.length) { console.warn('[slack-alert] META_MARKETING_ACCOUNTS не задан — пропускаю проверку'); return; }

  // Скользящее окно 7 дней, конец — вчера: каждый день since/until сдвигаются
  // на сутки вперёд (grade считается по суммарным purchases/CPA за неделю,
  // а не за один день — иначе разовый провал/всплеск за сутки слишком сильно
  // шатал грейд).
  const since = warsawDateString(7);
  const until = warsawDateString(1);
  const allRows = await metaMarketing.fetchAllAccountsInsights(since, until);
  const creatives = metaMarketing.groupRowsByCreative(allRows).map(metaMarketing.buildCreativeEntry);

  const topCreatives = creatives.filter((c) => metaMarketing.SUCCESS_GRADES.includes(c.grade));
  const upgradeFlags = await Promise.all(topCreatives.map((c) => isGradeUpgrade(c.name, c.grade)));
  const upgraded = topCreatives.filter((_, i) => upgradeFlags[i]);
  for (const c of upgraded) c.accountBreakdown = buildAccountBreakdown(c, allRows);
  await metaMarketing.attachPreviews(upgraded);

  // Падения — среди тех, кто СЕЙЧАС не Promising+, ищем тех, кто раньше был
  // отмечен как Promising+ (см. isGradeDowngrade) — то есть реально выпал из
  // топа, а не просто никогда там не был.
  const belowCreatives = creatives.filter((c) => !metaMarketing.SUCCESS_GRADES.includes(c.grade));
  const downgradeFlags = await Promise.all(belowCreatives.map((c) => isGradeDowngrade(c.name, c.grade)));
  const downgraded = belowCreatives.filter((_, i) => downgradeFlags[i]);
  for (const c of downgraded) c.accountBreakdown = buildAccountBreakdown(c, allRows);
  await metaMarketing.attachPreviews(downgraded);

  console.log(`[slack-alert] ${since}..${until}: ${topCreatives.length} креативов Promising+, ${upgraded.length} поднялись по грейду, ${downgraded.length} упали по грейду`);

  if (!upgraded.length && !downgraded.length) {
    await postToSlack({ text: `За ${since}–${until} нет изменений по грейду.` });
    return;
  }

  for (const c of upgraded) {
    await postCreativeAlert(c, 'up');
    await markNotified(c.name, c.grade);
  }
  for (const c of downgraded) {
    await postCreativeAlert(c, 'down');
    await markNotified(c.name, c.grade);
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
  for (const c of topCreatives) c.accountBreakdown = buildAccountBreakdown(c, allRows);
  await metaMarketing.attachPreviews(topCreatives);

  console.log(`[slack-alert] resend ${day}: ${topCreatives.length} креативов Promising+`);
  for (const c of topCreatives) {
    await postCreativeAlert(c);
  }
}

module.exports = { checkNewTopCreatives, resendTopCreatives, warsawDateString };
