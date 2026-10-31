/*
  Dominic Search: function pengambil foto eksternal.

  Endpoint:
    GET  /api/photos/search?q&ratio&page&sources
    GET  /api/photos/curated?page&sources
    POST /api/photos/track   body: {"id":"unsplash:<id>"}

  Variabel lingkungan:
    UNSPLASH_ACCESS_KEY
    PEXELS_API_KEY
    OPENVERSE_CLIENT_ID, OPENVERSE_CLIENT_SECRET
    ALLOWED_ORIGIN            opsional, bila situs dan function beda origin
    UNSPLASH_UTM_SOURCE       opsional, bawaan "dominic_search"
    OPENVERSE_EXCLUDE_ND      opsional, "1" membuang lisensi NoDerivatives

  Pemasangan:
    Cloudflare Workers : export default dari berkas ini dipakai langsung.
    Vercel / Netlify / Node : handle(request, process.env) mengembalikan Response.
*/

const PAGE_SIZE = 24;
const MAX_PAGE = 50;
const MAX_QUERY = 100;

const SOURCE_ORDER = ['unsplash', 'pexels', 'openverse'];
const SOURCE_NAME = { unsplash: 'Unsplash', pexels: 'Pexels', openverse: 'Openverse' };

const RATIO_VALUE = { '1:1': 1, '4:3': 4 / 3, '3:2': 3 / 2, '16:9': 16 / 9, '9:16': 9 / 16, '2:3': 2 / 3 };
const LAND = { unsplash: 'landscape', pexels: 'landscape', openverse: 'wide' };
const PORT = { unsplash: 'portrait', pexels: 'portrait', openverse: 'tall' };
const ORIENTATION = {
  '1:1': { unsplash: 'squarish', pexels: 'square', openverse: 'square' },
  '4:3': LAND, '3:2': LAND, '16:9': LAND,
  '9:16': PORT, '2:3': PORT
};

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class SourceError extends Error {
  constructor(kind, { status = null, retryAfter = null } = {}) {
    super(kind);
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/* ===== Utilitas ===== */

export function ratioLabel(w, h) {
  const r = w / h;
  for (const label in RATIO_VALUE) {
    const t = RATIO_VALUE[label];
    if (Math.abs(r - t) / t < 0.02) return label;
  }
  return null;
}

function clean(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, max).join('');
}

function httpsUrl(v) {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? u.href : null;
  } catch (_) {
    return null;
  }
}

function toInt(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', ...headers }
  });
}

function interleave(lists) {
  const out = [], seen = new Set();
  const max = Math.max(0, ...lists.map(l => l.length));
  for (let i = 0; i < max; i++) {
    for (const l of lists) {
      if (i < l.length && !seen.has(l[i].id)) { seen.add(l[i].id); out.push(l[i]); }
    }
  }
  return out;
}

/* ===== Normalisasi ke skema Item ===== */

function build(o) {
  const rawId = String(o.rawId ?? '');
  if (!ID_RE.test(rawId)) return null;
  const w = Math.round(Number(o.w)), h = Math.round(Number(o.h));
  if (!(w > 0 && h > 0)) return null;
  const thumb = httpsUrl(o.thumb), display = httpsUrl(o.display), pageUrl = httpsUrl(o.pageUrl);
  if (!thumb || !display || !pageUrl) return null;
  const licenseUrl = httpsUrl(o.license && o.license.url);
  const licenseName = clean(o.license && o.license.name, 80);
  if (!licenseName || !licenseUrl) return null;
  const creatorName = clean(o.creatorName, 100) || 'Kreator tidak diketahui';
  const tags = [];
  for (const t of Array.isArray(o.tags) ? o.tags : []) {
    const c = clean(t, 40).toLowerCase();
    if (c && !tags.includes(c)) tags.push(c);
    if (tags.length >= 10) break;
  }
  return {
    id: `${o.key}:${rawId}`,
    source: SOURCE_NAME[o.key],
    title: clean(o.title, 200) || `Foto oleh ${creatorName}`,
    w, h,
    ratio: ratioLabel(w, h),
    thumb, display, pageUrl,
    creator: { name: creatorName, url: httpsUrl(o.creatorUrl) },
    license: { name: licenseName, url: licenseUrl },
    attribution: clean(o.attribution, 300) || `Foto oleh ${creatorName} di ${SOURCE_NAME[o.key]}`,
    tags,
    color: typeof o.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.color) ? o.color.toLowerCase() : null,
    cat: null,
    mood: null
  };
}

