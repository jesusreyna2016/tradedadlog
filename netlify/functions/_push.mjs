// Alertas push de Mi Mesa (notificaciones al telefono o al navegador).
//
// - Claves VAPID: se generan solas la primera vez y se guardan en Blobs (store 'push',
//   key 'vapid'). No hay que configurar variables de entorno.
// - Suscripciones: solo el dueño (verificado con su sesion de Supabase) puede guardar
//   una. Se guardan en 'push' como 'sub:<id>' con sus preferencias.
// - Disparo: ind-ingest llama a checkZoneAlerts cuando llega una vela de 5m del TDL Feed.
//   Si el precio se acerca o entra a una zona A/A+ del plan intradia, avisa una sola vez
//   por zona y tipo (se acerca / llego). Nunca avisa con datos viejos o con noticia.
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';

const SUPA_URL = 'https://zglcmffcvgohdroiqyux.supabase.co';
// anon key publica del proyecto (la misma que usa el Trading Journal en el navegador)
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpnbGNtZmZjdmdvaGRyb2lxeXV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2MzY5NzQsImV4cCI6MjEwMjIxMjk3NH0.py7TSR9BHbZ7oV1gdZiL9zFCMkwP3M-HNcSEWcWtQMs';
export const OWNER_EMAIL = 'jesusreynacruz@gmail.com';

const store = () => getStore('push');

export async function getVapid() {
  const s = store();
  let v = null;
  try { v = await s.get('vapid', { type: 'json' }); } catch (e) { v = null; }
  if (!v || !v.publicKey || !v.privateKey) {
    v = webpush.generateVAPIDKeys();
    await s.setJSON('vapid', v);
  }
  return v;
}

