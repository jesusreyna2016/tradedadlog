// Language for the decision engine (decision.js): English by default, Spanish on toggle.
// Shares the cc_lang key with the Command Center, which calls setLang when the toggle changes.

let lang = 'en';
try { lang = localStorage.getItem('cc_lang') === 'es' ? 'es' : 'en'; } catch (e) {}

export const getLang = () => lang;
export const setLang = l => { lang = l === 'es' ? 'es' : 'en'; };

// inline pair for dynamic text: T('texto', 'text')
export const T = (es, en) => (lang === 'es' ? es : en);

// bilingual object {es, en} from the Session Analyst plans
export const L = o => (o == null ? '' : typeof o === 'string' ? o : (o[lang] || o.en || o.es || ''));
