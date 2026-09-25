// Отправка топ-креативов (Promising+) в Slack — только по ручной кнопке
// "Отправить в Slack" на вкладке TOPS (см. sendTopCreativesForRange), период
// выбирает сама Тина. Автоматической ежедневной проверки больше нет —
// раньше она сама решала, когда что-то изменилось по грейду, и слала
// уведомление первым визитом на сайт после 10:00 по Варшаве; теперь Тина
// сама решает, когда и за какой период слать.
const metaMarketing = require('./metaMarketing');
const googleDrive = require('./googleDrive');

// Те же цвета, что и у бейджа грейда в самом приложении (GRADE_BADGE_COLORS
// в app.js) — используются как цветная полоса слева у сообщения в Slack.
const GRADE_COLORS = {
  'Alpha': '#1b5e20',
  'Scale': '#0d47a1',
  'Test': '#e65100',
  'Promising': '#4a148c',
  'Bedolaga': '#7f0000'
};

// Slack не умеет красить отдельные слова в тексте сообщения — ближайший
// рабочий аналог цвета грейда прямо у слова это цветной эмодзи-кружок.
const GRADE_EMOJI = {
  'Alpha': '🟢',
  'Scale': '🔵',
  'Test': '🟠',
  'Promising': '🟣',
  'Bedolaga': '🔴'
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

// Заголовок раньше был "поднялся/упал по грейду" — имело смысл, пока это
// слал автоматический детектор изменений. Теперь это разовый ручной снимок
// без сравнения с прошлым разом, поэтому заголовок не должен утверждать, что
// что-то изменилось: иначе один и тот же креатив, остающийся в Promising+
// неделями, при каждой ручной отправке выглядит так, будто он только что
// "поднялся" — хотя на самом деле просто снова попал в выбранный период.
async function postCreativeAlert(c) {
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
  await postToSlack({
    attachments: [{
      color: GRADE_COLORS[c.grade] || '#999999',
      title: `⭐ Топ-креатив: ${c.name}`,
      ...(driveUrl ? { title_link: driveUrl } : {}),
      text: lines.join('\n'),
      ...(c.previewUrl ? { image_url: c.previewUrl } : {})
    }]
  });
}

// Ручная рассылка по кнопке "Отправить в Slack" в TOPS — все текущие
// топ-креативы (Promising+) за произвольный период, который выбирает сама
// Тина (например, "закрытая неделя").
async function sendTopCreativesForRange(since, until) {
  const allRows = await metaMarketing.fetchAllAccountsInsights(since, until);
  const creatives = metaMarketing.groupRowsByCreative(allRows).map(metaMarketing.buildCreativeEntry);
  const topCreatives = creatives.filter((c) => metaMarketing.SUCCESS_GRADES.includes(c.grade));
  for (const c of topCreatives) c.accountBreakdown = buildAccountBreakdown(c, allRows);
  await metaMarketing.attachPreviews(topCreatives);

  console.log(`[slack-alert] ручная отправка ${since}..${until}: ${topCreatives.length} креативов Promising+`);
  for (const c of topCreatives) {
    await postCreativeAlert(c);
  }
  return topCreatives.length;
}

module.exports = { sendTopCreativesForRange };
