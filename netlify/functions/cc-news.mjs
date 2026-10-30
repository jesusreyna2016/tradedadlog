// Calendario economico para el Command Center.
// Baja el feed semanal de ForexFactory (JSON publico), lo normaliza a alto impacto,
// lo cachea en Netlify Blobs (~30 min) y lo sirve al Center. Sin claves.
import { getStore } from '@netlify/blobs';

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const TTL_MS = 30 * 60 * 1000;   // refresca como mucho cada 30 min

// Eventos que mueven el crudo (CL) aunque ForexFactory los marque impacto bajo:
// inventario semanal de la EIA, OPEP, gas natural, informe de energia. Van con
// tag "oil" para que el Session Analyst los use como ventana de no-trade de CL
// (no disparan el candado del Center, que es NQ-centrico).
const OIL_RX = /(crude oil inventories|\beia\b|\bopec\b|opec-jmmc|gasoline inventories|natural gas storage|petroleum status|short-term energy outlook|\bapi\b weekly)/i;

function normalize(raw){
  if(!Array.isArray(raw)) return [];
  const out = [];
  for(const e of raw){
    const impact = String(e.impact || '').toLowerCase();   // high | medium | low | holiday
    const cur = String(e.country || e.currency || '').toUpperCase();
    const title = e.title || '';
    const isOil = OIL_RX.test(title);
    // nos quedamos con lo que mueve al NQ (alto impacto + medio USD) MAS lo que mueve al CL
    const keep = impact === 'high' || (impact === 'medium' && cur === 'USD') || isOil;
    if(!keep) continue;
    const ts = e.date ? new Date(e.date).getTime() : null;
    if(!ts || !isFinite(ts)) continue;
    out.push({
      title,
      currency: cur,
      impact: impact === 'high' ? 'high' : 'medium',
      ts,
      tags: isOil ? ['oil'] : [],
      forecast: (e.forecast === '' ? null : e.forecast) ?? null,
      previous: (e.previous === '' ? null : e.previous) ?? null
    });
  }
  out.sort((a,b)=> a.ts - b.ts);
  return out.slice(0, 80);
}

// Earnings de las megacaps que pesan en el NQ. ForexFactory es macro y no los trae;
// reportan casi siempre tras el cierre de NY, o sea que la reaccion cae en Globex/Asia.
// Fuente: calendario publico de Nasdaq (sin clave), un request por dia.
const NQ_HEAVY = ['NVDA','AAPL','MSFT','AMZN','GOOGL','GOOG','META','AVGO','TSLA','NFLX','COST','AMD','PLTR'];
const EARN_DAYS = 8;   // hoy + 7 dias calendario (ET)

// hora ET de un dia dado -> epoch ms (respeta DST de Nueva York)
function etTs(ymd, hh, mm){
  const guess = Date.UTC(+ymd.slice(0,4), +ymd.slice(5,7)-1, +ymd.slice(8,10), hh, mm);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(guess)).find((x) => x.type === 'timeZoneName').value;   // "GMT-4"
  const h = parseInt(off.replace('GMT', ''), 10) || 0;
  return guess - h * 3600e3;
}

function etYmd(ts){
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ts));
}

