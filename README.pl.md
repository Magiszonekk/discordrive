# discordrive-next

[English](README.md) · **Polski**

Prywatny dysk na Twoich kanałach Discorda. Pliki są szyfrowane w przeglądarce, zanim
cokolwiek opuści komputer; Discord przechowuje tylko zaszyfrowane kawałki, a serwer tylko
zaszyfrowany spis plików. Działa w przeglądarce na komputerze i telefonie.

## Szybki start

**Potrzebujesz:**
- **Node.js 22 lub nowszy** (wersja „LTS” ze strony https://nodejs.org; na Windows/macOS
  zwykły instalator, potem otwórz nowe okno terminala). Sprawdzenie: `node -v`.
- **Git** (https://git-scm.com) i dostęp do tego repozytorium.
- **Konto Discord** (zwykłe, darmowe). Serwer, kanały i webhooki założysz w trakcie: aplikacja
  pokaże, gdzie kliknąć.

**Uruchomienie** (Terminal na macOS/Linuksie albo PowerShell na Windows):

```
git clone -b feat/metadata-only https://github.com/Magiszonekk/discordrive.git
cd discordrive
npm run setup
```

Za pierwszym razem `npm run setup` sam doinstaluje potrzebne biblioteki (kilkanaście sekund,
potrzebny internet). Pierwsze pytanie po języku to ostrzeżenie, które trzeba świadomie
zaakceptować (sam Enter anuluje): przechowywanie plików na Discordzie jest niezgodne z jego
regulaminem, a oprogramowanie jest bez żadnej gwarancji. Potem zada kilka pytań: wybierasz
strzałkami, zatwierdzasz Enterem. **Na każde z nich możesz odpowiedzieć Enterem**:
domyślnie dysk działa tylko na tym komputerze, pod adresem `http://localhost:3020`.
Udostępnianie linkiem (wymaga własnego bota Discord) możesz pominąć i włączyć później.

**Co zobaczysz:** na końcu kreator napisze „Gotowe. Otwórz w przeglądarce: http://localhost:3020”
i zostawi dysk włączony w tym oknie.
Kreator jest domyślnie po angielsku; polski wybierzesz w pierwszym pytaniu
(`Language / Język` → `2`), flagą `npm run setup -- --lang pl` albo zmienną
`DISCORDRIVE_LANG=pl`. Wybór zostaje zapisany dla kolejnych poleceń. Aplikacja w przeglądarce
ma przełącznik EN/PL w nagłówku. Otwórz ten adres, załóż konto, podłącz kanał Discorda
według instrukcji na ekranie, zapisz zestaw ratunkowy i wyślij pierwszy plik.

**Później:**

| Co | Polecenie (w katalogu `discordrive`) |
|---|---|
| włącz dysk | `npm start` (zatrzymanie: Ctrl+C) |
| zmień ustawienia | `npm run setup` |
| coś nie działa | `npm run doctor` |
| wyłącz uruchamianie w tle | `npm run uninstall-autostart` |
| kod zaproszenia (instancja publiczna) | `npm run invite` |
| aktualizacja do najnowszej wersji | `npm run update`, potem ponownie włącz dysk |

`npm run update` = `git pull` + `npm install` + świeże zbudowanie aplikacji przeglądarkowej.
Sam `git pull` też wystarczy: `npm start` zauważy, że źródła aplikacji przeglądarkowej się
zmieniły, i przed startem ją przebuduje (kilka sekund). Działający dysk (albo start w tle: systemd, Harmonogram zadań, LaunchAgent)
pokazuje starą stronę, dopóki się go nie uruchomi ponownie.

Dane serwera (konfiguracja i zaszyfrowany spis) są w `~/.local/share/discordrive-next`
(Linux), `~/Library/Application Support/discordrive-next` (macOS) albo
`%LOCALAPPDATA%\discordrive-next` (Windows). Same pliki są na Twoich kanałach Discorda.

Dla zaawansowanych (serwer z domeną i HTTPS, start w tle na Linuksie/Windows/macOS, opcje bez pytań):
[apps/ddn-server/README.md](apps/ddn-server/README.md).
Uwaga: trzymanie plików na Discordzie jest niezgodne z jego regulaminem; Discord może usunąć
wiadomości albo zablokować konto. Trzymaj kopię ważnych plików gdzie indziej.

Starsza dokumentacja (ddv4, `apps/api`, `apps/frontend`): w [README.md](README.md#older-version-discordrive-v4-source-for-the-next-modes) (po angielsku).
