'use strict';
/* Аниметрек — трекер аниме поверх Shikimori.
   Прогресс (какие серии отмечены) живёт в аккаунте Shikimori, поэтому он
   общий на телефоне и ноутбуке. Сами серии смотрим на своих сайтах —
   приложение только помнит, где остановился, и открывает нужную страницу. */

const API = 'https://shikimori.io';
const REDIRECT = location.origin + location.pathname.replace(/index\.html$/, '');

const STATUS = {
  watching: 'Смотрю', rewatching: 'Пересматриваю', on_hold: 'Отложено',
  planned: 'Запланировано', completed: 'Просмотрено', dropped: 'Брошено',
};
const STATUS_ORDER = ['watching', 'rewatching', 'on_hold', 'planned', 'completed', 'dropped'];
const KIND = {
  tv: 'TV', movie: 'Фильм', ova: 'OVA', ona: 'ONA', special: 'Спешл',
  tv_special: 'TV-спешл', music: 'Клип', pv: 'Трейлер', cm: 'Реклама',
};
const AIR = { anons: 'анонс', ongoing: 'выходит', released: 'вышло' };
const SITES = {
  animelib: { title: 'AnimeLib', search: q => 'https://anilib.me/ru/catalog?q=' + encodeURIComponent(q) },
  yummy: { title: 'YummyAnime', search: q => 'https://yummyani.me/search?word=' + encodeURIComponent(q) },
};
// «Часть 2», «Part 2», «2-й кур» — продолжение того же сезона, а не новый.
const PART_RE = /(?:час(?:ть|ти)|part|cour)\s*(\d+)/i;

/* ---------- хранилище в браузере ---------- */
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem('at.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('at.' + k, JSON.stringify(v)); } catch { /* полно или запрещено */ } },
  del(k) { try { localStorage.removeItem('at.' + k); } catch { } },
};

/* ---------- запросы к Shikimori ---------- */
// Лимит Shikimori — 5 запросов в секунду и 90 в минуту. Идём не чаще 2,5 в секунду.
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastCall = 0, queue = Promise.resolve();
function slot() {
  const p = queue.then(async () => {
    const wait = lastCall + 400 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
  });
  queue = p.catch(() => { });
  return p;
}

