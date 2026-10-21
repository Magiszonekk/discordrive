// First-start page of the desktop app (static/start.html): "Connect to a server" or "This computer only".
// Talks to the main process only through window.ddnDesktop.setup (preload); the main process checks the
// address, starts the built-in instance, saves the choice and loads the app.
(() => {
  const T = {
    pl: {
      "start.title": "Gdzie mają być Twoje pliki?",
      "start.remote": "Połącz z serwerem",
      "start.remote.hint": "Instancja, którą ktoś dla Ciebie prowadzi albo Ty sam (adres w rodzaju https://dysk.example.com). Konto działa też w przeglądarce.",
      "start.local": "Tylko ten komputer",
      "start.local.hint": "Aplikacja uruchamia własny mały serwer na tym komputerze. Nic nie trzeba instalować; dostęp ma tylko ten komputer.",
      "start.address": "Adres serwera",
      "start.back": "Wstecz",
      "start.connect": "Połącz",
      "r.title": "Zanim zaczniesz: przeczytaj i zaakceptuj",
      "r.tos": "1. Przechowywanie plików na Discordzie jest niezgodne z regulaminem Discorda. Discord może w każdej chwili i bez ostrzeżenia usunąć wiadomości i załączniki albo zablokować webhooki lub konto.",
      "r.warranty": "2. Oprogramowanie jest dostarczane „tak jak jest”, bez żadnej gwarancji (licencja MIT). Dane mogą zostać utracone. Trzymaj kopię ważnych plików gdzie indziej.",
      "r.accept": "Rozumiem i akceptuję",
    },
  };
  const lang = /^pl\b/i.test(navigator.language) ? "pl" : "en";
  if (T[lang]) for (const el of document.querySelectorAll("[data-t]")) el.textContent = T[lang][el.dataset.t] ?? el.textContent;
  document.documentElement.lang = lang;

  const $ = (s) => document.querySelector(`[data-ddn="${s}"]`);
  const show = (which) => {
    for (const s of ["start-choice", "start-remote-form", "start-terms"]) $(s).hidden = s !== which;
  };
  const api = window.ddnDesktop?.setup;
  const fail = (el, e) => {
    el.textContent = String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    el.hidden = false;
  };

  $("start-remote").onclick = () => {
    show("start-remote-form");
    $("start-url").focus();
  };
  $("start-local").onclick = () => show("start-terms");
  $("start-back").onclick = $("start-back2").onclick = () => show("start-choice");

  const connect = async () => {
    const btn = $("start-connect");
    btn.disabled = true;
    $("start-remote-err").hidden = true;
    try {
      await api.connect($("start-url").value);
    } catch (e) {
      fail($("start-remote-err"), e);
    } finally {
      btn.disabled = false;
    }
  };
  $("start-connect").onclick = () => void connect();
  $("start-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") void connect();
  });
  $("start-accept").onclick = async () => {
    const btn = $("start-accept");
    btn.disabled = true;
    $("start-local-err").hidden = true;
    try {
      await api.local();
    } catch (e) {
      fail($("start-local-err"), e);
    } finally {
      btn.disabled = false;
    }
  };
})();
