// Language: English by default, Spanish on toggle. Shares the cc_lang key with the classic Command Center.

let lang = 'en';
try { lang = localStorage.getItem('cc_lang') === 'es' ? 'es' : 'en'; } catch (e) {}

export const getLang = () => lang;

// inline pair for dynamic text: T('texto', 'text')
export const T = (es, en) => (lang === 'es' ? es : en);

// static labels marked with data-i18n / data-i18n-aria in the HTML
const STATIC = {
  connecting: ['Conectando', 'Connecting'],
  market: ['Mercado', 'Market'],
  classic: ['Vista clásica', 'Classic view'],
  sound: ['Sonido', 'Sound'],
  agreeLabel: ['Cuántas señales coinciden', 'How many signals agree'],
  whichWay: ['Hacia dónde', 'Which way'],
  whereLook: ['Dónde buscarlo', 'Where to look for it'],
  firstHappen: ['Qué tiene que pasar primero', 'What has to happen first'],
  whyAnswer: ['// POR QUÉ ESTA RESPUESTA', '// WHY THIS ANSWER'],
  lvSub: ['Qué tan lejos está cada uno del precio actual', 'How far each one is from the current price'],
  coachTitle: ['// EL COACH IA HOY', '// THE AI COACH TODAY'],
  newsTitle: ['// NOTICIAS QUE VIENEN', '// NEWS COMING UP'],
  moreTitle: ['// MÁS DETALLE · ÁBRELO CUANDO LO NECESITES', '// MORE DETAIL · OPEN WHEN YOU NEED IT'],
  foot: ['TRADEDADLOG · COMMAND CENTER v2 · EL PLAN SOBRE EL IMPULSO', 'TRADEDADLOG · COMMAND CENTER v2 · THE PLAN OVER THE IMPULSE'],
};

export function applyStatic(root = document) {
  document.documentElement.lang = lang;
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const p = STATIC[el.dataset.i18n];
    if (p) el.textContent = lang === 'es' ? p[0] : p[1];
  });
  root.querySelectorAll('[data-i18n-aria]').forEach(el => {
    const p = STATIC[el.dataset.i18nAria];
    if (p) el.setAttribute('aria-label', lang === 'es' ? p[0] : p[1]);
  });
  root.querySelectorAll('.lang button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
}

export function initLangToggle(onChange) {
  document.querySelectorAll('.lang button').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.lang === lang) return;
    lang = b.dataset.lang === 'es' ? 'es' : 'en';
    try { localStorage.setItem('cc_lang', lang); } catch (e) {}
    applyStatic();
    onChange();
  }));
  applyStatic();
}

// pick the right side of an {es, en} object the Session Analyst publishes
export const L = o => (o == null ? '' : typeof o === 'string' ? o : (o[lang] || o.en || o.es || ''));
