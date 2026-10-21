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

/* Accent colour (Settings -> Appearance), as discordrive's stores/theme.ts: presets inside Cobalt's envelope
 * (OKLCH L 55-64 %, C 0.14-0.20, only the hue changes) or a custom colour (#rrggbb). Applied as inline custom
 * properties on <html> before the CSS, so there is no flash; kept per device in localStorage "ddn.accent"
 * (absent = Cobalt). API: window.ddnAccent.get() / .set(nameOrHex) / .presets; event "ddn-accent" on document.
 */
(function () {
  if (window.ddnAccent) return;
  var KEY = "ddn.accent";
  var PRESETS = [
    { name: "cobalt", accent: "oklch(58% 0.20 256)", hover: "oklch(52% 0.20 256)", ink: "oklch(99% 0.004 250)" },
    { name: "violet", accent: "oklch(56% 0.19 300)", hover: "oklch(50% 0.19 300)", ink: "oklch(99% 0.004 250)" },
    { name: "teal", accent: "oklch(55% 0.14 195)", hover: "oklch(49% 0.14 195)", ink: "oklch(99% 0.004 250)" },
    { name: "emerald", accent: "oklch(58% 0.17 152)", hover: "oklch(52% 0.17 152)", ink: "oklch(99% 0.004 250)" },
    { name: "amber", accent: "oklch(64% 0.16 75)", hover: "oklch(58% 0.16 75)", ink: "oklch(20% 0.03 70)" },
    { name: "rose", accent: "oklch(56% 0.19 18)", hover: "oklch(50% 0.19 18)", ink: "oklch(99% 0.004 250)" },
  ];
  var root = document.documentElement;
  var HEX = /^#[0-9a-f]{6}$/i;
  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return v && (HEX.test(v) || PRESETS.some(function (p) { return p.name === v; })) ? v : "cobalt";
    } catch (e) {
      return "cobalt";
    }
  }
  var cur = read();
  /** A custom colour: hover a little darker, text black or white by its lightness. */
  function custom(hex) {
    var n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var lin = function (c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    var y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return { accent: hex, hover: "color-mix(in oklch, " + hex + " 88%, black)", ink: y > 0.4 ? "oklch(20% 0.02 260)" : "oklch(99% 0.004 250)" };
  }
  function apply() {
    var p = HEX.test(cur) ? custom(cur) : PRESETS.filter(function (x) { return x.name === cur; })[0] || PRESETS[0];
    var st = root.style;
    st.setProperty("--color-accent", p.accent);
    st.setProperty("--color-accent-hover", p.hover);
    st.setProperty("--color-accent-ink", p.ink);
    st.setProperty("--color-focus", p.accent);
    root.setAttribute("data-accent", HEX.test(cur) ? "custom" : cur);
    try {
      document.dispatchEvent(new CustomEvent("ddn-accent", { detail: { accent: cur } }));
    } catch (e) {}
  }
  function set(v) {
    v = String(v || "").toLowerCase();
    if (!HEX.test(v) && !PRESETS.some(function (p) { return p.name === v; })) return;
    cur = v;
    try {
      if (v === "cobalt") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, v);
    } catch (e) {}
    apply();
  }
  apply();
  window.addEventListener("storage", function (e) {
    if (e.key === KEY) {
      cur = read();
      apply();
    }
  });
  window.ddnAccent = { get: function () { return cur; }, set: set, presets: PRESETS.map(function (p) { return { name: p.name, accent: p.accent }; }) };
})();