// Devuelve el email del usuario de la sesion de Supabase, o null.
export async function ownerFromToken(token) {
  if (!token) return null;
  try {
    const r = await fetch(SUPA_URL + '/auth/v1/user', { headers: { apikey: SUPA_ANON, authorization: 'Bearer ' + token } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.email && u.email.toLowerCase() === OWNER_EMAIL ? u.email : null;
  } catch (e) { return null; }
}

export const subId = (endpoint) => {
  let h = 0;
  for (let i = 0; i < endpoint.length; i++) h = (h * 31 + endpoint.charCodeAt(i)) | 0;
  return 'sub:' + (h >>> 0).toString(36) + endpoint.length.toString(36);
};

export async function listSubs() {
  const s = store();
  const out = [];
  try {
    const { blobs } = await s.list({ prefix: 'sub:' });
    for (const b of blobs) {
      const v = await s.get(b.key, { type: 'json' }).catch(() => null);
      if (v && v.subscription) out.push({ key: b.key, ...v });
    }
  } catch (e) { /* sin suscripciones */ }
  return out;
}

export async function sendTo(sub, payload) {
  const v = await getVapid();
  try {
    await webpush.sendNotification(sub.subscription, JSON.stringify(payload), {
      TTL: 900, urgency: 'high',
      vapidDetails: { subject: 'https://tradedadlog.com', publicKey: v.publicKey, privateKey: v.privateKey }
    });
    return { ok: true };
  } catch (e) {
    // 404/410 = la suscripcion ya no existe (el navegador la quito): se borra
    if (e && (e.statusCode === 404 || e.statusCode === 410)) { await store().delete(sub.key).catch(() => {}); return { ok: false, gone: true }; }
    return { ok: false, error: String(e && e.message || e) };
  }
}

const n = (v) => { const x = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : null; };
const fam = (sym) => ({ ETHUSDT: 'ETH', BTCUSDT: 'BTC' }[sym] || sym);
const px = (v) => (v == null ? '' : (+v).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const txt = (v, lang) => (v && typeof v === 'object' ? v[lang] || v.es || '' : v || '');
const chicagoDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
const GRADE_RANK = { 'A+': 3, A: 2, B: 1, C: 0 };

function message(sym, z, type, lang) {
  const f = fam(sym);
  const side = z.side === 'long' ? (lang === 'en' ? 'LONG' : 'COMPRA') : (lang === 'en' ? 'SHORT' : 'VENTA');
  const title = type === 'in'
    ? (lang === 'en' ? `${f}: price is in the ${z.grade} ${side} zone` : `${f}: el precio llegó a la zona ${z.grade} de ${side}`)
    : (lang === 'en' ? `${f}: price is getting close to the ${z.grade} ${side} zone` : `${f}: el precio se acerca a la zona ${z.grade} de ${side}`);
  const body = `${px(z.lo)}–${px(z.hi)} · ` + (lang === 'en'
    ? `stop ${px(z.stop)} · target ${px(z.tp1)}. ${type === 'in' ? 'Wait for the 5-min candle to confirm before entering.' : 'Get ready: open the trade plan, do not enter yet.'}`
    : `stop ${px(z.stop)} · objetivo ${px(z.tp1)}. ${type === 'in' ? 'Espera que la vela de 5 min confirme antes de entrar.' : 'Prepárate: abre el plan del trade, todavía no entres.'}`);
  return { title, body, tag: `${f}-${z.id}`, url: `/#zonas`, sym: f, zone: z.id, trigger: txt(z.trigger, lang) };
}

// 'in' = el precio esta en la zona (con un margen de 0.15 ATR); 'near' = viene hacia ella
// y esta a menos de 1 ATR de 5m; null = nada que avisar.
export function zoneHit(z, price, atr) {
  const inside = price >= z.lo - atr * 0.15 && price <= z.hi + atr * 0.15;
  if (inside) return 'in';
  const comingLong = z.side === 'long' && price > z.hi && price - z.hi <= atr;
  const comingShort = z.side === 'short' && price < z.lo && z.lo - price <= atr;
  return comingLong || comingShort ? 'near' : null;
}

// Llamado con cada vela de 5m del TDL Feed (FEED1). Barato: 2-3 lecturas de Blobs.
export async function checkZoneAlerts(sym, kv) {
  const price = n(kv.close);
  if (price == null) return { skipped: 'sin precio' };
  let plan = null;
  try { plan = await getStore('intraday').get('latest', { type: 'json' }); } catch (e) { plan = null; }
  const p = plan && plan.symbols && plan.symbols[sym];
  if (!p || !p.zones || !p.zones.length) return { skipped: 'sin plan' };
  if (Date.now() - Date.parse(plan.builtAt) > 40 * 60e3) return { skipped: 'plan viejo' };
  if (p.verdict === 'SIN DATOS' || p.verdict === 'NO OPERAR') return { skipped: p.verdict };
  const atr = n(p.atr5) || 0;

  const subs = await listSubs();
  if (!subs.length) return { skipped: 'sin suscripciones' };

  const s = store();
  const day = chicagoDay(Date.now());
  const sent = [];
  for (const z of p.zones) {
    if (z.status === 'invalidada' || z.status === 'funciono') continue;
    const type = zoneHit(z, price, atr);
    if (!type) continue;
    for (const sub of subs) {
      const pr = sub.prefs || {};
      const syms = pr.syms && pr.syms.length ? pr.syms : ['NQ', 'ES', 'GC', 'ETH', 'BTC'];
      if (!syms.includes(fam(sym))) continue;
      if ((GRADE_RANK[z.grade] || 0) < (GRADE_RANK[pr.minGrade || 'A'] || 2)) continue;
      if (type === 'near' && pr.near === false) continue;
      const key = `sent:${day}:${sub.key.slice(4)}:${sym}:${z.id}:${type}`;
      const was = await s.get(key).catch(() => null);
      if (was) continue;
      const r = await sendTo(sub, message(sym, z, type, pr.lang === 'en' ? 'en' : 'es'));
      if (r.ok) { await s.set(key, '1'); sent.push(`${sym} ${z.id} ${type}`); }
    }
  }
  return { sent };
}

// Eventos del indicador de TradingView (MMZ1): avisa al momento cuando una zona se ARMA (la vela de 5 min
// confirmo: es la entrada). Respeta las preferencias de cada suscripcion (mercados, calificacion minima)
// y avisa una sola vez por zona y dia.
export async function notifyTvEvents(events) {
  const armed = (events || []).filter((e) => e.ev === 'armada');
  if (!armed.length) return { sent: [] };
  const subs = await listSubs();
  if (!subs.length) return { skipped: 'sin suscripciones' };
  const s = store();
  const sent = [];
  for (const e of armed) {
    const day = chicagoDay(e.t);
    for (const sub of subs) {
      const pr = sub.prefs || {};
      const syms = pr.syms && pr.syms.length ? pr.syms : ['NQ', 'ES', 'GC', 'ETH', 'BTC'];
      if (!syms.includes(fam(e.sym))) continue;
      if ((GRADE_RANK[e.grade] || 0) < (GRADE_RANK[pr.minGrade || 'A'] || 2)) continue;
      const key = `sent:${day}:${sub.key.slice(4)}:${e.sym}:${e.id}:armada`;
      if (await s.get(key).catch(() => null)) continue;
      const lang = pr.lang === 'en' ? 'en' : 'es';
      const side = e.side === 'long' ? (lang === 'en' ? 'LONG' : 'COMPRA') : (lang === 'en' ? 'SHORT' : 'VENTA');
      const f = fam(e.sym);
      const payload = {
        title: lang === 'en' ? `${f}: enter now · ${e.grade} ${side}` : `${f}: entra ahora · ${e.grade} ${side}`,
        body: (lang === 'en' ? `Entry ${px(e.entry)} · stop ${px(e.stop)} · target ${px(e.tp1)}` : `Entrada ${px(e.entry)} · stop ${px(e.stop)} · objetivo ${px(e.tp1)}`) +
          (e.size ? ` · ${e.size}` : '') + (e.conf ? (lang === 'en' ? `. Why: ` : `. Motivo: `) + e.conf : ''),
        tag: `${f}-${e.id}-armada`, url: '/#zonas', sym: f, zone: e.id
      };
      const r = await sendTo(sub, payload);
      if (r.ok) { await s.set(key, '1'); sent.push(`${e.sym} ${e.id}`); }
    }
  }
  return { sent };
}

export function testMessage(lang) {
  return lang === 'en'
    ? { title: 'Mi Mesa: alerts are on', body: 'You will get a notice when price gets close to or reaches an A or A+ zone.', tag: 'test', url: '/#zonas' }
    : { title: 'Mi Mesa: alertas activadas', body: 'Te avisaré cuando el precio se acerque o llegue a una zona A o A+.', tag: 'test', url: '/#zonas' };
}
