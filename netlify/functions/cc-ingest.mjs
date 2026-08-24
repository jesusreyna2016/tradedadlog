// Recibe el webhook de TradingView (alerta "Any alert()") con la cadena TDL1,
// la valida con un secreto, la parsea y guarda el ultimo plan en Netlify Blobs.
import { getStore } from '@netlify/blobs';

function parseTDL(text){
  if(!text) return null;
  const parts = String(text).trim().split('|');
  if(!parts.length || parts[0].indexOf('TDL') !== 0) return null;
  const kv = {};
  for(let i=1;i<parts.length;i++){
    const idx = parts[i].indexOf('=');
    if(idx > 0){ kv[parts[i].slice(0,idx).trim()] = parts[i].slice(idx+1).trim(); }
  }
  return kv;
}
function num(v){
  if(v==null || v==='' || v==='NaN') return null;
  const x = parseFloat(v);
  return isFinite(x) ? x : null;
}

export default async (req) => {
  if(req.method !== 'POST') return new Response('POST only', { status: 405 });

  const secret = process.env.CC_INGEST_SECRET;
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if(!secret || key !== secret) return new Response('unauthorized', { status: 401 });

  const body = await req.text();
  const kv = parseTDL(body);
  if(!kv) return new Response('bad payload (esperaba cadena TDL1|...)', { status: 400 });

  const plan = {
    date: kv.date || null,
    dayType: kv.daytype || null,
    biasDir: kv.bias || null,
    weeklyDir: kv.weekly || null,
    price: num(kv.price),
    levels: {
      vah: num(kv.vah), poc: num(kv.poc), val: num(kv.val),
      vwap: num(kv.vwap), pdh: num(kv.pdh), pdl: num(kv.pdl)
    },
    noTradeZone: (num(kv.ntz1)!=null && num(kv.ntz2)!=null) ? [num(kv.ntz1), num(kv.ntz2)] : null,
    updatedAt: new Date().toISOString()
  };

  const store = getStore('cc');
  await store.setJSON('latest', plan);
  return new Response('ok · ' + (plan.date||'') + ' · ' + (plan.biasDir||''), { status: 200 });
};
