// Recibe los webhooks de los indicadores STATE EXPORT del Session Analyst:
//   R3R1| (3reads) · DRB1| (dr bias) · SRZ1| (sr zones) · HCZ1| (htf context zones)
// Valida el secreto, parsea la cadena k=v y guarda el ultimo estado por
// fuente+simbolo en Netlify Blobs (store 'cc', key 'ind:<src>:<SYM>').
// El backbone orb_sesgo (TDL1) sigue entrando por cc-ingest como 'sym:<SYM>'.
import { getStore } from '@netlify/blobs';

const PREFIX_SRC = {
  R3R1: '3reads', DRB1: 'drbias', SRZ1: 'srzones', HCZ1: 'htfzones', TDL1: 'orb'
};

function parsePipe(text){
  if(!text) return null;
  const parts = String(text).trim().split('|');
  if(parts.length < 2) return null;
  const kv = {};
  for(let i=1;i<parts.length;i++){
    const idx = parts[i].indexOf('=');
    if(idx > 0){ kv[parts[i].slice(0,idx).trim()] = parts[i].slice(idx+1).trim(); }
  }
  return { prefix: parts[0].trim(), kv };
}

export default async (req) => {
  if(req.method !== 'POST') return new Response('POST only', { status: 405 });

  const secret = process.env.CC_INGEST_SECRET;
  const key = new URL(req.url).searchParams.get('key');
  if(!secret || key !== secret) return new Response('unauthorized', { status: 401 });

  const body = await req.text();
  const parsed = parsePipe(body);
  if(!parsed) return new Response('bad payload (esperaba <PREFIJO>|k=v|...)', { status: 400 });

  const { prefix, kv } = parsed;
  const src = (kv.src || PREFIX_SRC[prefix] || prefix || 'unknown').toLowerCase();
  const sym = (kv.sym || 'NQ').toUpperCase();

  const record = {
    src,
    sym,
    prefix,
    ver: kv.ver || null,
    ts: kv.ts || null,          // timestamp CT que estampa el indicador
    raw: kv,                    // todos los campos tal cual; el agente los interpreta
    receivedAt: new Date().toISOString()
  };

  const store = getStore('cc');
  await store.setJSON(`ind:${src}:${sym}`, record);
  return new Response(`ok · ${src} · ${sym} · ${kv.ts || ''}`, { status: 200 });
};
