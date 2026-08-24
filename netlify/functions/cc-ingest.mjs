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
    ver: kv.ver || null,
    date: kv.date || null,
    dayType: kv.daytype || null,
    biasDir: kv.bias || null,
    weeklyDir: kv.weekly || null,
    price: num(kv.price),
    levels: {
      vah: num(kv.vah), poc: num(kv.poc), val: num(kv.val),
      vwap: num(kv.vwap), pdh: num(kv.pdh), pdl: num(kv.pdl),
      dayOpen: num(kv.dayopen), orH: num(kv.orh), orL: num(kv.orl),
      pwh: num(kv.pwh), pwl: num(kv.pwl), tdo: num(kv.tdo),
      ema5: num(kv.ema20), ema15: num(kv.ema20_15), ema50: num(kv.ema50)
    },
    noTradeZone: (num(kv.ntz1)!=null && num(kv.ntz2)!=null) ? [num(kv.ntz1), num(kv.ntz2)] : null,
    // contexto extra + senal en vivo
    signal: kv.signal || null,      // REVERSAL_IFVG | REVERSAL | A_FAVOR_BORDE | NOTRADE | ESPERA
    edge: kv.edge || null,          // VAH | VAL | POC | none
    struct: kv.struct || null,      // "BOS up" / "CHoCH dn" / none
    regime: kv.regime || null,      // Rango | Tendencia | Transición
    vol: kv.vol || null,            // Expansión | Avanzado | Agotado
    htf1: kv.htf1 || null,
    htf2: kv.htf2 || null,
    rs: kv.rs || null,
    inNtz: kv.inntz === '1',
    updatedAt: new Date().toISOString()
  };

  const store = getStore('cc');
  await store.setJSON('latest', plan);
  return new Response('ok · ' + (plan.date||'') + ' · ' + (plan.biasDir||''), { status: 200 });
};
