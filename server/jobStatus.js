// Лёгкий трекер статуса сбора снепшотов в памяти процесса — чтобы в интерфейсе
// было видно, идёт ли сейчас сбор по Ad Page, сколько объявлений уже
// обработано и чем закончился последний запуск (успех/ошибка). Не переживает
// перезапуск сервера — это нормально, статус нужен только "прямо сейчас".
const jobs = new Map(); // key: ad_page_id

function startJob(adPage) {
  jobs.set(adPage.id, {
    pageId: adPage.id,
    pageName: adPage.page_name || adPage.page_id,
    brandId: adPage.brand_id,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: null,
    processed: 0,
    error: null
  });
}

function setTotal(pageId, total) {
  const j = jobs.get(pageId);
  if (j) j.total = total;
}

function incrementProcessed(pageId) {
  const j = jobs.get(pageId);
  if (j) j.processed += 1;
}

function finishJob(pageId, count) {
  const j = jobs.get(pageId);
  if (!j) return;
  j.status = 'success';
  j.finishedAt = new Date().toISOString();
  j.total = count;
  j.processed = count;
}

function failJob(pageId, err) {
  const j = jobs.get(pageId);
  if (!j) return;
  j.status = 'error';
  j.finishedAt = new Date().toISOString();
  j.error = err.message;
}

function listJobs() {
  return [...jobs.values()].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
}

module.exports = { startJob, setTotal, incrementProcessed, finishJob, failJob, listJobs };
