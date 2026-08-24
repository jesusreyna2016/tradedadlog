// Calendario economico para el Command Center.
// Baja el feed semanal de ForexFactory (JSON publico), lo normaliza a alto impacto,
// lo cachea en Netlify Blobs (~30 min) y lo sirve al Center. Sin claves.
import { getStore } from '@netlify/blobs';

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const TTL_MS = 30 * 60 * 1000;   // refresca como mucho cada 30 min

function normalize(raw){
  if(!Array.isArray(raw)) return [];
  const out = [];
  for(const e of raw){
    const impact = String(e.impact || '').toLowerCase();   // high | medium | low | holiday
    const cur = String(e.country || e.currency || '').toUpperCase();
    // nos quedamos con lo que mueve al NQ: alto impacto (cualquiera) + medio USD
    const keep = impact === 'high' || (impact === 'medium' && cur === 'USD');
    if(!keep) continue;
    const ts = e.date ? new Date(e.date).getTime() : null;
    if(!ts || !isFinite(ts)) continue;
    out.push({
      title: e.title || '',
      currency: cur,
      impact: impact === 'high' ? 'high' : 'medium',
      ts,
      forecast: (e.forecast === '' ? null : e.forecast) ?? null,
      previous: (e.previous === '' ? null : e.previous) ?? null
    });
  }
  out.sort((a,b)=> a.ts - b.ts);
  return out.slice(0, 60);
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
  try {
    const events = await fetchFF();
    const payload = { fetchedAt: Date.now(), source: 'forexfactory', events };
    if(store){ try { await store.setJSON('news', payload); } catch(e){} }
    return new Response(JSON.stringify(payload), { headers: cors });
  } catch(err){
    // 3) si el feed falla, devuelve lo ultimo que haya (aunque este viejo)
    if(cached) return new Response(JSON.stringify({ ...cached, stale: true }), { headers: cors });
    return new Response(JSON.stringify({ fetchedAt: Date.now(), source: 'forexfactory', events: [], error: String(err && err.message || err) }), { headers: cors });
  }
};
