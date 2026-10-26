// Rendering. Every visible string goes through T() so the EN/ES toggle re-renders cleanly.
import { T, L } from './i18n.js';
import { store, SYMS, symName, ctParts, tickOf } from './api.js';
import { fmt, levelList, NEAR_TICKS } from './decision.js';
import * as gate from './gate.js';

const $ = id => document.getElementById(id);
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TONE_VAR = { pos: 'var(--pos)', neg: 'var(--neg)', wait: 'var(--wait)', muted: 'var(--muted)', calm: 'var(--calm)' };
const money = n => (n == null ? '-' : (n < 0 ? '-' : '+') + '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));
const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? T('hace segundos', 'seconds ago') : m < 60 ? T('hace ' + m + ' min', m + ' min ago') : T('hace ' + Math.round(m / 60) + ' h', Math.round(m / 60) + 'h ago'); };

/* ---------- top bar ---------- */
export function renderSymBar(cur) {
  $('symBar').innerHTML = SYMS.map(([k, n]) => `<button type="button" data-sym="${k}" aria-pressed="${k === cur}">${n}</button>`).join('');
}

const SESS = [
  { k: 'asia', es: 'ASIA', en: 'ASIA', from: 17 * 60, to: 2 * 60 },
  { k: 'lon', es: 'LONDRES', en: 'LONDON', from: 2 * 60, to: 8 * 60 + 30 },
  { k: 'ny', es: 'NUEVA YORK', en: 'NEW YORK', from: 8 * 60 + 30, to: 15 * 60 },
];
const inWin = (m, a, b) => (a < b ? m >= a && m < b : m >= a || m < b);
export function renderClock() {
  const now = new Date();
  const { h, m, s } = ctParts(now);
  $('clock').textContent = [h, m, s].map(x => String(x).padStart(2, '0')).join(':');
  $('clockDate').textContent = new Intl.DateTimeFormat(T('es-MX', 'en-US'), { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' }).format(now) + T(' · hora Chicago', ' · Chicago time');
  const min = h * 60 + m;
  const open = SESS.find(x => inWin(min, x.from, x.to));
  const next = SESS.map(x => ({ x, wait: (x.from - min + 1440) % 1440 })).filter(o => o.x !== open).sort((a, b) => a.wait - b.wait)[0];
  $('sessions').innerHTML = SESS.map(x => {
    const nm = T(x.es, x.en);
    if (x === open) return `<span class="sess on">${nm} · ${T('ABIERTA', 'OPEN NOW')}</span>`;
    if (next && x === next.x) return `<span class="sess">${nm} ${T('EN', 'IN')} ${Math.floor(next.wait / 60)}H ${next.wait % 60}M</span>`;
    return `<span class="sess">${nm}</span>`;
  }).join('');
}

export function renderLive(sym) {
  const p = store.plan[sym];
  const ts = Math.max(store.at.plan || 0, store.at.regime || 0, store.at.trend || 0);
  const dot = document.querySelector('.live-dot');
  if (!ts) { $('liveAge').textContent = T('Conectando', 'Connecting'); dot.className = 'live-dot off'; return; }
  const feedAge = p && p.updatedAt ? (Date.now() - Date.parse(p.updatedAt)) / 60000 : Infinity;
  dot.className = 'live-dot' + (feedAge > 30 ? ' stale' : '');
  $('liveAge').textContent = p && p.updatedAt
    ? T('Indicador ', 'Indicator ') + ago(Date.parse(p.updatedAt))
    : T('En vivo · actualizado ', 'Live · updated ') + ago(ts);
}

/* ---------- decision card ---------- */
export function renderDecision(d) {
  const card = $('decision');
  card.style.setProperty('--tone', TONE_VAR[d.tone]);
  card.classList.toggle('dimmed', d.gate.kind === 'pause');
  $('decEyebrow').textContent = T('// ¿PUEDO OPERAR ' + d.name + ' AHORA?', '// CAN I TRADE ' + d.name + ' RIGHT NOW?');
  $('decVerdict').textContent = d.verdict;
  $('decWhy').textContent = d.why;
  $('agreeN').textContent = d.agree + ' / 4';
  [...$('agreeBar').children].forEach((el, i) => el.classList.toggle('on', i < d.agree));
  $('agreeSub').textContent = d.agreeSub;
  const dirEl = $('decDir');
  dirEl.textContent = d.dirWord;
  dirEl.className = 'box-v mono ' + (d.dir > 0 ? 't-pos' : d.dir < 0 ? 't-neg' : 't-muted');
  $('decDirSub').textContent = d.dirSub;
  $('decWhere').textContent = d.where;
  $('decWhereSub').textContent = d.whereSub;
  $('decTrigger').textContent = d.trigger;
  $('decInputs').innerHTML = d.inputs.map(i => `
    <div class="inp"><span class="dot ${i.tone}" aria-hidden="true"></span><div>
      <div class="inp-k">${esc(i.k)}<small>${esc(i.src)}</small></div>
      <div class="inp-v t-${i.tone}">${esc(i.v)}</div>
      <div class="inp-s">${esc(i.s)}</div></div></div>`).join('');

  const k = d.gate.kind;
  let acts = '';
  if (k === 'open') acts = `<button type="button" class="btn primary" data-act="enter">${T('Voy a tomar un trade', "I'm taking a trade")}</button>
      <span class="hint">${T('Abre un chequeo rápido de 4 preguntas. Si el trade va contra esta respuesta, tendrás que escribir una frase para confirmar.', "Opens a quick 4-question check. If the trade goes against this answer, you'll have to type a phrase to confirm.")}</span>`;
  else if (k === 'inTrade') acts = `<button type="button" class="btn primary" data-act="exit-win">${T('Cerré ganando', 'I closed a winner')}</button>
      <button type="button" class="btn" data-act="exit-loss">${T('Cerré perdiendo', 'I closed a loser')}</button>
      <button type="button" class="btn" data-act="cancel-trade">${T('No entré al final', "I didn't get filled")}</button>`;
  else if (k === 'ritual') acts = `<button type="button" class="btn primary" data-act="ritual">${T('Hacer mi rutina', 'Do my routine')}</button>`;
  else if (k === 'cap') acts = `<span class="hint">${T('Mañana el contador vuelve a cero.', 'Tomorrow the counter goes back to zero.')}</span>`;
  $('decActions').innerHTML = acts;
}

/* ---------- pause card (right after an exit) ---------- */
export function renderPause() {
  const p = gate.pause();
  const el = $('pauseCard');
  document.body.classList.toggle('pausing', !!p);
  if (!p) { el.hidden = true; el.innerHTML = ''; return; }
  const left = gate.pauseLeftMs();
  const net = gate.dayNet();
  const s = gate.day();
  const side = p.dir === 'LONG' ? T('largo', 'long') : p.dir === 'SHORT' ? T('corto', 'short') : T('trade', 'trade');
  const nm = symName(p.sym);
  const win = p.result === 'win';
  const lead = win
    ? T('Buen trade. Cerraste tu ' + side + ' de <b>' + nm + '</b>' + (p.pnl != null ? ' con <b class="t-pos">' + money(p.pnl) + '</b>' : '') + '.', 'Nice trade. You closed your <b>' + nm + ' ' + side + '</b>' + (p.pnl != null ? ' and made <b class="t-pos">' + money(p.pnl) + '</b>' : '') + '.')
    : T('Cerraste tu ' + side + ' de <b>' + nm + '</b>' + (p.pnl != null ? ' en <b class="t-neg">' + money(p.pnl) + '</b>' : '') + '. Una pérdida es parte del juego si seguiste tu plan.', 'You closed your <b>' + nm + ' ' + side + '</b>' + (p.pnl != null ? ' at <b class="t-neg">' + money(p.pnl) + '</b>' : '') + '. A loss is part of the game if you followed your plan.');
  const sub = win
    ? T('Justo después de una ganancia grande es cuando más fácil es volver a entrar por impulso. Párate, toma agua y regresa con un plan, no con una emoción.', "Right after a big win is when it's easiest to jump back in on impulse. Stand up, get some water, and come back with a plan, not a feeling.")
    : T('Ahora mismo tu cerebro quiere recuperarlo. No le hagas caso: párate, respira y regresa con un plan, no con ganas de desquitarte.', "Right now your brain wants it back. Don't listen: stand up, breathe, and come back with a plan, not a need to get even.");
  const keepNote = el.querySelector('#pauseNote');
  const hadFocus = keepNote && document.activeElement === keepNote;
  el.innerHTML = `
    <span class="corner c-tl"></span><span class="corner c-tr"></span><span class="corner c-bl"></span><span class="corner c-br"></span>
    <div class="col">
      <div class="eyebrow">${T('// RESPIRA UN MOMENTO', '// TAKE A BREATHER')}</div>
      <div class="timer-row"><div class="timer${left ? '' : ' done'}" id="pauseTimer">${clockStr(left)}</div>
        <div class="t-muted" id="pauseTimerSub">${left ? T('para poder operar otra vez', 'until you can trade again') : T('tiempo cumplido', 'time is up')}</div></div>
      <p class="pause-lead">${lead}</p>
      <p class="pause-sub">${sub}</p>
    </div>
    <div class="col">
      <label for="pauseNote">${T('¿Cuál es tu siguiente trade? Escríbelo primero.', "What's your next trade? Write it down first.")}</label>
      <div class="field-hint">${T('¿Dónde entrarías, hacia qué lado, y qué tiene que pasar antes?', 'Where would you enter, which way, and what has to happen first?')}</div>
      <textarea id="pauseNote" rows="4">${esc(p.note || '')}</textarea>
      <div class="stats2">
        <div class="stat"><div class="stat-k">${T('Trades hoy', 'Trades today')}</div><div class="stat-v">${s.used} ${T('de', 'of')} ${gate.MAX_TRADES}</div></div>
        <div class="stat"><div class="stat-k">${T('Hoy hasta ahora', 'Today so far')}</div><div class="stat-v ${net == null ? '' : net >= 0 ? 't-pos' : 't-neg'}">${net == null ? '-' : money(net)}</div></div>
      </div>
      <button type="button" class="btn wide" id="pauseDone" data-act="end-pause"></button>
    </div>`;
  el.hidden = false;
  if (hadFocus) { const n = $('pauseNote'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  tickPause();
}
const clockStr = ms => { const t = Math.ceil(ms / 1000); return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
export function tickPause() {
  const btn = $('pauseDone'); if (!btn) return;
  const left = gate.pauseLeftMs();
  const note = ($('pauseNote') && $('pauseNote').value.trim()) || '';
  const tEl = $('pauseTimer');
  tEl.textContent = clockStr(left); tEl.classList.toggle('done', !left);
  $('pauseTimerSub').textContent = left ? T('para poder operar otra vez', 'until you can trade again') : T('tiempo cumplido', 'time is up');
  const ready = !left && note.length >= 12;
  btn.disabled = !ready;
  btn.className = 'btn wide' + (ready ? ' primary' : '');
  btn.textContent = left ? T('Listo otra vez en ', 'Ready again in ') + clockStr(left)
    : note.length < 12 ? T('Escribe tu siguiente trade para desbloquear', 'Write your next trade to unlock')
    : T('Ya tengo mi plan, desbloquear', 'I have my plan, unlock');
}

/* ---------- levels ---------- */
export function renderLevels(d) {
  const sym = d.sym;
  $('lvTitle').textContent = T('// PRECIOS CLAVE · ', '// KEY PRICES · ') + d.name;
  $('lvPrice').textContent = d.price != null ? fmt(d.price, sym) : '';
  const list = levelList(sym, d.plan, d.trend);
  if (!list.length || d.price == null) { $('levels').innerHTML = `<div class="empty">${T('Esperando los niveles del indicador.', 'Waiting for the levels from the indicator.')}</div>`; $('lvFoot').textContent = ''; return; }
  const near = NEAR_TICKS * tickOf(sym);
  const rows = list.concat([{ k: 'price', name: T('Precio actual', 'Price now'), px: d.price }]).sort((a, b) => b.px - a.px);
  const z = d.zoneHit;
  $('levels').innerHTML = rows.map(l => {
    if (l.k === 'price') return `<div class="lv price"><span class="n">${esc(l.name)}</span><span class="mono">${fmt(l.px, sym)}</span><span class="d mono">0</span></div>`;
    const diff = l.px - d.price;
    const hot = Math.abs(diff) <= near || (z && l.px >= z.lo - near && l.px <= z.hi + near);
    return `<div class="lv${hot ? ' hot' : ''}"><span class="n">${esc(l.name)}</span><span class="mono">${fmt(l.px, sym)}</span><span class="d mono">${diff >= 0 ? '+' : ''}${fmt(diff, sym)}</span></div>`;
  }).join('');
  $('lvFoot').textContent = T('Suena un aviso cuando el precio queda a ' + NEAR_TICKS + ' ticks o menos de uno.', "You'll hear a beep when price gets within " + NEAR_TICKS + ' ticks of one.');
}

/* ---------- coach ---------- */
const VERB = { GO: ['Adelante', 'Go', 't-pos'], WAIT: ['Espera', 'Wait', 't-wait'], AVOID: ['Sáltalo', 'Skip', 't-neg'] };
export function renderCoach(sym) {
  const crypto = /USDT$/.test(sym);
  const plan = crypto ? store.saCrypto : store.sa;
  if (!plan || !plan.instruments) {
    $('coach').innerHTML = `<div class="coach-focus none">${crypto ? T('Hoy no hay plan cripto. El coach lo escribe los fines de semana.', 'No crypto plan today. The coach writes one on weekends.') : T('El coach todavía no publica el plan de hoy.', "The coach hasn't published today's plan yet.")}</div>`;
    return;
  }
  const f = plan.focus;
  let focus;
  if (f && f.sym) {
    const v = VERB[String(f.verdict || '').toUpperCase()] || VERB.WAIT;
    focus = `<div class="coach-focus${f.verdict === 'GO' ? '' : ' none'}"><b>${T('Mejor oportunidad hoy: ', 'Best chance today: ')}${esc(symName(f.sym))} · ${T(v[0], v[1])}.</b> ${esc(L(f.setup))}${f.window ? '<br><span class="t-muted">' + T('Ventana: ', 'Window: ') + esc(String(f.window).split(' (')[0]) + '</span>' : ''}</div>`;
  } else focus = `<div class="coach-focus none">${T('Hoy el coach no ve una oportunidad clara.', "Today the coach doesn't see a clear chance.")}</div>`;
  const rows = Object.keys(plan.instruments).map(k => {
    const ins = plan.instruments[k];
    const sig = String((ins.verdict && ins.verdict.signal) || 'WAIT').toUpperCase();
    const v = VERB[sig] || VERB.WAIT;
    const z = (ins.zones || []).filter(x => Array.isArray(x.range))[0];
    const dirW = z ? (z.dir === 'LONG' ? T('largo', 'long') : T('corto', 'short')) : '';
    const sub = sig === 'AVOID' ? (ins.frameConflict ? T('los marcos de tiempo no coinciden', 'timeframes disagree') : T('mejor no tocarlo', 'better not to touch it'))
      : z ? dirW + T(' en ', ' at ') + fmt(Math.min(...z.range), k) + T(' a ', ' to ') + fmt(Math.max(...z.range), k) : T('sin zona clara', 'no clear zone');
    return `<div class="coach-row${k === sym || k === symName(sym) ? ' cur' : ''}"><b>${esc(symName(k))}</b><span class="${v[2]} strong">${T(v[0], v[1])}</span><span>${esc(sub)}</span></div>`;
  }).join('');
  $('coach').innerHTML = focus + `<div class="coach-list">${rows}</div>`;
}

/* ---------- news ---------- */
export function renderNews() {
  const ev = (store.news || []).filter(e => e.ts > Date.now() - 15 * 60000 && (e.impact === 'high' || (e.impact === 'medium' && e.currency === 'USD'))).slice(0, 4);
  const fmtT = ts => new Intl.DateTimeFormat(T('es-MX', 'en-US'), { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: false }).format(new Date(ts));
  $('news').innerHTML = !store.news ? `<div class="empty">${T('Cargando calendario...', 'Loading calendar...')}</div>`
    : ev.length ? ev.map(e => `<div class="nrow"><span class="when">${fmtT(e.ts)}</span><span class="strong ${e.impact === 'high' ? 't-neg' : 't-wait'}">${e.impact === 'high' ? T('Fuerte', 'Big') : T('Media', 'Medium')}</span><span>${esc(e.currency)} · ${esc(e.title)}</span></div>`).join('')
    : `<div class="empty">${T('Nada importante en el calendario.', 'Nothing important on the calendar.')}</div>`;
  const usdToday = (store.news || []).some(e => e.impact === 'high' && e.currency === 'USD' && e.ts > Date.now() && e.ts - Date.now() < 24 * 3600000);
  $('newsFoot').textContent = (usdToday ? T('Hay noticia fuerte de EE.UU. en las próximas 24 h. ', 'Big US news in the next 24h. ') : T('Nada fuerte para EE.UU. en las próximas 24 h. ', 'Nothing big for US markets in the next 24h. '))
    + T('Si falta 15 min o menos para una noticia fuerte, la respuesta de arriba cambia sola a "Manos fuera".', 'When big news is 15 minutes away or less, the answer above changes to "Hands off" by itself.');
  const nl = (store.news || []).find(e => e.impact === 'high' && e.currency === 'USD' && e.ts > Date.now() && e.ts - Date.now() <= 30 * 60000);
  const na = $('newsAlert');
  na.hidden = !nl;
  if (nl) na.innerHTML = `<b>${T('Noticia fuerte en ', 'Big news in ')}${Math.max(1, Math.round((nl.ts - Date.now()) / 60000))} min:</b> ${esc(nl.title)}. ${T('Si estás dentro, protege tu trade.', "If you're in a trade, protect it.")}`;
}

/* ---------- details (collapsed) ---------- */
const CHEV = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2l4 4-4 4"/></svg>';
const DAYTYPE = { 'Día de tendencia': ['Día de tendencia', 'Trend day'], 'Aceptación al alza': ['Aceptando precios más altos', 'Accepting higher prices'],
  'Aceptación a la baja': ['Aceptando precios más bajos', 'Accepting lower prices'], 'Balance': ['Día de balance, de lado', 'Balanced, sideways day'] };
const dayType = s => { const p = DAYTYPE[s]; return p ? T(p[0], p[1]) : s || '-'; };

export function renderDetails(sym, d) {
  const box = $('detailList');
  const items = [
    ['proof', T('¿Esta tarjeta funciona?', 'Does this card actually work?'), proofSummary(sym), () => proofBody(sym)],
    ['plan', T('Plan de juego de hoy', "Today's game plan"), planSummary(d), () => planBody(d)],
    ['scan', T('Qué mercado está más fuerte', 'Which market is strongest'), scanSummary(), () => scanBody(sym)],
    ['weekly', T('Revisión semanal del coach', 'Weekly review from the coach'), T('cada sábado', 'every Saturday'), weeklyBody],
    ['health', T('¿Todo está conectado?', 'Is everything connected?'), healthSummary(), healthBody],
    ['days', T('Últimos 30 días + trades de hoy', "Last 30 days + today's trades"), T('racha: ', 'streak: ') + gate.streak() + T(' días', ' days'), daysBody],
    ['csv', T('Tus resultados desde un CSV', 'Your results from a CSV'), T('se usa poco', 'used less'), csvBody],
    ['why', T('Por qué haces esto', 'Why you do this'), whySummary(), whyBody],
  ];
  if (!box.children.length) box.innerHTML = items.map(([id]) => `<details class="det glass" id="det-${id}"><summary>${CHEV}<span class="det-t"></span><span class="det-s"></span></summary><div class="det-b"></div></details>`).join('');
  items.forEach(([id, t, s, body]) => {
    const el = $('det-' + id);
    el.querySelector('.det-t').textContent = t;
    el.querySelector('.det-s').textContent = s;
    if (el.open || !el.dataset.filled) { el.querySelector('.det-b').innerHTML = body(); el.dataset.filled = '1'; }
  });
}

const PROOF_MIN = 20;   // graded answers before the numbers mean anything
const CODE_NAMES = { go: ['"Adelante"', '"Go"'], wait: ['"Espera, solo un lado"', '"Wait, one side only"'], unclear: ['"Quédate fuera"', '"Sit out"'],
  inair: ['"Nada cerca"', '"Nothing nearby"'], avoid: ['"Sáltalo"', '"Skip it"'], news: ['"Noticia fuerte"', '"Big news"'] };
function proofStats(sym) { const s = store.decisions && store.decisions.symbols && store.decisions.symbols[sym]; return s || null; }
function proofSummary(sym) {
  const s = proofStats(sym); if (!s) return T('juntando datos', 'collecting data');
  return s.graded < PROOF_MIN ? T(s.graded + ' de ' + PROOF_MIN + ' respuestas calificadas', s.graded + ' of ' + PROOF_MIN + ' answers graded') : T(s.graded + ' respuestas calificadas', s.graded + ' answers graded');
}
function proofBody(sym) {
  const s = proofStats(sym);
  const intro = T('Cada 15 minutos el servidor guarda lo que dice esta tarjeta y el precio. Una hora después revisa si el precio se movió hacia donde dijo. Así sabes si confiar en ella, con números y no con sensaciones.',
    'Every 15 minutes the server saves what this card says and the price. One hour later it checks whether price moved the way it said. That way you know whether to trust it, with numbers instead of feelings.');
  if (!s || !s.graded) return intro + '<br><br>' + T('Todavía no hay respuestas calificadas. Vuelve en unos días.', 'No graded answers yet. Check back in a few days.');
  const rows = Object.keys(s.stats).sort((a, b) => s.stats[b].n - s.stats[a].n).map(k => {
    const x = s.stats[k]; const nm = CODE_NAMES[k] ? T(CODE_NAMES[k][0], CODE_NAMES[k][1]) : k;
    const res = x.rightPct != null
      ? T('acertó la dirección ', 'right direction ') + '<b>' + x.rightPct + '%</b>' + T(' de las veces, promedio ', ' of the time, average ') + '<b>' + (x.avgPts >= 0 ? '+' : '') + x.avgPts + ' pts</b>'
      : T('sin dirección; el precio se movió en promedio ', 'no direction; price moved on average ') + '<b>' + x.avgAbsPts + ' pts</b>' + T(' en una hora', ' in an hour');
    return `<div style="padding:6px 0;border-top:1px solid var(--hair)"><b>${nm}</b> · ${x.n} ${T('veces', 'times')} · ${res}</div>`;
  }).join('');
  const warn = s.graded < PROOF_MIN ? `<div class="warnbox">${T('Muy pocos datos todavía (' + s.graded + ' de ' + PROOF_MIN + '). No saques conclusiones aún.', 'Too little data so far (' + s.graded + ' of ' + PROOF_MIN + '). Don\'t draw conclusions yet.')}</div>` : '';
  return intro + warn + `<div style="margin-top:10px">${rows}</div><div class="panel-foot">${T('Últimos 14 días. Lo que importa: que "Adelante" acierte claramente más que "Espera", y que en "Quédate fuera" el precio se mueva poco.', 'Last 14 days. What matters: "Go" should be right clearly more often than "Wait", and during "Sit out" price should move little.')}</div>`;
}

function planSummary(d) {
  const p = d.plan; if (!p) return T('sin plan del indicador', 'no plan from the indicator');
  const z = p.noTradeZone;
  return dayType(p.dayType) + (z && z[0] != null ? T(' · fuera de ', ' · stay out of ') + fmt(Math.min(...z), d.sym) + T(' a ', ' to ') + fmt(Math.max(...z), d.sym) : '');
}
function planBody(d) {
  const p = d.plan; if (!p) return T('El indicador de este símbolo no ha mandado su plan hoy.', "This symbol's indicator hasn't sent today's plan.");
  const Lv = p.levels || {}, z = p.noTradeZone, s = d.sym;
  const stat = (k, v) => `<div class="stat"><div class="stat-k">${k}</div><div class="stat-v" style="font-size:14px">${v}</div></div>`;
  return `<div class="kv">
    ${stat(T('Tipo de día', 'Kind of day'), esc(dayType(p.dayType)))}
    ${stat(T('Zona para no operar', 'Zone to stay out of'), z && z[0] != null ? fmt(Math.min(...z), s) + T(' a ', ' to ') + fmt(Math.max(...z), s) : '-')}
    ${stat(T('Área de valor', 'Value area'), Lv.val != null ? fmt(Lv.val, s) + T(' a ', ' to ') + fmt(Lv.vah, s) : '-')}
    ${stat(T('Volatilidad', 'Volatility'), esc(p.vol || '-'))}</div>
    <b>${T('Un buen largo:', 'A good long:')}</b> ${T('rebote en la parte baja del valor (' + fmt(Lv.val, s) + ') o recuperar el VWAP (' + fmt(Lv.vwap, s) + '), con tu gatillo. Nunca en el aire.', 'a bounce at the value area low (' + fmt(Lv.val, s) + ') or taking back VWAP (' + fmt(Lv.vwap, s) + '), with your trigger. Never in the air.')}<br>
    <b>${T('Un buen corto:', 'A good short:')}</b> ${T('rechazo en la parte alta del valor (' + fmt(Lv.vah, s) + ') o perder el VWAP, con tu gatillo. Objetivo: el precio más negociado (' + fmt(Lv.poc, s) + ').', 'a rejection at the value area high (' + fmt(Lv.vah, s) + ') or losing VWAP, with your trigger. Target: the most traded price (' + fmt(Lv.poc, s) + ').')}`;
}

function scanRows() {
  const syms = store.scan || {};
  const sg = x => (/alcista|LONG|up/i.test(x || '') ? 1 : /bajista|SHORT|down/i.test(x || '') ? -1 : 0);
  return Object.keys(syms).map(k => {
    const p = syms[k]; const dir = sg(p.biasDir);
    const score = [p.weeklyDir, p.htf1, p.htf2].filter(x => dir && sg(x) === dir).length + (/lidera|lead/i.test(p.rs || '') ? 1 : 0);
    return { k, dir, score, act: ['A_FAVOR_BORDE', 'REVERSAL', 'REVERSAL_IFVG'].includes(p.signal) };
  }).sort((a, b) => (b.act - a.act) || (b.score - a.score));
}
function scanSummary() {
  const r = scanRows(); if (!r.length) return T('esperando datos', 'waiting for data');
  return symName(r[0].k) + T(' es el más claro', ' is the clearest');
}
function scanBody(cur) {
  const r = scanRows(); if (!r.length) return T('Sin datos de los otros mercados todavía.', 'No data from the other markets yet.');
  const can = new Set(SYMS.map(x => x[0]));
  return r.map((x, i) => `<div class="scanrow${i === 0 ? ' best' : ''}"><b class="mono">${esc(symName(x.k))}</b>
    <span class="${x.dir > 0 ? 't-pos' : x.dir < 0 ? 't-neg' : 't-muted'}">${x.dir > 0 ? T('arriba', 'up') : x.dir < 0 ? T('abajo', 'down') : T('sin lado', 'no side')}</span>
    <span>${'●'.repeat(x.score)}${'○'.repeat(4 - x.score)} ${x.act ? T('· en un nivel ahora', '· at a level now') : ''}</span>
    ${can.has(x.k) && x.k !== cur ? `<button type="button" class="btn" data-sym-pick="${x.k}" style="min-height:32px;padding:4px 10px">${T('Ver', 'View')}</button>` : '<span></span>'}</div>`).join('')
    + `<div class="panel-foot">${T('Los puntos cuentan cuántos marcos de tiempo coinciden con su dirección. Toca "Ver" para cambiar toda la pantalla a ese mercado.', 'The dots count how many timeframes agree with its direction. Tap "View" to switch the whole screen to that market.')}</div>`;
}

function weeklyBody() {
  if (!store.weekly) return T('Todavía no hay revisión semanal.', 'No weekly review yet.');
  return '<div class="md">' + esc(store.weekly).replace(/^\s*#{1,6}\s*(.+?)\s*$/gm, '<h3>$1</h3>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') + '</div>';
}

function healthSummary() {
  const h = store.health;
  if (!h) return T('revisando', 'checking');
  return h.status === 'ok' ? T('todo funcionando', 'all feeds working') : T('hay algo caído', 'something is down');
}
function healthBody() {
  const rows = [];
  const at = (k, name) => rows.push([name, store.at[k] ? ago(store.at[k]) : T('sin respuesta', 'no answer'), !!store.at[k]]);
  at('plan', T('Indicador del símbolo (TradingView)', 'Symbol indicator (TradingView)'));
  at('regime', 'Market Regime'); at('trend', 'Trend Checklist'); at('news', T('Calendario de noticias', 'News calendar')); at('sa', T('Coach IA', 'AI coach'));
  const h = store.health;
  if (h && h.sa) rows.push([T('Última corrida del coach', 'Coach last run'), (h.sa.runType || '') + ' · ' + (h.sa.lastRun ? ago(Date.parse(h.sa.lastRun)) : '-'), !h.sa.lateBy || h.sa.lateBy < 60]);
  if (h && h.webhook) rows.push([T('Alertas de TradingView', 'TradingView alerts'), T('última hace ', 'last ') + h.webhook.lastSeenMin + ' min' + T('', ' ago'), h.webhook.state === 'ok']);
  return '<div class="health">' + rows.map(r => `<div class="hrow"><span class="dot ${r[2] ? 'pos' : 'wait'}" aria-hidden="true" style="margin:0"></span><span style="flex:1">${esc(r[0])}</span><span class="t-muted">${esc(r[1])}</span></div>`).join('') + '</div>';
}

function daysBody() {
  const h = gate.history(); const cells = [];
  for (let i = 29; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000);
    const k = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    const v = h[k]; cells.push(`<i class="${v ? (v.clean === false ? 'bad' : 'ok') : ''}" title="${k}"></i>`);
  }
  const tr = gate.day().trades;
  const list = tr.length ? tr.slice().reverse().map(t => `<div>${t.t} · ${esc(symName(t.sym || 'NQ'))} ${t.dir ? (t.dir === 'LONG' ? T('largo', 'long') : T('corto', 'short')) : ''} · <b class="${t.r === 'win' ? 't-pos' : 't-neg'}">${t.r === 'win' ? T('ganado', 'win') : T('perdido', 'loss')}</b>${t.pnl != null ? ' ' + money(t.pnl) : ''}${t.against ? ' · <span class="t-wait">' + T('contra la respuesta', 'against the answer') + '</span>' : ''}</div>`).join('')
    : T('Sin trades hoy.', 'No trades today.');
  return `<div class="heat">${cells.join('')}</div><div class="t-muted" style="margin-bottom:10px">${T('Verde: seguiste el plan. Rojo: lo rompiste. Gris: no operaste.', 'Green: you followed the plan. Red: you broke it. Grey: no trades.')}</div>${list}`;
}

function csvBody() {
  return T('Subir tu archivo de Tradovate o Vest para ver tus resultados reales sigue en la <a href="command-center.html">vista clásica</a> por ahora.',
    'Uploading your Tradovate or Vest file to see your real results still lives in the <a href="command-center.html">classic view</a> for now.');
}

const ROUTINE = [['sueno', 'Dormí bien, mente descansada', 'Slept well, mind rested'], ['ejercicio', 'Hice ejercicio o me moví', 'Got some exercise or movement'],
  ['familia', 'Tiempo con la familia, sin pantallas', 'Family time, no screens'], ['cierre', 'Cerré la plataforma fuera de sesión', 'Closed the platform outside of session']];
function whySummary() { const n = gate.northStar(); return n && n.who ? n.who : 'Liam · Dylan'; }
function whyBody() {
  const n = gate.northStar() || {};
  const why = n.why || T('Mi mayor enemigo soy yo mismo. Opero por mi familia y por salir de deudas, no por la adrenalina.', 'My biggest enemy is myself. I trade for my family and to get out of debt, not for the adrenaline.');
  const total = +n.total, paid = +n.paid;
  const debt = isFinite(total) && total > 0 && isFinite(paid)
    ? `<div style="margin:8px 0 12px">${T('Camino para salir de deudas: ', 'Path out of debt: ')}<b>$${paid.toLocaleString('en-US')}</b> ${T('de', 'of')} $${total.toLocaleString('en-US')} (${Math.round(paid / total * 100)}%)</div>` : '';
  const r = gate.routine(); const done = r && r.date === gate.day().date ? r : {};
  return `<p style="margin:0;font-style:italic;color:var(--ink)">"${esc(why)}"</p>${debt}
    <ul class="checks">${ROUTINE.map(([k, es, en]) => `<li><label><input type="checkbox" data-routine="${k}"${done[k] ? ' checked' : ''}>${T(es, en)}</label></li>`).join('')}</ul>`;
}

/* ---------- toast ---------- */
let toastT = 0;
export function toast(html) {
  const t = $('toast'); t.innerHTML = html; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 6000);
}
