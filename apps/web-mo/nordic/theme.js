/* nordic · theme.js — tryb jasny/ciemny wspólny dla wszystkich *example.com.
 *
 * Wklej INLINE na początku <head> (plik theme.inline.js), PRZED arkuszami stylów, żeby nie mrugało.
 * Bez zależności. Ciasteczko: cik_theme=light|dark|system; Domain=example.com; Path=/; Max-Age=1 rok; SameSite=Lax.
 * Ciasteczko dotyczy TYLKO wyglądu; serwer nie powinien go czytać do niczego innego.
 *
 * Co robi:
 *  - ustawia <html data-theme="light|dark"> (wynik rozwiązany: "system" → wg prefers-color-scheme) oraz klasę .dark,
 *    a <html data-theme-mode> = wybór użytkownika (light|dark|system);
 *  - gotowy przełącznik: każdy <button data-theme-toggle> (cykl: system → jasny → ciemny) oraz
 *    każdy <div data-theme-switch> (3 przyciski segmentowe) jest podpinany automatycznie;
 *  - synchronizacja: strona w ramce (iframe w example.com) przyjmuje postMessage
 *    {type:"cik-theme",mode} z *example.com, a każda karta ponownie czyta ciasteczko po powrocie (focus);
 *  - zdarzenie document "cik-theme" {detail:{mode,resolved}} dla aplikacji (np. motyw toastów, wykresy);
 *  - API: window.cikTheme.get() / .resolved() / .set(mode) / .cycle().
 */
(function () {
  if (window.cikTheme) return;
  var NAME = 'cik_theme', MODES = ['system', 'light', 'dark'];
  var doc = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var onCik = /(^|\.)example\.pl$/.test(location.hostname);

  function read() {
    var m = document.cookie.match(/(?:^|;\s*)cik_theme=(light|dark|system)\b/);
    return m ? m[1] : 'system';
  }
  function write(mode) {
    var c = NAME + '=' + mode + '; Path=/; Max-Age=31536000; SameSite=Lax';
    if (onCik) c += '; Domain=example.com';
    if (location.protocol === 'https:') c += '; Secure';
    document.cookie = c;
  }
  function resolve(mode) { return mode === 'system' ? (mq && mq.matches ? 'dark' : 'light') : mode; }

  // ?nd-theme=light|dark w adresie: podgląd bez zapisu ciasteczka (zrzuty review, galeria)
  var forced = (location.search.match(/[?&]nd-theme=(light|dark|system)\b/) || [])[1];
  var current = forced || read();
  function apply(mode, silent) {
    current = mode;
    var r = resolve(mode);
    doc.setAttribute('data-theme', r);
    doc.setAttribute('data-theme-mode', mode);
    doc.classList.toggle('dark', r === 'dark');
    doc.style.colorScheme = r;
    if (!silent) {
      paint();
      try { document.dispatchEvent(new CustomEvent('cik-theme', { detail: { mode: mode, resolved: r } })); } catch (e) {}
    }
  }
  apply(current, true);

  function set(mode, from) {
    if (MODES.indexOf(mode) < 0) return;
    write(mode);
    apply(mode);
    if (from !== 'msg') broadcast(mode);
  }
  // przekaż wybór do ramek (dashboard → strona w iframe), żeby nie trzeba było jej przeładować
  function broadcast(mode) {
    var fr = document.querySelectorAll('iframe');
    for (var i = 0; i < fr.length; i++) {
      try { fr[i].contentWindow.postMessage({ type: 'cik-theme', mode: mode }, '*'); } catch (e) {}
    }
  }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.type !== 'cik-theme') return;
    if (!/^https:\/\/([a-z0-9-]+\.)*example\.pl$/.test(e.origin) && e.origin !== location.origin) return;
    if (MODES.indexOf(d.mode) >= 0 && d.mode !== current) apply(d.mode);
  });
  window.addEventListener('focus', function () { if (forced) return; var m = read(); if (m !== current) apply(m); });
  if (mq) {
    var onSys = function () { if (current === 'system') apply('system'); };
    mq.addEventListener ? mq.addEventListener('change', onSys) : mq.addListener(onSys);
  }

  // ---------- przełącznik ----------
  var LABEL = { system: 'Motyw: jak system', light: 'Motyw: jasny', dark: 'Motyw: ciemny' };
  var SHORT = { system: 'System', light: 'Jasny', dark: 'Ciemny' };
  var P = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var ICON = {
    light: P + '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>',
    dark: P + '<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z"/></svg>',
    system: P + '<rect x="3" y="4" width="18" height="12.5" rx="2.5"/><path d="M8.5 20.5h7M12 16.5v4"/></svg>'
  };
  function cycle() { set(MODES[(MODES.indexOf(current) + 1) % 3]); }
  function paint() {
    var t = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < t.length; i++) {
      var b = t[i];
      if (!b.__cik) { b.__cik = 1; b.addEventListener('click', cycle); if (!b.type) b.type = 'button'; }
      var next = MODES[(MODES.indexOf(current) + 1) % 3];
      b.setAttribute('aria-label', LABEL[current] + ' (kliknij: ' + SHORT[next].toLowerCase() + ')');
      b.setAttribute('title', LABEL[current]);
      b.setAttribute('data-mode', current);
      var slot = b.querySelector('[data-theme-icon]') || b;
      if (!b.hasAttribute('data-theme-keep')) slot.innerHTML = ICON[current];
      var lab = b.querySelector('[data-theme-label]');
      if (lab) lab.textContent = SHORT[current];
    }
    var s = document.querySelectorAll('[data-theme-switch]');
    for (var j = 0; j < s.length; j++) {
      var g = s[j];
      if (!g.__cik) {
        g.__cik = 1;
        g.setAttribute('role', 'radiogroup');
        if (!g.getAttribute('aria-label')) g.setAttribute('aria-label', 'Motyw');
        g.innerHTML = ['light', 'dark', 'system'].map(function (m) {
          return '<button type="button" role="radio" data-mode="' + m + '">' + ICON[m] + '<span>' + SHORT[m] + '</span></button>';
        }).join('');
        g.addEventListener('click', function (e) { var b = e.target.closest('button[data-mode]'); if (b) set(b.getAttribute('data-mode')); });
      }
      var bs = g.querySelectorAll('button[data-mode]');
      for (var k = 0; k < bs.length; k++) bs[k].setAttribute('aria-checked', String(bs[k].getAttribute('data-mode') === current));
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
  else paint();

  window.cikTheme = {
    get: function () { return current; },
    resolved: function () { return resolve(current); },
    set: function (m) { set(m); },
    cycle: cycle,
    refresh: paint
  };
})();
