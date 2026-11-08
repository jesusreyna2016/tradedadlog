// Cliente minimo de la API de MyFundedPerps (solo lectura).
// Docs: https://docs.myfundedperpetuals.com/api-reference · ~300 solicitudes/min por IP.
// Requiere MFP_API_KEY (key "Read Only", empieza con fp_live_) en el entorno de Netlify.
const BASE = 'https://developers.myfundedperpetuals.com';

export const hasKey = () => !!process.env.MFP_API_KEY;

async function get(path, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  const r = await fetch(BASE + path + (q ? '?' + q : ''), { headers: { authorization: 'Bearer ' + process.env.MFP_API_KEY, accept: 'application/json' } });
  if (r.status === 429) { const e = new Error('rate_limited'); e.retryAfter = +r.headers.get('retry-after') || 60; throw e; }
  if (!r.ok) {
    let code = 'http_' + r.status;
    try { code = (await r.json())?.error?.code || code; } catch (e) { /* sin cuerpo */ }
    throw new Error(code);
  }
  return r.json();
}

export const listAccounts = async () => (await get('/v1/accounts')).data || [];
export const getAccount = async (id) => { const j = await get('/v1/accounts/' + id); return j.data || j; };
export const openPositions = async (id) => (await get('/v1/positions', { account_id: id })).data || [];
export const workingOrders = async (id) => (await get('/v1/orders', { account_id: id, status: 'working' })).data || [];

// Posiciones cerradas, de la mas nueva a la mas vieja, hasta 'since' (ms) o 'maxPages'
export async function closedPositions(id, { since = 0, maxPages = 20 } = {}) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < maxPages; i++) {
    const j = await get('/v1/positions', { account_id: id, status: 'closed', limit: 100, cursor });
    const page = j.data || [];
    out.push(...page);
    if (!j.has_more || !j.next_cursor) break;
    if (page.length && Math.min(...page.map((p) => p.closed_at || 0)) < since) break;
    cursor = j.next_cursor;
  }
  return out.filter((p) => (p.closed_at || 0) > since);
}

// Reglas efectivas de la cuenta (inactividad, limites, payout pendiente)
export const tradingPolicy = async (id) => { const j = await get('/v1/accounts/' + id + '/trading-policy'); return j.data || j; };

// Ultima posicion cerrada (para la regla de inactividad)
export async function lastClosedAt(id) {
  const j = await get('/v1/positions', { account_id: id, status: 'closed', limit: 1 });
  return j.data?.[0]?.closed_at || null;
}

// Ejecuciones (fills), de la mas nueva a la mas vieja, hasta 'since' (ms) o 'maxPages'
export async function fillsSince(id, { since = 0, maxPages = 10 } = {}) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < maxPages; i++) {
    const j = await get('/v1/fills', { account_id: id, limit: 100, cursor });
    const page = j.data || [];
    out.push(...page);
    if (!j.has_more || !j.next_cursor) break;
    if (page.length && Math.min(...page.map((f) => f.settled_at || 0)) < since) break;
    cursor = j.next_cursor;
  }
  return out.filter((f) => (f.settled_at || 0) > since && f.status === 'filled');
}

// Una posicion tiene stop si hay una orden viva de stop que la cierre
export function hasStop(pos, orders) {
  const closeSide = pos.side === 'long' ? 'sell' : 'buy';
  return orders.some((o) => (o.bracket_role === 'stop_loss' || /^stop/.test(o.type || '')) &&
    (o.target_position_id === pos.id || (o.symbol === pos.symbol && (o.reduce_only || o.bracket_role === 'stop_loss' || String(o.side).toLowerCase() === closeSide))));
}

// 'XYZ100' -> 'NQ' (familia de Mi Mesa)
export function familyOf(symbol) {
  const s = String(symbol || '').toUpperCase().replace(/^[A-Z0-9]+:/, '');
  if (s === 'XYZ100' || s === 'NAS100' || s === 'NDX') return 'NQ';
  if (s === 'XYZ500' || s === 'SPX' || s === 'US500') return 'ES';
  if (s === 'GOLD' || s === 'XAU' || s === 'PAXG') return 'GC';
  return s.replace(/USDT?$/, '');
}
