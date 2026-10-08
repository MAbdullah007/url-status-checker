// Bulk URL status check — Vercel serverless function.
// POST /api/check  { urls: ["https://...", ...] }  (max 15 per call; client batches)
// Server-side requests = no CORS issues, same model as httpstatus.io.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const FULL_HEADERS = {
  'User-Agent': UA,
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

const MAX_HOPS = 8;
const TIMEOUT_MS = 8000;
const MAX_URLS = 15;
const BLOCKED_STATUSES = new Set([403, 406, 429]);

function normalize(raw) {
  let u = String(raw || '').trim().replace(/^["']+|["']+$/g, '');
  if (!u || u.startsWith('#')) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) u = 'https://' + u;
  try {
    return new URL(u).toString();
  } catch {
    return null;
  }
}

async function fetchOnce(url, method, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { method, headers, redirect: 'manual', signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function errName(e) {
  if (e && e.name === 'AbortError') return 'Timeout after ' + TIMEOUT_MS / 1000 + 's';
  const msg = String((e && e.message) || e || 'Request failed');
  // Undici wraps DNS/TLS failures verbosely — keep the useful head.
  return msg.length > 140 ? msg.slice(0, 140) + '…' : msg;
}

// Walk one strategy (method+headers) following redirects manually so the
// full hop chain is captured. Returns { done, result } — done=false means
// "try the next strategy".
async function runStrategy(input, startUrl, strategy, t0) {
  let url = startUrl;
  const chain = [];
  try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const res = await fetchOnce(url, strategy.method, strategy.headers);
      chain.push({ url, status: res.status });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        await res.arrayBuffer().catch(() => {});
        if (!loc) break;
        url = new URL(loc, url).toString();
        continue;
      }
      await res.arrayBuffer().catch(() => {});
      const ms = Date.now() - t0;
      const blocked = BLOCKED_STATUSES.has(res.status);
      // HEAD results are unreliable for 4xx/5xx — escalate to the GET strategy.
      if (strategy.method === 'HEAD' && res.status >= 400) {
        return { done: false, chain };
      }
      return {
        done: true,
        result: {
          url: input,
          status: res.status,
          finalUrl: url,
          ms,
          chain,
          blocked,
          note: blocked ? 'Needs verify — the site is blocking automated checks' : undefined,
        },
      };
    }
    return {
      done: true,
      result: {
        url: input,
        status: chain.length ? chain[chain.length - 1].status : null,
        finalUrl: url,
        ms: Date.now() - t0,
        chain,
        error: 'Too many redirects (>' + MAX_HOPS + ')',
      },
    };
  } catch (e) {
    // Network-level failure on HEAD: let the GET strategy have a go.
    if (strategy.method === 'HEAD') return { done: false, chain };
    return {
      done: true,
      result: {
        url: input,
        status: null,
        finalUrl: null,
        ms: Date.now() - t0,
        chain,
        error: errName(e),
      },
    };
  }
}

async function checkOne(input) {
  const startUrl = normalize(input);
  const t0 = Date.now();
  if (!startUrl) {
    return { url: String(input), status: null, finalUrl: null, ms: 0, chain: [], error: 'Invalid URL' };
  }
  const strategies = [
    { method: 'HEAD', headers: { 'User-Agent': UA } },
    { method: 'GET', headers: FULL_HEADERS },
  ];
  for (const s of strategies) {
    const out = await runStrategy(input, startUrl, s, t0);
    if (out.done) return out.result;
  }
  // Both strategies refused — never present a guess as the real status.
  return {
    url: String(input),
    status: null,
    finalUrl: null,
    ms: Date.now() - t0,
    chain: [],
    blocked: true,
    note: 'Needs verify — the site is blocking automated checks',
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const urls = Array.isArray(body && body.urls) ? body.urls : [];
  const list = [...new Set(urls.map((u) => String(u).trim()).filter(Boolean))].slice(0, MAX_URLS);
  if (!list.length) return res.status(400).json({ error: 'No URLs provided (max ' + MAX_URLS + ' per call)' });

  const results = await Promise.all(list.map(checkOne));
  return res.status(200).json({ results });
}
