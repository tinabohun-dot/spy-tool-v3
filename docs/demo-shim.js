// Подключается ПЕРЕД app.js только в статической демо-сборке (GitHub Pages).
// За этим сайтом нет бэкенда: GET-запросы к /api/... подменяются на локальные
// JSON-файлы того же снепшота, а любые изменяющие запросы (добавить бренд,
// обновить сейчас и т.п.) превращаются в безопасный no-op с уведомлением —
// настоящего сервера здесь нет, действия просто не к чему применять.
(function () {
  const NOTICE = 'Демо-режим: это статичный снимок данных без бэкенда. Добавление/обновление здесь недоступно — установи проект локально, чтобы собирать live-данные.';
  const realFetch = window.fetch.bind(window);

  window.fetch = function (input, init = {}) {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return realFetch(input, init);

    const method = (init.method || 'GET').toUpperCase();
    if (method !== 'GET') {
      window.alert(NOTICE);
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }

    if (url.startsWith('/api/search') || url.startsWith('/api/saved')) {
      return Promise.resolve(new Response(JSON.stringify({ ads: [], nextCursor: null, hasNext: false }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }));
    }

    return realFetch('data' + url + '.json').then((r) => {
      if (r.ok) return r;
      return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  };
})();