async function fetchEarnings(){
  const days = [];
  for(let i = 0; i < EARN_DAYS; i++) days.push(etYmd(Date.now() + i * 86400e3));
  const out = [];
  const seen = new Set();
  await Promise.all(days.map(async (ymd) => {
    const r = await fetch('https://api.nasdaq.com/api/calendar/earnings?date=' + ymd, {
      headers: { 'user-agent': 'Mozilla/5.0 (TradeDadLog Command Center)', 'accept': 'application/json' }
    });
    if(!r.ok) throw new Error('nasdaq ' + r.status);
    const j = await r.json();
    const rows = (j && j.data && Array.isArray(j.data.rows)) ? j.data.rows : [];
    for(const row of rows){
      const sym = String(row.symbol || '').toUpperCase();
      if(!NQ_HEAVY.includes(sym)) continue;
      // GOOG/GOOGL son la misma empresa: una sola fila
      const key = (sym === 'GOOG' ? 'GOOGL' : sym) + ymd;
      if(seen.has(key)) continue;
      seen.add(key);
      const t = String(row.time || '');
      const when = t.includes('after') ? 'amc' : t.includes('pre') ? 'bmo' : 'tbd';
      // amc ~16:05 ET, bmo ~08:00 ET; sin hora confirmada se asume amc (lo habitual en megacaps)
      const ts = when === 'bmo' ? etTs(ymd, 8, 0) : etTs(ymd, 16, 5);
      out.push({
        symbol: sym === 'GOOG' ? 'GOOGL' : sym,
        name: row.name || sym,
        date: ymd,
        when,
        ts,
        epsForecast: row.epsForecast || null
      });
    }
  }));
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// Titulares de las ultimas 24 h: lo que el grafico no ve (guerra, Trump/aranceles, Fed,
// earnings, crudo). Se etiquetan por tema para que el Session Analyst los pese.
const HEADLINE_FEEDS = [
  'https://www.cnbc.com/id/100003114/device/rss/rss.html',   // CNBC top news
  'https://www.cnbc.com/id/20910258/device/rss/rss.html',    // CNBC economy
  'https://news.google.com/rss/search?q=(stock+futures+OR+tariffs+OR+Trump+OR+war+OR+Fed+OR+oil)+when:1d&hl=en-US&gl=US&ceid=US:en',
  // cripto: ETH es lo que Jesus opera el fin de semana, cuando no hay calendario macro
  'https://cointelegraph.com/rss',
  'https://www.theblock.co/rss.xml',
  'https://decrypt.co/feed'
];
const THEMES = [
  ['geo',      /\b(war|missile|strike[sd]?|attack|invasion|troops|iran|israel|gaza|russia|ukraine|taiwan|north korea|ceasefire|sanction|hormuz)/i],
  ['trump',    /\b(trump|tariff|white house|executive order|truth social)/i],
  ['fed',      /\b(fed|fomc|powell|warsh|rate (cut|hike)|treasury yield|inflation|cpi|jobs report|payrolls)/i],
  ['earnings', /\b(earnings|revenue|guidance|quarterly results|beats|misses)\b/i],
  ['oil',      /\b(oil|crude|opec|brent|hormuz|tankers?)\b/i],
  ['crypto',   /\b(bitcoin|btc|crypto|ether|ethereum|eth|binance|coinbase|stablecoins?|solana)\b/i],
  // sub-temas cripto que mueven a ETH sin calendario
  ['eth',      /\b(ether|ethereum|eth|vitalik|staking|layer[- ]?2|pectra|fusaka|glamsterdam)\b/i],
  ['hack',     /\b(hack(ed|er|s)?|exploit(ed)?|drain(ed)?|stolen|breach)\b/i],
  ['etf',      /\b(etfs?|inflows?|outflows?|blackrock|fidelity|grayscale)\b/i],
  ['regulation', /\b(sec|cftc|regulat\w*|lawsuit|ban|senate|clarity act|genius act)\b/i],
  ['liquidation', /\b(liquidat\w*|short squeeze|long squeeze)\b/i]
];

const CRYPTO_HOSTS = ['cointelegraph.com', 'theblock.co', 'decrypt.co'];
const CRYPTO_SUBTAGS = ['eth', 'hack', 'etf', 'regulation', 'liquidation'];

function decodeXml(t){
  return String(t || '').replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
}

async function fetchHeadlines(){
  const since = Date.now() - 24 * 3600e3;
  const lists = await Promise.all(HEADLINE_FEEDS.map(async (u) => {
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (TradeDadLog Command Center)' } });
      if(!r.ok) return [];
      const xml = await r.text();
      const items = xml.split(/<item[\s>]/).slice(1);
      return items.map((it) => {
        const pick = (tag) => { const m = it.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>')); return m ? decodeXml(m[1]) : ''; };
        const host = new URL(u).hostname.replace(/^www\./, '');
        const src = pick('source') || ({ 'cnbc.com': 'CNBC', 'cointelegraph.com': 'Cointelegraph', 'theblock.co': 'The Block', 'decrypt.co': 'Decrypt' }[host] || '');
        const title = pick('title').replace(/\s+-\s+[^-]+$/, (m) => (src && m.includes(src.split('.')[0]) ? '' : m));
        return { title, ts: Date.parse(pick('pubDate')) || null, source: src, cryptoFeed: CRYPTO_HOSTS.includes(host) };
      });
    } catch(e){ return []; }
  }));
  const seen = new Set();
  const out = [];
  for(const h of lists.flat()){
    if(!h.title || !h.ts || h.ts < since) continue;
    const k = h.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').slice(0, 60);
    if(seen.has(k)) continue;
    seen.add(k);
    let tags = THEMES.filter(([, rx]) => rx.test(h.title)).map(([t]) => t);
    // los sub-temas cripto (hack, etf, regulation...) solo valen en titulares cripto:
    // "Senate lawsuit" en CNBC no es regulacion cripto
    const isCrypto = h.cryptoFeed || tags.includes('crypto');
    if(isCrypto && !tags.includes('crypto')) tags.unshift('crypto');
    if(!isCrypto) tags = tags.filter((t) => !CRYPTO_SUBTAGS.includes(t));
    const { cryptoFeed, ...rest } = h;
    out.push({ ...rest, tags });
  }
  // primero lo etiquetado (es lo que mueve), luego lo mas reciente
  out.sort((a, b) => (b.tags.length > 0) - (a.tags.length > 0) || b.ts - a.ts);
  return out.slice(0, 45);
}

async function fetchFF(){
  const r = await fetch(FF_URL, {
    headers: { 'user-agent': 'Mozilla/5.0 (TradeDadLog Command Center)', 'accept': 'application/json' }
  });
  if(!r.ok) throw new Error('ff ' + r.status);
  const raw = await r.json();
  return normalize(raw);
}

export default async () => {
  const cors = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store'
  };
  let store = null;
  try { store = getStore('cc'); } catch(e){ store = null; }

  // 1) cache fresca
  let cached = null;
  if(store){
    try { cached = await store.get('news', { type: 'json' }); } catch(e){ cached = null; }
    if(cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < TTL_MS){
      return new Response(JSON.stringify(cached), { headers: cors });
    }
  }

  // 2) refrescar del feed
  // cada fuente cae por separado: si una falla se conserva lo ultimo que haya de ella
  const [ffRes, earnRes, headlines] = await Promise.all([
    fetchFF().then((e) => ({ ok: true, e }), (err) => ({ ok: false, err })),
    fetchEarnings().then((e) => ({ ok: true, e }), () => ({ ok: false })),
    fetchHeadlines().catch(() => [])
  ]);
  if(!ffRes.ok && cached){
    // 3) si el calendario falla, devuelve lo ultimo que haya (aunque este viejo)
    return new Response(JSON.stringify({ ...cached, stale: true }), { headers: cors });
  }
  const payload = {
    fetchedAt: Date.now(),
    source: 'forexfactory',
    events: ffRes.ok ? ffRes.e : [],
    earnings: earnRes.ok ? earnRes.e : ((cached && cached.earnings) || []),
    earningsSource: 'nasdaq',
    headlines: headlines.length ? headlines : ((cached && cached.headlines) || [])
  };
  if(!ffRes.ok){
    payload.error = String(ffRes.err && ffRes.err.message || ffRes.err);
    return new Response(JSON.stringify(payload), { headers: cors });
  }
  if(store){ try { await store.setJSON('news', payload); } catch(e){} }
  return new Response(JSON.stringify(payload), { headers: cors });
};
