// Snapshot the market state to the GitHub bus so the Session Analyst cloud
// routines (no egress to tradedadlog.com) can read it from the repo checkout.
//
// Writes live/market.json = session-feed + cc-news, wrapped with a builtAt.
//
// De-dupe: builtAt (and feed.generatedAt / news.fetchedAt) change on every call,
// which used to defeat busPut's skip-if-unchanged and produce a commit every 5
// min around the clock. We now compare only the MEANINGFUL payload (per-source
// records + news events) against what's already in the bus and skip the write
// entirely when nothing changed (market closed, weekends, overnight lulls).
//
// HTTP entrypoint (test by hand: GET /api/sa-bus-snapshot). The 5-min cron lives
// in sa-bus-cron.mjs and calls runSnapshot() here.
import feedHandler from './session-feed.mjs';
import newsHandler from './cc-news.mjs';
import { busGet, busPut } from './_sa-bus.mjs';

const readJson = async (handler) => {
  try {
    const res = await handler(new Request('https://tradedadlog.com/internal'));
    return await res.json();
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
};

// A stable fingerprint of the payload that ignores the always-changing timestamps
// (builtAt, feed.generatedAt, news.fetchedAt). Per-source records only change when
// a new indicator webhook lands (their receivedAt), and news.events only when the
// calendar scrape changes, so this flips exactly when there is real new data.
function stableKey(feed, news) {
  const f = (feed && feed.symbols) ? { symbols: feed.symbols } : (feed || null);
  const n = (news && news.events) ? { source: news.source, events: news.events } : (news || null);
  try { return JSON.stringify({ f, n }); } catch (e) { return null; }
}

export async function runSnapshot() {
  const token = process.env.SA_BUS_TOKEN;
  const now = new Date().toISOString();
  if (!token) return { ok: false, reason: 'SA_BUS_TOKEN no configurado', builtAt: now };

  const [feed, news] = await Promise.all([readJson(feedHandler), readJson(newsHandler)]);

  // Si el feed no trae symbols (handler cayo), NO escribas: dejarias el bus con un
  // blob de error en vez del ultimo market.json bueno.
  if (!feed || !feed.symbols) {
    return { ok: false, error: 'feed sin symbols: ' + (feed && feed.error || 'desconocido'), builtAt: now };
  }

  const key = stableKey(feed, news);

  try {
    // What's in the bus now? Compare the meaningful payload only.
    // cur: {content,sha} si existe · null si 404 · undefined si el GET fallo
    let cur, prevKey = null, prevBuiltAt = null;
    try {
      cur = await busGet('live/market.json', { token });
      if (cur && cur.content) {
        const pj = JSON.parse(cur.content);
        prevKey = stableKey(pj.feed, pj.news);
        prevBuiltAt = pj.builtAt || null;
      }
    } catch (e) { cur = undefined; /* el GET fallo: que busPut lo reintente */ }

    if (key != null && prevKey != null && key === prevKey) {
      // nada nuevo: no tocamos el bus (evita el commit cada 5 min con el mercado cerrado)
      return { ok: true, unchanged: true, builtAt: prevBuiltAt || now };
    }

    const body = JSON.stringify({ builtAt: now, feed, news }, null, 2) + '\n';
    // pasamos `cur` para que busPut no repita el GET
    const r = await busPut('live/market.json', body, `sa-bus: market snapshot ${now}`, { token, known: cur });

    // Hourly archive for replay / calibration bootstrap. Only in the :00-:05 window
    // of the 5-min cron, and only when the payload actually changed (this branch),
    // so closed periods don't pile up identical hourly files.
    let archive = null;
    const d = new Date(now);
    if (d.getUTCMinutes() < 5) {
      const day = now.slice(0, 10);                          // YYYY-MM-DD
      const hh = String(d.getUTCHours()).padStart(2, '0');   // HH UTC
      try {
        archive = await busPut(
          `snapshots/${day}/${hh}.json`, body,
          `sa-bus: snapshot archive ${day} ${hh}:00Z`, { token }
        );
      } catch (e) { archive = { error: String(e && e.message || e) }; }
    }

    return { ok: true, ...r, archive, builtAt: now };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), builtAt: now };
  }
}

export default async () => {
  const r = await runSnapshot();
  return new Response(JSON.stringify(r), {
    status: r.ok ? 200 : (r.reason ? 503 : 502),
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
};