async function http(path, opts = {}, attempt = 0) {
  const { method = 'GET', body, auth = false, form = false } = opts;
  await slot();
  const headers = { Accept: 'application/json' };
  if (auth) headers.Authorization = 'Bearer ' + await accessToken();
  let payload;
  if (body !== undefined) {
    if (form) payload = new URLSearchParams(body);
    else { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  }
  let res;
  try { res = await fetch(API + path, { method, headers, body: payload }); }
  catch { throw new Error('Нет связи с Shikimori. Проверьте интернет и нажмите «Обновить».'); }
  if (res.status === 429 && attempt < 3) { await sleep(1500 * (attempt + 1)); return http(path, opts, attempt + 1); }
  if (res.status === 401 && auth && attempt === 0) { await refreshToken(true); return http(path, opts, 1); }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Shikimori ответил ошибкой ${res.status}${t ? ': ' + t.slice(0, 160) : ''}`);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

async function gql(query) {
  const r = await http('/api/graphql', { method: 'POST', body: { query } });
  if (r.errors) throw new Error('Shikimori: ' + r.errors[0].message);
  return r.data;
}

/* ---------- вход через Shikimori (OAuth) ---------- */
const cfg = () => LS.get('cfg', {});
const tokens = () => LS.get('tok', null);
const me = () => LS.get('me', null);

function startLogin() {
  const c = cfg();
  const state = Math.random().toString(36).slice(2);
  LS.set('state', state);
  location.href = `${API}/oauth/authorize?client_id=${encodeURIComponent(c.clientId)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=user_rates&state=${state}`;
}

async function exchange(params) {
  const c = cfg();
  const r = await http('/oauth/token', {
    method: 'POST', form: true,
    body: { client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: REDIRECT, ...params },
  });
  LS.set('tok', { access: r.access_token, refresh: r.refresh_token, exp: Date.now() + (r.expires_in - 300) * 1000 });
}

async function refreshToken(force) {
  const t = tokens();
  if (!t) throw new Error('Нужно войти через Shikimori.');
  if (!force && Date.now() < t.exp) return;
  try { await exchange({ grant_type: 'refresh_token', refresh_token: t.refresh }); }
  catch (e) { LS.del('tok'); throw new Error('Вход устарел — войдите через Shikimori заново.'); }
}
async function accessToken() { await refreshToken(false); return tokens().access; }

async function finishLogin() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  if (!code && !q.get('error')) return;
  history.replaceState(null, '', REDIRECT + location.hash);
  if (q.get('error')) throw new Error('Shikimori не дал доступ: ' + (q.get('error_description') || q.get('error')));
  if (q.get('state') && q.get('state') !== LS.get('state')) throw new Error('Вход прерван. Нажмите «Войти» ещё раз.');
  await exchange({ grant_type: 'authorization_code', code });
  const u = await http('/api/users/whoami', { auth: true });
  LS.set('me', { id: u.id, nickname: u.nickname });
}

/* ---------- данные ---------- */
const store = {
  rates: LS.get('rates', []),      // мои оценки: {id, target, status, episodes, text, updated}
  anime: {},                        // id -> сведения о тайтле
  fr: LS.get('fr', {}),             // франшиза -> разбор на сезоны
  loading: false,
};
const animeCache = LS.get('anime', {});
Object.assign(store.anime, animeCache);

const AFIELDS = 'id russian name kind status episodes episodesAired airedOn { date } nextEpisodeAt franchise poster { mainUrl }';
const fresh = a => a && Date.now() - (a._ts || 0) < (a.status === 'released' ? 7 * 864e5 : 3 * 36e5);

function normRate(x) {
  return { id: x.id, target: String(x.target_id), status: x.status, episodes: x.episodes || 0, text: x.text || '', updated: x.updated_at };
}
const rateOf = id => store.rates.find(r => r.target === String(id));
const nameOf = a => (a && (a.russian || a.name)) || 'Без названия';
const fkey = a => (a && a.franchise) || ('id' + a.id);
const total = a => (a && (a.episodes || 0)) || 0;
const aired = a => {
  if (!a) return 0;
  if (a.status === 'released') return a.episodes || a.episodesAired || 0;
  return a.episodesAired || 0;
};

async function loadAnime(ids, force = false) {
  const need = [...new Set(ids.map(String))].filter(id => force || !fresh(store.anime[id]));
  for (let i = 0; i < need.length; i += 50) {
    const part = need.slice(i, i + 50);
    const d = await gql(`{ animes(ids: "${part.join(',')}", limit: 50) { ${AFIELDS} } }`);
    for (const a of d.animes) { a._ts = Date.now(); store.anime[a.id] = a; animeCache[a.id] = a; }
  }
  LS.set('anime', animeCache);
}

async function loadRates() {
  const u = me();
  const r = await http(`/api/v2/user_rates?user_id=${u.id}&target_type=Anime`, { auth: true });
  store.rates = r.map(normRate);
  LS.set('rates', store.rates);
}

// Франшиза по цепочке «сиквел/приквел» от первого TV-сезона: так в нумерацию
// не попадают спин-оффы и чиби-версии, которые Shikimori тоже держит во франшизе.
async function loadFranchise(anyId, force = false) {
  const a = store.anime[anyId] || (await loadAnime([anyId]), store.anime[anyId]);
  const key = fkey(a);
  const cached = store.fr[key];
  if (!force && cached && Date.now() - cached._ts < (cached.ongoing ? 6 * 36e5 : 7 * 864e5)) return cached;

  const d = await gql(`{ animes(ids: "${anyId}", limit: 1) { id chronology { ${AFIELDS} } } }`);
  let nodes = (d.animes[0] && d.animes[0].chronology) || [];
  if (!nodes.find(n => n.id === String(anyId))) nodes.push(a);
  for (const n of nodes) { n._ts = Date.now(); store.anime[n.id] = n; animeCache[n.id] = n; }
  LS.set('anime', animeCache);

  const rel = {};
  const ids = nodes.map(n => n.id);
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const r = await gql(`{ animes(ids: "${part.join(',')}", limit: 50) { id related { relationKind anime { id } } } }`);
    for (const x of r.animes) rel[x.id] = (x.related || []).filter(y => y.anime).map(y => ({ k: y.relationKind, id: y.anime.id }));
  }

  const date = n => (n.airedOn && n.airedOn.date) || '9999';
  const byDate = [...nodes].sort((x, y) => date(x).localeCompare(date(y)));
  const has = new Set(ids);
  const start = byDate.find(n => n.kind === 'tv') || byDate.find(n => n.kind === 'ona') || byDate[0];
  const chain = new Set([start.id]);
  const q = [start.id];
  while (q.length) {
    const id = q.shift();
    for (const r of rel[id] || []) {
      if ((r.k === 'sequel' || r.k === 'prequel') && has.has(r.id) && !chain.has(r.id)) { chain.add(r.id); q.push(r.id); }
    }
  }
  const mainKinds = new Set(['tv', 'ona', 'tv_special']);
  const seasons = byDate.filter(n => chain.has(n.id) && mainKinds.has(n.kind)).map(n => n.id);
  const inSeasons = new Set(seasons);
  const fr = {
    key, _ts: Date.now(),
    ongoing: nodes.some(n => n.status !== 'released'),
    seasons,
    films: byDate.filter(n => n.kind === 'movie').map(n => n.id),
    extras: byDate.filter(n => ['ova', 'special', 'tv_special', 'ona'].includes(n.kind) && !inSeasons.has(n.id)).map(n => n.id),
    spinoffs: byDate.filter(n => n.kind === 'tv' && !inSeasons.has(n.id)).map(n => n.id),
  };
  store.fr[key] = fr;
  LS.set('fr', store.fr);
  return fr;
}

// «1 сезон», «2 сезон (Название)», «3 сезон, часть 2 (Название)».
// Оригинальное название в скобках — если оно отличается от названия первого сезона.
function seasonLabels(fr) {
  const out = {};
  if (!fr) return out;
  const base = nameOf(store.anime[fr.seasons[0]]);
  let n = 0;
  fr.seasons.forEach((id, i) => {
    const nm = nameOf(store.anime[id]);
    const part = i > 0 ? nm.match(PART_RE) : null;
    if (!part) n++;
    out[id] = { label: `${n} сезон` + (part ? `, часть ${part[1]}` : ''), orig: i === 0 && nm === base ? '' : nm };
  });
  return out;
}
function labelOf(id) {
  const a = store.anime[id];
  const fr = a && store.fr[fkey(a)];
  const l = fr && seasonLabels(fr)[id];
  if (l) return l;
  if (a && a.kind && a.kind !== 'tv') return { label: KIND[a.kind] || a.kind, orig: nameOf(a) };
  return { label: '', orig: nameOf(a) };
}

/* ---------- мои франшизы ---------- */
function myFranchises() {
  const m = new Map();
  for (const r of store.rates) {
    const a = store.anime[r.target];
    if (!a) continue;
    const k = fkey(a);
    if (!m.has(k)) m.set(k, { key: k, rates: [] });
    m.get(k).rates.push(r);
  }
  return [...m.values()].map(g => {
    g.rates.sort((x, y) => (y.updated || '').localeCompare(x.updated || ''));
    const fr = store.fr[g.key];
    const firstId = fr ? fr.seasons[0] : null;
    const oldest = [...g.rates].map(r => store.anime[r.target])
      .sort((x, y) => ((x.airedOn && x.airedOn.date) || '9').localeCompare((y.airedOn && y.airedOn.date) || '9'))[0];
    g.title = nameOf(store.anime[firstId] || oldest);
    g.poster = (store.anime[firstId] || oldest || {}).poster;
    g.status = STATUS_ORDER.find(s => g.rates.some(r => r.status === s)) || 'planned';
    g.current = g.rates.find(r => r.status === 'watching' || r.status === 'rewatching')
      || g.rates.find(r => r.status === 'on_hold') || g.rates[0];
    return g;
  });
}
const newCount = r => {
  const a = store.anime[r.target];
  return ['watching', 'rewatching', 'on_hold'].includes(r.status) ? Math.max(0, aired(a) - r.episodes) : 0;
};

// Новый сезон моей франшизы, которого нет в моём списке (анонс или уже выходит).
function newSeasons() {
  const out = [];
  for (const g of myFranchises()) {
    const fr = store.fr[g.key];
    if (!fr || g.status === 'dropped') continue;
    for (const id of fr.seasons) {
      const a = store.anime[id];
      if (!rateOf(id) && a && a.status !== 'released') out.push({ g, id, a });
    }
  }
  return out;
}

/* ---------- ссылки на сайты ---------- */
// Ссылка на страницу сезона хранится в комментарии к оценке на Shikimori,
// поэтому она одна и та же на телефоне и ноутбуке.
function linksOf(id) {
  const r = rateOf(id), out = {};
  if (!r) return out;
  for (const line of r.text.split('\n')) {
    const m = line.trim().match(/^(animelib|yummy)=(https?:\/\/\S+)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
function withLink(text, site, url) {
  const lines = (text || '').split('\n').filter(l => l.trim() && !l.trim().startsWith(site + '='));
  if (url) lines.push(`${site}=${url}`);
  return lines.join('\n');
}
function siteUrl(id, site) {
  return linksOf(id)[site] || SITES[site].search(nameOf(store.anime[id]));
}

/* ---------- изменения оценок ---------- */
async function setRate(id, patch) {
  let r = rateOf(id);
  if (!r) {
    const x = await http('/api/v2/user_rates', {
      method: 'POST', auth: true,
      body: { user_rate: { user_id: me().id, target_id: Number(id), target_type: 'Anime', status: 'planned', ...patch } },
    });
    r = normRate(x); store.rates.push(r);
  } else {
    const x = await http(`/api/v2/user_rates/${r.id}`, { method: 'PATCH', auth: true, body: { user_rate: patch } });
    Object.assign(r, normRate(x));
  }
  LS.set('rates', store.rates);
  return r;
}
async function removeRate(id) {
  const r = rateOf(id);
  if (!r) return;
  await http(`/api/v2/user_rates/${r.id}`, { method: 'DELETE', auth: true });
  store.rates = store.rates.filter(x => x !== r);
  LS.set('rates', store.rates);
}

// Отметить серию: +1, а на последней — «просмотрено» и подсказка про следующий сезон.
async function markEpisode(id, episodes) {
  const a = store.anime[id];
  const r = rateOf(id);
  const n = episodes != null ? episodes : (r ? r.episodes : 0) + 1;
  const done = total(a) > 0 && n >= total(a);
  const patch = { episodes: Math.max(0, total(a) ? Math.min(n, total(a)) : n) };
  if (done) patch.status = 'completed';
  else if (!r || ['planned', 'completed', 'dropped', 'on_hold'].includes(r.status)) patch.status = r && r.status === 'completed' ? 'rewatching' : 'watching';
  await setRate(id, patch);
  if (done) {
    const fr = store.fr[fkey(a)];
    const i = fr ? fr.seasons.indexOf(String(id)) : -1;
    const next = i >= 0 ? fr.seasons[i + 1] : null;
    if (next && !rateOf(next)) {
      const l = labelOf(next);
      toast(`Сезон просмотрен. Дальше — ${l.label}`, 'Начать', async () => {
        await setRate(next, { status: 'watching', episodes: 0 });
        render();
      });
      return;
    }
    toast(`${labelOf(id).label || nameOf(a)}: просмотрено`);
  } else {
    toast(`Отмечена серия ${patch.episodes}`);
  }
}

/* ---------- отрисовка ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const img = p => p && p.mainUrl ? `<img class="poster" src="${esc(p.mainUrl)}" alt="" loading="lazy">` : '<div class="poster"></div>';
const fmtDate = iso => {
  const d = new Date(iso), now = new Date();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((day - today) / 864e5);
  const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (diff === 0) return 'сегодня ' + t;
  if (diff === 1) return 'завтра ' + t;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ' ' + t;
};
const year = a => (a && a.airedOn && a.airedOn.date ? a.airedOn.date.slice(0, 4) : '');
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

function seasonTitle(id) {
  const l = labelOf(id);
  if (!l.label) return `<span>${esc(l.orig)}</span>`;
  return `<span>${esc(l.label)}</span>${l.orig ? ` <span class="orig">(${esc(l.orig)})</span>` : ''}`;
}

function progressBar(r, a) {
  const t = total(a) || Math.max(aired(a), r.episodes, 1);
  const seen = Math.min(100, (r.episodes / t) * 100);
  const out = Math.min(100, (aired(a) / t) * 100);
  return `<div class="bar" aria-hidden="true"><i class="aired" style="width:${out}%"></i><i class="seen" style="width:${seen}%"></i></div>`;
}

function watchButtons(id) {
  const links = linksOf(id);
  return Object.keys(SITES).map(s =>
    `<a class="btn" href="${esc(siteUrl(id, s))}" target="_blank" rel="noopener">${SITES[s].title}${links[s] ? '' : ' · поиск'}</a>`).join('');
}

function card(g) {
  const r = g.current, a = store.anime[r.target];
  const fresh = newCount(r);
  const t = total(a);
  const next = r.episodes + 1;
  // Отметить можно только вышедшую серию; у вышедшего тайтла без числа серий — без ограничений.
  const available = a.status === 'released' ? (t || Infinity) : aired(a);
  const canNext = r.episodes < available;
  let when = '';
  if (a.status !== 'released' && a.nextEpisodeAt && !fresh) when = `<span class="badge plain num">серия ${aired(a) + 1}: ${esc(fmtDate(a.nextEpisodeAt))}</span>`;
  return `<article class="card">
    <a href="#f/${a.id}">${img(g.poster || a.poster)}</a>
    <div class="card-body">
      <a class="card-title" href="#f/${a.id}">${esc(g.title)}</a>
      <div class="where">${seasonTitle(a.id)}</div>
      <div class="muted small num">Просмотрено ${r.episodes} из ${t || '?'}${a.status !== 'released' ? ` · вышло ${aired(a)}` : ''}</div>
      ${progressBar(r, a)}
      <div class="row">${fresh ? `<span class="badge fresh num">+${fresh} ${plural(fresh, 'новая серия', 'новые серии', 'новых серий')}</span>` : ''}${when}</div>
      <div class="row">
        ${canNext ? `<button class="btn primary" data-act="next" data-id="${a.id}">Посмотрел серию ${next}</button>` : ''}
        ${watchButtons(a.id)}
      </div>
    </div>
  </article>`;
}

function viewSetup() {
  const c = cfg();
  return `<h1>Подключение к Shikimori</h1>
  <div class="panel">
    <p>Отмеченные серии хранятся в вашем аккаунте Shikimori — так они одинаковые на телефоне и ноутбуке. Настройка нужна один раз.</p>
    <ol>
      <li>Зарегистрируйтесь на <a href="${API}" target="_blank" rel="noopener">shikimori.io</a>.</li>
      <li>Откройте <a href="${API}/oauth/applications" target="_blank" rel="noopener">Приложения OAuth</a> → «Создать приложение».<br>
        Название — любое, например «Аниметрек». В поле <b>Redirect URI</b> вставьте:
        <code class="copy" id="redirect">${esc(REDIRECT)}</code>
        Права (scopes): отметьте <b>user_rates</b>.</li>
      <li>Скопируйте сюда Client ID и Client Secret созданного приложения.</li>
    </ol>
    <label class="field"><span>Client ID</span><input id="cid" autocomplete="off" spellcheck="false" value="${esc(c.clientId || '')}"></label>
    <label class="field"><span>Client Secret</span><input id="csec" autocomplete="off" spellcheck="false" value="${esc(c.clientSecret || '')}"></label>
    <div class="row"><button class="btn primary" data-act="save-cfg">Войти через Shikimori</button></div>
  </div>
  <div class="panel">
    <p><b>Уже настраивали на другом устройстве?</b> Вставьте код из «Настройки → Код для другого устройства».</p>
    <label class="field"><span>Код настройки</span><input id="code" autocomplete="off" spellcheck="false"></label>
    <div class="row"><button class="btn" data-act="use-code">Применить код</button></div>
  </div>`;
}

function viewWatch() {
  const list = myFranchises().filter(g => ['watching', 'rewatching'].includes(g.current.status))
    .sort((x, y) => newCount(y.current) - newCount(x.current) || (y.current.updated || '').localeCompare(x.current.updated || ''));
  const held = myFranchises().filter(g => g.status === 'on_hold');
  if (!list.length && !held.length) {
    return `<div class="empty"><div class="big">Пока ничего не смотрите</div>
      <p class="muted">Найдите аниме во вкладке «Поиск» и нажмите «Смотрю» у нужного сезона.</p>
      <a class="btn primary" href="#search">Найти аниме</a></div>`;
  }
  return `<h1>Смотрю</h1>${list.map(card).join('')}
    ${held.length ? `<h2>Отложено</h2>${held.map(card).join('')}` : ''}`;
}

function viewNew() {
  const items = [];
  for (const g of myFranchises()) {
    const r = g.current, n = newCount(r);
    if (n) items.push({ sort: 0, html: feedItem(r.target, g, `+${n} ${plural(n, 'серия', 'серии', 'серий')}`, `вышло ${aired(store.anime[r.target])}, вы на ${r.episodes}`) });
  }
  for (const x of newSeasons()) {
    items.push({ sort: 1, html: feedItem(x.id, x.g, x.a.status === 'anons' ? 'анонс' : 'выходит', `${labelOf(x.id).label}${x.a.nextEpisodeAt ? ' · ' + fmtDate(x.a.nextEpisodeAt) : x.a.airedOn && x.a.airedOn.date ? ' · с ' + x.a.airedOn.date : ''}`) });
  }
  const soon = store.rates.map(r => store.anime[r.target])
    .filter(a => a && a.nextEpisodeAt && a.status !== 'released' && !['dropped', 'completed'].includes(rateOf(a.id).status))
    .sort((x, y) => x.nextEpisodeAt.localeCompare(y.nextEpisodeAt));
  const fresh = items.sort((x, y) => x.sort - y.sort).map(x => x.html).join('');
  const sched = soon.map(a => {
    const g = myFranchises().find(f => f.key === fkey(a));
    return feedItem(a.id, g, fmtDate(a.nextEpisodeAt), `серия ${aired(a) + 1}${total(a) ? ' из ' + total(a) : ''}`);
  }).join('');
  if (!fresh && !sched) {
    return `<div class="empty"><div class="big">Новых серий нет</div>
      <p class="muted">Здесь появятся вышедшие серии и новые сезоны ваших тайтлов, а ниже — расписание онгоингов.</p></div>`;
  }
  return `<h1>Новинки</h1>
    ${fresh ? `<h2>Можно смотреть</h2><div class="feed">${fresh}</div>` : ''}
    ${sched ? `<h2>Скоро</h2><div class="feed">${sched}</div>` : ''}
    ${store.loading ? '<p class="muted small">Проверяю новые сезоны…</p>' : ''}`;
}
function feedItem(id, g, when, sub) {
  const a = store.anime[id];
  return `<a class="feed-item" href="#f/${a.id}">${img(a.poster)}
    <div class="txt"><div class="card-title">${esc(g ? g.title : nameOf(a))}</div>
      <div class="small">${seasonTitle(a.id)}</div><div class="muted small num">${esc(sub)}</div></div>
    <div class="when ${/^\+/.test(when) ? 'badge fresh' : ''}">${esc(when)}</div></a>`;
}

function viewMy() {
  const all = myFranchises();
  if (!all.length) return viewWatch();
  return `<h1>Мои</h1>` + STATUS_ORDER.map(s => {
    const gs = all.filter(g => g.status === s).sort((x, y) => x.title.localeCompare(y.title, 'ru'));
    if (!gs.length) return '';
    return `<h2>${STATUS[s]} · ${gs.length}</h2><div class="feed">${gs.map(g => {
      const r = g.current, a = store.anime[r.target];
      return `<a class="feed-item" href="#f/${a.id}">${img(g.poster)}
        <div class="txt"><div class="card-title">${esc(g.title)}</div>
        <div class="small">${seasonTitle(a.id)}</div></div>
        <div class="when num">${r.episodes}/${total(a) || '?'}</div></a>`;
    }).join('')}</div>`;
  }).join('');
}

let lastSearch = { q: '', items: [] };
function viewSearch() {
  return `<h1>Поиск</h1>
    <div class="search-box"><input id="q" type="search" placeholder="Название на русском, английском или японском" value="${esc(lastSearch.q)}" autocomplete="off"></div>
    <div class="feed" id="results">${searchResults()}</div>`;
}
function searchResults() {
  if (!lastSearch.q) return '<p class="muted">Например: «магическая битва», «frieren», «атака титанов».</p>';
  if (!lastSearch.items.length) return '<p class="muted">Ничего не нашлось.</p>';
  return lastSearch.items.map(a => {
    const r = rateOf(a.id);
    return `<a class="feed-item" href="#f/${a.id}">${img(a.poster)}
      <div class="txt"><div class="card-title">${esc(nameOf(a))}</div>
      <div class="muted small">${esc(KIND[a.kind] || a.kind || '')} · ${year(a)} · ${esc(AIR[a.status] || '')}${total(a) ? ' · ' + total(a) + ' эп.' : ''}</div></div>
      <div class="when">${r ? `<span class="badge">${STATUS[r.status]}</span>` : ''}</div></a>`;
  }).join('');
}

function seasonBlock(id, current) {
  const a = store.anime[id], r = rateOf(id), t = total(a);
  const facts = [KIND[a.kind] || a.kind, year(a), t ? `${t} эп.` : '', a.status !== 'released' ? `${AIR[a.status]}${a.status === 'ongoing' ? ' · вышло ' + aired(a) : ''}` : '']
    .filter(Boolean).join(' · ');
  const nextAt = a.status !== 'released' && a.nextEpisodeAt ? ` · след. серия ${fmtDate(a.nextEpisodeAt)}` : '';
  const links = linksOf(id);
  return `<section class="season ${current ? 'current' : ''}" id="s-${id}">
    <div class="season-title">${seasonTitle(id)}</div>
    <div class="muted small num">${esc(facts)}${esc(nextAt)}</div>
    ${r ? `${progressBar(r, a)}
      <div class="row">
        <div class="stepper">
          <button type="button" data-act="dec" data-id="${id}" aria-label="Минус серия">−</button>
          <input type="number" inputmode="numeric" min="0" id="ep-${id}" value="${r.episodes}" data-act="ep" data-id="${id}" aria-label="Просмотрено серий">
          <button type="button" data-act="inc" data-id="${id}" aria-label="Плюс серия">+</button>
          <span class="of">из ${t || '?'}</span>
        </div>
        <select class="status" id="st-${id}" data-act="status" data-id="${id}" aria-label="Статус">
          ${STATUS_ORDER.map(s => `<option value="${s}" ${r.status === s ? 'selected' : ''}>${STATUS[s]}</option>`).join('')}
        </select>
      </div>` : `<div class="row">
        <button class="btn primary" data-act="add" data-status="watching" data-id="${id}">Смотрю</button>
        <button class="btn" data-act="add" data-status="planned" data-id="${id}">Запланировать</button>
        <button class="btn" data-act="add" data-status="completed" data-id="${id}">Уже видел</button>
      </div>`}
    <div class="row">${watchButtons(id)}
      <button class="btn ghost" data-act="links" data-id="${id}">${links.animelib || links.yummy ? 'Изменить ссылки' : 'Сохранить ссылку'}</button>
    </div>
    <div class="link-edit" id="le-${id}" hidden>
      <span class="small muted">Откройте сезон на сайте и вставьте адрес страницы. Он сохранится в вашем списке на Shikimori.</span>
      <input id="lk-animelib-${id}" placeholder="https://anilib.me/ru/anime/…" value="${esc(links.animelib || '')}">
      <input id="lk-yummy-${id}" placeholder="https://yummyani.me/catalog/item/…" value="${esc(links.yummy || '')}">
      <div class="row"><button class="btn primary" data-act="save-links" data-id="${id}">Сохранить</button></div>
    </div>
    ${r ? `<div class="row"><button class="btn ghost danger" data-act="remove" data-id="${id}">Убрать из списка</button></div>` : ''}
  </section>`;
}

function extraList(title, ids) {
  if (!ids.length) return '';
  return `<details class="group"><summary>${title} · ${ids.length}</summary><ul>${ids.map(id => {
    const a = store.anime[id], r = rateOf(id);
    return `<li><a href="#f/${id}">${esc(nameOf(a))}</a>
      <span class="muted small">${esc(KIND[a.kind] || a.kind)} · ${year(a)}${r ? ' · ' + STATUS[r.status] : ''}</span></li>`;
  }).join('')}</ul></details>`;
}

let frState = { id: null, error: null };
function viewFranchise(id) {
  const a = store.anime[id];
  const fr = a && store.fr[fkey(a)];
  if (!fr || frState.id !== id) {
    if (frState.id !== id) { frState = { id, error: null }; openFranchise(id); }
    if (frState.error) return `<div class="error">${esc(frState.error)}</div>`;
    return '<div class="skeleton"></div><div class="skeleton"></div>';
  }
  const first = store.anime[fr.seasons[0]] || a;
  const isSeason = fr.seasons.includes(String(id));
  const mine = fr.seasons.filter(s => rateOf(s)).length;
  return `<div class="franchise-head">${img(first.poster)}
      <div><h1>${esc(nameOf(first))}</h1>
      <p class="muted small">${fr.seasons.length} ${plural(fr.seasons.length, 'сезон', 'сезона', 'сезонов')}${fr.films.length ? ` · ${fr.films.length} ${plural(fr.films.length, 'фильм', 'фильма', 'фильмов')}` : ''}${mine ? ` · в списке ${mine}` : ''}</p></div></div>
    ${!isSeason ? `<h2>Открыто</h2><div class="seasons">${seasonBlock(String(id), true)}</div>` : ''}
    <h2>Сезоны по порядку</h2>
    <div class="seasons">${fr.seasons.map(s => seasonBlock(s, s === String(id))).join('')}</div>
    ${extraList('Фильмы', fr.films)}
    ${extraList('OVA и спешлы', fr.extras)}
    ${extraList('Спин-оффы', fr.spinoffs)}`;
}
async function openFranchise(id) {
  try {
    await loadFranchise(id);
    render();
    const el = document.getElementById('s-' + id);
    if (el) el.scrollIntoView({ block: 'center' });
  } catch (e) { frState.error = e.message; render(); }
}

function viewSettings() {
  const u = me(), c = cfg();
  const code = c.clientId ? btoa(unescape(encodeURIComponent(JSON.stringify({ i: c.clientId, s: c.clientSecret })))) : '';
  return `<h1>Настройки</h1>
  <div class="panel">
    <div>Аккаунт Shikimori: <b>${esc(u ? u.nickname : '—')}</b></div>
    ${u ? `<a class="btn" href="${API}/${encodeURIComponent(u.nickname)}/list/anime" target="_blank" rel="noopener">Мой список на Shikimori</a>` : ''}
  </div>
  <div class="panel">
    <div><b>Код для другого устройства</b></div>
    <p class="muted small">Откройте Аниметрек на телефоне, вставьте этот код на экране подключения и войдите. Код даёт доступ только к входу через ваше приложение на Shikimori — не пересылайте его чужим.</p>
    <code class="copy" id="setup-code">${esc(code)}</code>
    <div class="row"><button class="btn" data-act="copy-code">Скопировать код</button></div>
  </div>
  <div class="panel">
    <div><b>Как поставить на телефон</b></div>
    <p class="small">Откройте эту страницу в Chrome на телефоне → меню ⋮ → «Добавить на главный экран». Аниметрек появится иконкой и будет открываться как приложение.</p>
  </div>
  <div class="panel">
    <div class="row">
      <button class="btn" data-act="clear-cache">Очистить кэш</button>
      <button class="btn danger" data-act="logout">Выйти</button>
    </div>
    <p class="muted small">Данные об аниме — Shikimori. Отмеченные серии хранятся в вашем аккаунте там же.</p>
  </div>`;
}

/* ---------- роутер ---------- */
let errorMsg = null;
function route() { return (location.hash || '#watch').slice(1); }
function render() {
  const r = route();
  const view = $('#view');
  const ready = cfg().clientId && tokens() && me();
  for (const a of document.querySelectorAll('.tabs a')) a.toggleAttribute('aria-current', r.startsWith(a.dataset.tab));
  for (const a of document.querySelectorAll('.tabs a[aria-current]')) a.setAttribute('aria-current', 'page');
  const dot = store.rates.some(x => newCount(x) > 0) || newSeasons().length > 0;
  $('#new-dot').hidden = !dot;
  let html;
  if (!ready) html = viewSetup();
  else if (r.startsWith('f/')) html = viewFranchise(r.slice(2));
  else if (r === 'new') html = viewNew();
  else if (r === 'my') html = viewMy();
  else if (r === 'search') html = viewSearch();
  else if (r === 'settings') html = viewSettings();
  else html = viewWatch();
  if (errorMsg) html = `<div class="error">${esc(errorMsg)}</div>` + html;
  const focused = document.activeElement && document.activeElement.id;
  const caret = focused === 'q' ? document.activeElement.selectionStart : null;
  view.innerHTML = html;
  if (focused === 'q') { const q = $('#q'); q.focus(); if (caret != null) q.setSelectionRange(caret, caret); }
}

let toastTimer;
function toast(text, actionLabel, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(text)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
  t.hidden = false;
  if (actionLabel) t.querySelector('button').onclick = async () => { t.hidden = true; try { await action(); } catch (e) { fail(e); } };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, actionLabel ? 8000 : 2600);
}
function fail(e) { errorMsg = e.message || String(e); render(); }

/* ---------- обновление данных ---------- */
async function refresh(force = false) {
  if (store.loading || !(tokens() && me())) return;
  store.loading = true; errorMsg = null;
  $('#btn-refresh').classList.add('spin');
  try {
    await loadRates();
    await loadAnime(store.rates.map(r => r.target), force);
    render();
    // Франшизы: сначала то, что смотрю, потом остальное — ради новых сезонов.
    const groups = myFranchises().sort((x, y) => STATUS_ORDER.indexOf(x.status) - STATUS_ORDER.indexOf(y.status));
    for (const g of groups) {
      if (g.status === 'dropped') continue;
      const cached = store.fr[g.key];
      if (!force && cached && Date.now() - cached._ts < (cached.ongoing ? 6 * 36e5 : 7 * 864e5)) continue;
      await loadFranchise(g.current.target, force);
      render();
    }
    LS.set('synced', Date.now());
  } catch (e) { errorMsg = e.message; }
  finally {
    store.loading = false;
    $('#btn-refresh').classList.remove('spin');
    render();
  }
}

/* ---------- действия ---------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'INPUT' || b.tagName === 'SELECT') return;
  const id = b.dataset.id, act = b.dataset.act;
  try {
    if (act === 'save-cfg') {
      const clientId = $('#cid').value.trim(), clientSecret = $('#csec').value.trim();
      if (!clientId || !clientSecret) { toast('Вставьте Client ID и Client Secret'); return; }
      LS.set('cfg', { clientId, clientSecret });
      startLogin();
    } else if (act === 'use-code') {
      const raw = $('#code').value.trim();
      let c;
      try { c = JSON.parse(decodeURIComponent(escape(atob(raw)))); } catch { toast('Код не подошёл — скопируйте его целиком'); return; }
      LS.set('cfg', { clientId: c.i, clientSecret: c.s });
      startLogin();
    } else if (act === 'copy-code') {
      const text = $('#setup-code').textContent;
      try { await navigator.clipboard.writeText(text); toast('Код скопирован'); }
      catch { const r = document.createRange(); r.selectNodeContents($('#setup-code')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Выделил код — скопируйте вручную'); }
    } else if (act === 'logout') {
      LS.del('tok'); LS.del('me'); store.rates = []; LS.del('rates'); render();
    } else if (act === 'clear-cache') {
      LS.del('anime'); LS.del('fr'); store.fr = {}; for (const k in animeCache) delete animeCache[k];
      store.anime = {}; await refresh(true); toast('Кэш очищен, данные загружены заново');
    } else if (act === 'next') {
      b.disabled = true; await markEpisode(id); render();
    } else if (act === 'inc' || act === 'dec') {
      const r = rateOf(id);
      await markEpisode(id, Math.max(0, r.episodes + (act === 'inc' ? 1 : -1))); render();
    } else if (act === 'add') {
      const st = b.dataset.status;
      await setRate(id, { status: st, episodes: st === 'completed' ? total(store.anime[id]) : 0 });
      toast(`${labelOf(id).label || nameOf(store.anime[id])}: ${STATUS[st].toLowerCase()}`);
      render();
    } else if (act === 'remove') {
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Точно убрать? Нажмите ещё раз'; return; }
      await removeRate(id); toast('Убрано из списка'); render();
    } else if (act === 'links') {
      const el = document.getElementById('le-' + id); el.hidden = !el.hidden;
    } else if (act === 'save-links') {
      let text = (rateOf(id) || {}).text || '';
      for (const s of Object.keys(SITES)) {
        const v = document.getElementById(`lk-${s}-${id}`).value.trim();
        if (v && !/^https?:\/\//.test(v)) { toast('Ссылка должна начинаться с https://'); return; }
        text = withLink(text, s, v);
      }
      await setRate(id, { text });
      toast('Ссылки сохранены'); render();
    }
  } catch (err) { fail(err); }
});

document.addEventListener('change', async e => {
  const el = e.target;
  const id = el.dataset && el.dataset.id;
  try {
    if (el.dataset.act === 'status') {
      const patch = { status: el.value };
      if (el.value === 'completed' && total(store.anime[id])) patch.episodes = total(store.anime[id]);
      await setRate(id, patch); toast('Статус: ' + STATUS[el.value].toLowerCase()); render();
    } else if (el.dataset.act === 'ep') {
      await markEpisode(id, Math.max(0, parseInt(el.value, 10) || 0)); render();
    }
  } catch (err) { fail(err); }
});

let searchTimer, searchSeq = 0;
document.addEventListener('input', e => {
  if (e.target.id !== 'q') return;
  const q = e.target.value.trim();
  lastSearch.q = q;
  clearTimeout(searchTimer);
  if (!q) { lastSearch.items = []; $('#results').innerHTML = searchResults(); return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const d = await gql(`{ animes(search: ${JSON.stringify(q)}, limit: 20, order: popularity) { ${AFIELDS} } }`);
      if (seq !== searchSeq) return;
      for (const a of d.animes) { a._ts = Date.now(); store.anime[a.id] = a; }
      // Трейлеры, клипы и рекламу в выдаче не показываем — их не смотрят сериями.
      lastSearch.items = d.animes.filter(a => !['pv', 'cm', 'music'].includes(a.kind));
      const box = $('#results'); if (box) box.innerHTML = searchResults();
    } catch (err) { const box = $('#results'); if (box) box.innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  }, 450);
});

$('#btn-refresh').addEventListener('click', () => refresh(true));
window.addEventListener('hashchange', () => { errorMsg = null; render(); window.scrollTo(0, 0); });
document.addEventListener('visibilitychange', () => {
  // Вернулись в приложение спустя время — подтянуть свежие серии.
  if (!document.hidden && Date.now() - LS.get('synced', 0) > 15 * 60e3) refresh();
});

(async function start() {
  try { await finishLogin(); } catch (e) { errorMsg = e.message; }
  render();
  if (tokens() && me()) refresh();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
