/* Cobalt colour mode: light / dark / system, the same model as discordrive's ColorModeToggle
 * (apps/frontend/src/stores/colorMode.ts): "system" = no explicit choice, prefers-color-scheme decides.
 * Loaded as an external script before the CSS (the CSP allows only 'self' scripts), so there is no flash.
 *  - <html data-theme="light|dark"> = the resolved mode, <html data-theme-mode> = the user's choice;
 *  - the choice is kept in localStorage "ddn.color-mode" (absent = system), other tabs follow it;
 *  - ?theme=light|dark|system in the address previews a mode without saving it (screenshots);
 *  - API: window.ddnTheme.get() / .resolved() / .set(mode); event "ddn-theme" on document.
 */
(function () {
  if (window.ddnTheme) return;
  var KEY = "ddn.color-mode", MODES = ["light", "dark", "system"];
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "system";
    } catch (e) {
      return "system";
    }
  }
  var forced = (location.search.match(/[?&]theme=(light|dark|system)\b/) || [])[1];
  var mode = forced || read();
  function resolved() {
    return mode === "system" ? (mq && mq.matches ? "dark" : "light") : mode;
  }
  function apply() {
    var r = resolved();
    root.setAttribute("data-theme", r);
    root.setAttribute("data-theme-mode", mode);
    root.style.colorScheme = r;
    try {
      document.dispatchEvent(new CustomEvent("ddn-theme", { detail: { mode: mode, resolved: r } }));
    } catch (e) {}
  }
  function set(m) {
    if (MODES.indexOf(m) < 0) return;
    mode = m;
    try {
      if (m === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, m);
    } catch (e) {}
    apply();
  }
  apply();
  if (mq) {
    var onSystem = function () {
      if (mode === "system") apply();
    };
    if (mq.addEventListener) mq.addEventListener("change", onSystem);
    else mq.addListener(onSystem);
  }
  window.addEventListener("storage", function (e) {
    if (e.key === KEY && !forced) {
      mode = read();
      apply();
    }
  });
  window.ddnTheme = { get: function () { return mode; }, resolved: resolved, set: set };
})();
