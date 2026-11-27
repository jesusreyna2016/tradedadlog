// Archivo de velas de TradingView para el Lab de Trader OS (laboratorio de estrategias).
// Cada mensaje FEED1 (TDL Feed, una vela de 5m cerrada) se guarda como una fila
// compacta: la vela (o/h/l/c/vol desde FEED1 v1 + o/h/l/vol del 2026-11-27) y el
// contexto que el propio indicador midio en esa vela (VWAP, EMAs, niveles de sesion,
// chop, estiramiento...). Sin Yahoo: solo data de los indicadores propios.
//
//   tos-ingest       -> blob  tvbar:<YYYY-MM-DD UTC>:<SYM>   (array de filas, dedup por t)
//   tos-bus-snapshot -> repo  trader-os-bus/tvbars/<YYYY-MM-DD>.json  { fields, symbols }
//
// t = apertura de la vela en ms (FEED1 manda time_close; se resta el tf).

export const TVBAR_FIELDS = [
  't', 'o', 'h', 'l', 'c', 'vol', 'vwap', 'vwapUp', 'vwapDn', 'ema20', 'ema50', 'ema200', 'ema20h', 'ema50h',
  'pdh', 'pdl', 'pdc', 'do', 'tdo', 'onh', 'onl', 'ibh', 'ibl', 'asH', 'asL', 'loH', 'loL',
  'vah', 'poc', 'val', 'hod', 'lod', 'atr5', 'atrD', 'chopIdx', 'stretchAtr', 'dPos', 'vix',
  'emRegime', 'smt', 'ibBrk'
];
const TEXT = new Set(['emRegime', 'smt', 'ibBrk']);
export const TVBAR_MAX = 400;   // por simbolo y dia UTC (288 velas de 5m + margen)

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const x = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(x) ? x : null;
};

// kv = campos crudos del pipe FEED1. Devuelve { day, row } o null.
export function feedToRow(kv) {
  const tClose = num(kv.t);
  if (!tClose) return null;
  const tfMin = num(kv.tf) || 5;
  const t = tClose - tfMin * 60000;
  const row = TVBAR_FIELDS.map((f) => {
    if (f === 't') return t;
    if (f === 'c') return num(kv.close);
    if (TEXT.has(f)) return kv[f] ? String(kv[f]) : null;
    return num(kv[f]);
  });
  return { day: new Date(t).toISOString().slice(0, 10), row };
}

export function mergeRows(prev, add) {
  const m = new Map((prev || []).map((r) => [r[0], r]));
  for (const r of add || []) m.set(r[0], r);
  return [...m.values()].sort((a, b) => a[0] - b[0]);
}
