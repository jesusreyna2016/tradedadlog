// New-deploy check for the standalone pages (Command Center, health, plan, scalp...).
// Every 3 min, and when the tab comes back to the front, it asks the server for this page's
// ETag. If a deploy changed it: a small bar offers to reload, and the page reloads by itself
// the next time the tab is brought back, unless you are typing. No hard refresh needed.
(function(){
  if (!/^https?:$/.test(location.protocol)) return;
  var url = location.pathname, base = null, pending = false, bar = null;
  var T = function(es, en){ var l = 'en'; try { l = localStorage.getItem('cc_lang') === 'es' ? 'es' : 'en'; } catch (e) {} return l === 'es' ? es : en; };
  function tag(r){ return r.headers.get('etag') || r.headers.get('last-modified') || ''; }
  function busy(){
    var a = document.activeElement;
    return !!(a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'checkbox' && a.type !== 'radio') || a.isContentEditable));
  }
  function reload(){ location.reload(); }
  function show(){
    if (bar) return;
    bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;display:flex;gap:10px;align-items:center;' +
      'max-width:calc(100vw - 32px);padding:9px 14px;border-radius:10px;background:#161e26;border:1px solid rgba(199,146,53,0.45);' +
      'color:#e9eef3;font:12px "JetBrains Mono",ui-monospace,monospace;box-shadow:0 6px 24px rgba(0,0,0,0.45)';
    var msg = document.createElement('span');
    msg.textContent = T('Hay una versión nueva de esta página.', 'A new version of this page is out.');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = T('Recargar', 'Reload');
    btn.style.cssText = 'background:rgba(199,146,53,0.15);border:1px solid #c79235;color:#c79235;border-radius:8px;padding:5px 10px;font:inherit;cursor:pointer';
    btn.onclick = reload;
    bar.appendChild(msg); bar.appendChild(btn);
    document.body.appendChild(bar);
  }
  function check(){
    fetch(url, { method: 'HEAD', cache: 'no-store' }).then(function(r){
      if (!r.ok) return;
      var t = tag(r); if (!t) return;
      if (base === null) { base = t; return; }
      if (t !== base) {
        pending = true; show();
        try { navigator.serviceWorker && navigator.serviceWorker.getRegistration().then(function(g){ g && g.update(); }); } catch (e) {}
      }
    }).catch(function(){});
  }
  check();
  setInterval(function(){ if (!document.hidden) check(); }, 3 * 60000);
  document.addEventListener('visibilitychange', function(){
    if (document.hidden) return;
    if (pending && !busy()) reload(); else check();
  });
})();