function normUnsplash(p, env) {
  if (!p || typeof p !== 'object') return null;
  const utm = 'utm_source=' + encodeURIComponent(env.UNSPLASH_UTM_SOURCE || 'dominic_search') + '&utm_medium=referral';
  const withUtm = u => {
    const h = httpsUrl(u);
    return h ? h + (h.includes('?') ? '&' : '?') + utm : null;
  };
  const urls = p.urls || {};
  const name = clean(p.user && p.user.name, 100) || 'Kreator tidak diketahui';
  return build({
    key: 'unsplash', rawId: p.id, w: p.width, h: p.height,
    title: clean(p.alt_description || p.description, 200),
    thumb: urls.small, display: urls.regular,
    pageUrl: withUtm(p.links && p.links.html),
    creatorName: name, creatorUrl: withUtm(p.user && p.user.links && p.user.links.html),
    license: { name: 'Unsplash License', url: 'https://unsplash.com/license' },
    attribution: `Foto oleh ${name} di Unsplash`,
    tags: (Array.isArray(p.tags) ? p.tags : []).map(t => t && t.title),
    color: p.color
  });
}

function normPexels(p) {
  if (!p || typeof p !== 'object') return null;
  const src = p.src || {};
  const name = clean(p.photographer, 100) || 'Kreator tidak diketahui';
  return build({
    key: 'pexels', rawId: p.id, w: p.width, h: p.height,
    title: clean(p.alt, 200),
    thumb: src.medium, display: src.large2x || src.large,
    pageUrl: p.url,
    creatorName: name, creatorUrl: p.photographer_url,
    license: { name: 'Pexels License', url: 'https://www.pexels.com/license/' },
    attribution: `Foto oleh ${name} di Pexels`,
    tags: [],
    color: p.avg_color
  });
}

function ccName(code, version) {
  const c = String(code || '').toLowerCase();
  if (!c) return null;
  if (c === 'cc0') return 'CC0 1.0';
  if (c === 'pdm') return 'Public Domain Mark 1.0';
  return `CC ${c.toUpperCase().replace(/-/g, ' ')}${version ? ' ' + version : ''}`;
}

function ccUrl(code, version) {
  const c = String(code || '').toLowerCase();
  if (c === 'cc0') return 'https://creativecommons.org/publicdomain/zero/1.0/';
  if (c === 'pdm') return 'https://creativecommons.org/publicdomain/mark/1.0/';
  return c && version ? `https://creativecommons.org/licenses/${c}/${version}/` : null;
}

function normOpenverse(p, env) {
  if (!p || typeof p !== 'object') return null;
  const code = String(p.license || '').toLowerCase();
  if (env.OPENVERSE_EXCLUDE_ND === '1' && /(^|-)nd($|-)/.test(code)) return null;
  const licName = ccName(code, p.license_version);
  const creator = clean(p.creator, 100) || 'Kreator tidak diketahui';
  const title = clean(p.title, 200);
  return build({
    key: 'openverse', rawId: p.id, w: p.width, h: p.height,
    title,
    thumb: p.thumbnail || p.url, display: p.url,
    pageUrl: p.foreign_landing_url,
    creatorName: creator, creatorUrl: p.creator_url,
    license: { name: licName, url: httpsUrl(p.license_url) || ccUrl(code, p.license_version) },
    attribution: `${title || 'Tanpa judul'} oleh ${creator} (${licName})`,
    tags: (Array.isArray(p.tags) ? p.tags : []).map(t => t && t.name)
  });
}

/* ===== Handler ===== */

