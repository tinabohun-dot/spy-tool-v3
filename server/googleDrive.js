// Поиск видео-файла в Google Drive по названию креатива — через OAuth от
// личного Google-аккаунта (не сервисный аккаунт: организация блокирует
// создание ключей сервисных аккаунтов, а разовая пользовательская
// авторизация под эту политику не попадает). Один раз проходим /oauth2/start,
// дальше сервер сам обновляет access_token по сохранённому refresh_token.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

function config() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || 'http://localhost:3000/oauth2/callback';
  if (!clientId || !clientSecret) {
    const err = new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET не заданы в server/.env');
    err.status = 500;
    throw err;
  }
  return { clientId, clientSecret, redirectUri };
}

function getAuthUrl() {
  const { clientId, redirectUri } = config();
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

async function exchangeCodeForTokens(code) {
  const { clientId, clientSecret, redirectUri } = config();
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code'
    })
  });
  const json = await resp.json();
  if (json.error) throw new Error('Google OAuth: ' + (json.error_description || json.error));
  return json;
}

let cachedAccessToken = null;

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt - 30000) {
    return cachedAccessToken.token;
  }
  const { clientId, clientSecret } = config();
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!refreshToken) {
    const err = new Error('GOOGLE_REFRESH_TOKEN не задан — пройди авторизацию через /oauth2/start');
    err.status = 500;
    throw err;
  }
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: 'refresh_token'
    })
  });
  const json = await resp.json();
  if (json.error) throw new Error('Google OAuth refresh: ' + (json.error_description || json.error));
  cachedAccessToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedAccessToken.token;
}

// Ведущий номер один и тот же у разных вариаций (21_V_N1, 21_V_N2, 21_V_N3 —
// это РАЗНЫЕ креативы), поэтому по одному числу сопоставлять нельзя: берём
// номер + тип (V/S) + вариацию Nx, если она есть в имени, иначе номер + тип.
function getMatchPrefix(name) {
  const withVariant = (name || '').match(/^(\d+_[A-Za-z]_N\d+)/);
  if (withVariant) return withVariant[1];
  const withType = (name || '').match(/^(\d+_[A-Za-z])/);
  if (withType) return withType[1];
  const numOnly = (name || '').match(/^(\d+)/);
  return numOnly ? numOnly[1] : null;
}

// Ищем файл по этому префиксу, а не по полному имени целиком: у файлов на
// Диске в имени порой встречаются похожие, но другие символы (например
// кириллическая "х" вместо латинской в "9x16"), из-за чего точное совпадение
// по полной строке ничего не находит.
async function findFileLinkByName(creativeName) {
  if (!process.env.GOOGLE_REFRESH_TOKEN) return null;
  const prefix = getMatchPrefix(creativeName);
  if (!prefix) return null;
  try {
    const token = await getAccessToken();
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', `name contains '${prefix}' and trashed = false`);
    url.searchParams.set('fields', 'files(id,name,webViewLink,mimeType)');
    url.searchParams.set('pageSize', '20');
    const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const json = await resp.json();
    if (json.error) { console.error('[drive] Ошибка поиска:', json.error.message); return null; }
    const files = (json.files || []).filter((f) => f.name.startsWith(prefix));
    const file = files.find((f) => f.mimeType?.startsWith('video/')) || files[0];
    return file?.webViewLink || null;
  } catch (e) {
    console.error('[drive] Не удалось найти файл по названию:', e.message);
    return null;
  }
}

module.exports = { getAuthUrl, exchangeCodeForTokens, findFileLinkByName };