export function createHandler(deps = {}) {
  const fetchFn = deps.fetch || ((...a) => globalThis.fetch(...a));
  const now = deps.now || Date.now;
  const timeoutMs = deps.timeoutMs ?? 4000;
  const cacheTtlMs = deps.cacheTtlMs ?? 10 * 60 * 1000;
  const cacheMax = deps.cacheMax ?? 500;
  const quotaFloor = deps.quotaFloor ?? 1;
  const cooldownSec = deps.cooldownSec ?? 300;

  const cache = new Map();
  const inflight = new Map();
  const cooldown = new Map();
  let ovToken = null;

  function retryAfterOf(res) {
    const n = toInt(res.headers.get('retry-after'));
    return n && n > 0 ? Math.min(n, 86400) : cooldownSec;
  }
  function resetOf(res) {
    const n = toInt(res.headers.get('x-ratelimit-reset'));
    const left = n ? n - Math.floor(now() / 1000) : 0;
    return left > 0 ? Math.min(left, 86400) : cooldownSec;
  }

  async function call(src, url, init = {}) {
    const t = now();
    const until = cooldown.get(src);
    if (until && until > t) throw new SourceError('quota', { retryAfter: Math.ceil((until - t) / 1000) });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetchFn(String(url), { ...init, signal: ac.signal });
      } catch (_) {
        throw new SourceError(ac.signal.aborted ? 'timeout' : 'network');
      }
      const remaining = toInt(res.headers.get('x-ratelimit-remaining'));
      if (res.status === 429) {
        const sec = retryAfterOf(res);
        cooldown.set(src, now() + sec * 1000);
        throw new SourceError('quota', { status: 429, retryAfter: sec });
      }
      if (remaining !== null && remaining <= quotaFloor) {
        cooldown.set(src, now() + resetOf(res) * 1000);
      }
      if (!res.ok) throw new SourceError('http', { status: res.status });
      let body;
      try {
        body = await res.json();
      } catch (_) {
        throw new SourceError(ac.signal.aborted ? 'timeout' : 'parse');
      }
      return { body, headers: res.headers };
    } finally {
      clearTimeout(timer);
    }
  }

  function keepRatio(items, ratio) {
    return ratio === 'all' ? items : items.filter(it => it.ratio === ratio);
  }

  async function openverseToken(env, force) {
    if (!force && ovToken && ovToken.exp > now()) return ovToken.value;
    const { body } = await call('openverse', 'https://api.openverse.org/v1/auth_tokens/token/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.OPENVERSE_CLIENT_ID,
        client_secret: env.OPENVERSE_CLIENT_SECRET,
        grant_type: 'client_credentials'
      }).toString()
    });
    if (!body || typeof body.access_token !== 'string') throw new SourceError('parse');
    ovToken = { value: body.access_token, exp: now() + Math.max(0, (Number(body.expires_in) || 0) - 60) * 1000 };
    return ovToken.value;
  }

  const adapters = {
    unsplash: {
      configured: env => Boolean(env.UNSPLASH_ACCESS_KEY),
      curated: true,
      headers: env => ({ authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}`, 'accept-version': 'v1' }),
      async search(env, { q, ratio, page, perPage }) {
        const u = new URL('https://api.unsplash.com/search/photos');
        u.searchParams.set('query', q);
        u.searchParams.set('page', String(page));
        u.searchParams.set('per_page', String(perPage));
        if (ratio !== 'all') u.searchParams.set('orientation', ORIENTATION[ratio].unsplash);
        const { body } = await call('unsplash', u, { headers: this.headers(env) });
        if (!body || !Array.isArray(body.results)) throw new SourceError('parse');
        const totalPages = toInt(body.total_pages) || 0;
        return {
          items: keepRatio(body.results.map(p => normUnsplash(p, env)).filter(Boolean), ratio),
          total: toInt(body.total) || 0,
          hasMore: page < totalPages
        };
      },
      async listCurated(env, { page, perPage }) {
        const u = new URL('https://api.unsplash.com/photos');
        u.searchParams.set('page', String(page));
        u.searchParams.set('per_page', String(perPage));
        u.searchParams.set('order_by', 'popular');
        const { body, headers } = await call('unsplash', u, { headers: this.headers(env) });
        if (!Array.isArray(body)) throw new SourceError('parse');
        const total = toInt(headers.get('x-total'));
        return {
          items: body.map(p => normUnsplash(p, env)).filter(Boolean),
          total: total ?? 0,
          hasMore: total !== null ? page * perPage < total : body.length >= perPage
        };
      }
    },

    pexels: {
      configured: env => Boolean(env.PEXELS_API_KEY),
      curated: true,
      headers: env => ({ authorization: env.PEXELS_API_KEY }),
      async search(env, { q, ratio, page, perPage }) {
        const u = new URL('https://api.pexels.com/v1/search');
        u.searchParams.set('query', q);
        u.searchParams.set('page', String(page));
        u.searchParams.set('per_page', String(perPage));
        if (ratio !== 'all') u.searchParams.set('orientation', ORIENTATION[ratio].pexels);
        const { body } = await call('pexels', u, { headers: this.headers(env) });
        if (!body || !Array.isArray(body.photos)) throw new SourceError('parse');
        return {
          items: keepRatio(body.photos.map(normPexels).filter(Boolean), ratio),
          total: toInt(body.total_results) || 0,
          hasMore: Boolean(body.next_page)
        };
      },
      async listCurated(env, { page, perPage }) {
        const u = new URL('https://api.pexels.com/v1/curated');
        u.searchParams.set('page', String(page));
        u.searchParams.set('per_page', String(perPage));
        const { body } = await call('pexels', u, { headers: this.headers(env) });
        if (!body || !Array.isArray(body.photos)) throw new SourceError('parse');
        return {
          items: body.photos.map(normPexels).filter(Boolean),
          total: toInt(body.total_results) || 0,
          hasMore: Boolean(body.next_page)
        };
      }
    },

    openverse: {
      configured: env => Boolean(env.OPENVERSE_CLIENT_ID && env.OPENVERSE_CLIENT_SECRET),
      curated: false,
      async search(env, { q, ratio, page, perPage }) {
        const u = new URL('https://api.openverse.org/v1/images/');
        u.searchParams.set('q', q);
        u.searchParams.set('page', String(page));
        u.searchParams.set('page_size', String(Math.min(perPage, 20)));
        if (ratio !== 'all') u.searchParams.set('aspect_ratio', ORIENTATION[ratio].openverse);
        let res;
        for (let attempt = 0; ; attempt++) {
          const token = await openverseToken(env, attempt > 0);
          try {
            res = await call('openverse', u, { headers: { authorization: `Bearer ${token}` } });
            break;
          } catch (e) {
            if (e.status === 401 && attempt === 0) continue;
            throw e;
          }
        }
        const body = res.body;
        if (!body || !Array.isArray(body.results)) throw new SourceError('parse');
        const pageCount = toInt(body.page_count) || 0;
        return {
          items: keepRatio(body.results.map(p => normOpenverse(p, env)).filter(Boolean), ratio),
          total: toInt(body.result_count) || 0,
          hasMore: page < pageCount
        };
      }
    }
  };

  function runSource(src, mode, env, params) {
    const key = [src, mode, String(params.q || '').toLowerCase(), params.ratio, params.page, params.perPage].join('|');
    const hit = cache.get(key);
    if (hit && hit.exp > now()) return Promise.resolve(hit.value);
    if (inflight.has(key)) return inflight.get(key);
    const fn = mode === 'search' ? adapters[src].search : adapters[src].listCurated;
    const p = (async () => {
      const value = await fn.call(adapters[src], env, params);
      if (cache.size >= cacheMax) cache.delete(cache.keys().next().value);
      cache.set(key, { value, exp: now() + cacheTtlMs });
      return value;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  /* ----- Validasi ----- */

  class BadParam extends Error {
    constructor(field) { super(field); this.field = field; }
  }

  function parseParams(sp, needQuery) {
    const out = { q: '', ratio: 'all', page: 1, sources: SOURCE_ORDER.slice() };
    if (needQuery) {
      const raw = sp.get('q');
      if (raw === null) throw new BadParam('q');
      const q = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!q || Array.from(q).length > MAX_QUERY) throw new BadParam('q');
      out.q = q;
      const ratio = sp.get('ratio') ?? 'all';
      if (ratio !== 'all' && !Object.prototype.hasOwnProperty.call(RATIO_VALUE, ratio)) throw new BadParam('ratio');
      out.ratio = ratio;
    }
    const page = sp.get('page') ?? '1';
    if (!/^[0-9]{1,3}$/.test(page) || Number(page) < 1 || Number(page) > MAX_PAGE) throw new BadParam('page');
    out.page = Number(page);
    const srcRaw = sp.get('sources');
    if (srcRaw !== null) {
      const list = srcRaw.split(',').map(s => s.trim());
      if (!list.length || list.some(s => !SOURCE_ORDER.includes(s))) throw new BadParam('sources');
      out.sources = SOURCE_ORDER.filter(s => list.includes(s));
    }
    return out;
  }

  /* ----- Search dan curated ----- */

  async function listPhotos(mode, sp, env) {
    let p;
    try {
      p = parseParams(sp, mode === 'search');
    } catch (e) {
      if (e instanceof BadParam) return json({ error: 'invalid_params', field: e.field }, 400, { 'cache-control': 'no-store' });
      throw e;
    }

    const candidates = p.sources.filter(s => mode === 'search' || adapters[s].curated);
    if (!candidates.length) {
      return json({ items: [], total: 0, hasMore: false, failed: [], page: p.page });
    }
    const active = candidates.filter(s => adapters[s].configured(env));
    const unconfigured = candidates.filter(s => !adapters[s].configured(env));
    const perPage = Math.ceil(PAGE_SIZE / Math.max(active.length, 1));

    const settled = await Promise.allSettled(active.map(s =>
      runSource(s, mode === 'search' ? 'search' : 'curated', env, { q: p.q, ratio: p.ratio, page: p.page, perPage })
    ));

    const ok = [], errors = [];
    const failed = unconfigured.map(s => SOURCE_NAME[s]);
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        ok.push(r.value);
      } else {
        const e = r.reason instanceof SourceError ? r.reason : new SourceError('internal');
        errors.push(e);
        failed.push(SOURCE_NAME[active[i]]);
        console.warn('source_failed', active[i], e.kind, e.status ?? '');
      }
    });
    unconfigured.forEach(() => errors.push(new SourceError('config')));

    if (!ok.length) {
      if (errors.length && errors.every(e => e.kind === 'quota')) {
        const retryAfter = Math.min(...errors.map(e => e.retryAfter || cooldownSec));
        return json({ error: 'quota_exceeded', retryAfter }, 429, { 'retry-after': String(retryAfter), 'cache-control': 'no-store' });
      }
      return json({ error: 'all_sources_failed' }, 502, { 'cache-control': 'no-store' });
    }

    const items = interleave(ok.map(r => r.items));
    const body = {
      items,
      total: ok.reduce((n, r) => n + r.total, 0),
      hasMore: ok.some(r => r.hasMore),
      failed,
      page: p.page
    };
    return json(body, 200, { 'cache-control': failed.length ? 'no-store' : 'public, max-age=60' });
  }

  /* ----- Track ----- */

  async function track(request, env) {
    const text = await request.text();
    let id;
    try {
      if (text.length > 2048) throw new Error('large');
      id = JSON.parse(text).id;
    } catch (_) {
      return json({ error: 'invalid_params', field: 'body' }, 400);
    }
    const m = typeof id === 'string' ? /^(unsplash|pexels|openverse):([A-Za-z0-9_-]{1,64})$/.exec(id) : null;
    if (!m) return json({ error: 'invalid_params', field: 'id' }, 400);
    if (m[1] !== 'unsplash') return json({ ok: true, tracked: false });
    if (!adapters.unsplash.configured(env)) return json({ error: 'track_failed' }, 502);
    try {
      await call('unsplash', `https://api.unsplash.com/photos/${encodeURIComponent(m[2])}/download`, {
        headers: adapters.unsplash.headers(env)
      });
      return json({ ok: true, tracked: true });
    } catch (e) {
      if (e instanceof SourceError && e.kind === 'quota') {
        const retryAfter = e.retryAfter || cooldownSec;
        return json({ error: 'quota_exceeded', retryAfter }, 429, { 'retry-afte
