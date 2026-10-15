# discordrive-next

[English](README.md) · **Polski**

Prywatny dysk na Twoich kanałach Discorda. W trybie domyślnym pliki są szyfrowane w przeglądarce,
zanim cokolwiek opuści komputer; Discord przechowuje tylko zaszyfrowane kawałki, a serwer tylko
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
git clone https://github.com/Magiszonekk/discordrive.git
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

## Wymagania przeglądarki

Aplikacja loguje każde urządzenie kluczem Ed25519, który tworzy przeglądarka (WebCrypto). Potrzebny
jest **Chrome, Edge lub Brave 137 lub nowszy, Firefox 129 lub nowszy, Safari 17 lub nowsze** (także
na telefonach). Starsza przeglądarka zamiast formularza pokaże „Ta przeglądarka jest za stara”;
zaktualizuj ją. Zapasowej implementacji w JavaScripcie celowo nie ma: klucz zostaje w kryptografii
samej przeglądarki.

## Tryby

Wybierany w `npm run setup`, na zawsze dla danej instancji (inny tryb = nowa instancja w innym
katalogu danych). Aplikacja i serwer są budowane tylko dla tego jednego trybu.

| Tryb | Serwer widzi | Kto wysyła na Discorda | Praca w tle bez otwartej karty |
|---|---|---|---|
| **metadata only** (domyślny) | konta, klucze publiczne urządzeń, liczbę operacji, rozmiary i czasy; nie widzi plików, nazw ani webhooków | Twoja przeglądarka, prosto na Twoje kanały | nie |
| **e2ee** | to samo oraz webhooki i każdy zaszyfrowany fragment w drodze; nie widzi plików ani nazw | serwer, przez kanały instancji (albo Twoje, dodane w Ustawieniach) | tak: snapshoty, sprzątanie, odświeżanie linków |
| **plain** | wszystko (pliki, nazwy, klucze plików): miniatury, podgląd, wyszukiwanie na serwerze | serwer | tak |

Co w każdym trybie może serwer, Discord, złodziej bazy serwera albo urządzenia:
[docs/threat-model.md](docs/threat-model.md) (po angielsku, rozdział na każdy tryb). W skrócie:
- **metadata only**: przejęty serwer nie odczyta plików ani nie skasuje ich na Discordzie (nie zna
  webhooków); widzi wzorce użycia (kiedy, ile, jak duże).
- **e2ee**: przejęty serwer nie odczyta plików, ale zna webhooki, więc może skasować wszystko na
  Discordzie.
- **plain**: przejęty serwer albo skradziona baza = dostęp do wszystkich plików.
- We wszystkich trybach aplikację w przeglądarce dostarcza serwer: przejęty serwer może podać
  zmienioną aplikację, która wyśle klucz. Szyfrowanie chroni przed serwerem tylko, dopóki podaje
  on prawdziwą aplikację.

e2ee bez pytań: `npm run setup -- --yes --accept-risk --mode e2ee --webhooks-file hooki.txt`
(jeden URL webhooka w linii; zapisywane zaszyfrowane kluczem `instance.key` w katalogu danych,
nigdy w `config.json`).

## Urządzenia i osoby

**Twoje kolejne urządzenie (telefon, laptop).** Sparuj je z urządzeniem, które jest już zalogowane:
1. Na nowym urządzeniu otwórz adres dysku i wybierz **Dołącz to urządzenie**. Pokaże kod QR i
   tekst zaczynający się od `ddn-pair1:`.
2. Na zalogowanym: **Urządzenia → Sparuj nowe urządzenie**, zeskanuj kod (albo wklej tekst),
   naciśnij **Sparuj**.
3. Oba ekrany pokażą 6 cyfr. Muszą być takie same; jeśli nie są, przerwij i odwołaj nowe urządzenie.

Zalogowane urządzenie przekazuje klucz konta zaszyfrowany dla nowego, przez jednorazową skrzynkę na
serwerze: serwer go przenosi, ale nie odczyta. Nowe urządzenie dostaje własny klucz logowania
(Ed25519), dopisany do konta. Parowanie daje całe konto, więc tylko dla własnych urządzeń.

**Gdy żadnego urządzenia nie ma pod ręką:**
- **Zestaw ratunkowy** (pokazywany po pierwszym kanale, ponownie w Ustawieniach): na nowym
  urządzeniu wybierz **Mam zestaw ratunkowy** i wklej kod. Trzymaj go jak hasło: kto go ma, ma konto.
- **Logowanie hasłem** (opcjonalne, domyślnie wyłączone: Ustawienia → Bezpieczeństwo). Wygodne,
  ale serwer przechowuje wtedy klucz konta zamknięty hasłem. Kto ukradnie bazę serwera, może
  zgadywać hasło offline, więc tylko z długim hasłem.

**Zgubione albo stare urządzenie.** Urządzenia → **Odwołaj urządzenie**. Nie zaloguje się już do
serwera. Ograniczenie: klucz konta, który to urządzenie miało, się nie zmienia (nie ma rotacji
klucza). Kto go zachował, nadal odszyfruje to, co zdobędzie z Discorda, i może dodać do konta nowe
urządzenie tak jak zestawem ratunkowym. Jeśli urządzenie trafiło w niepowołane ręce, pełne
rozwiązanie to nowe konto i ponowne wysłanie plików. W metadata only dodatkowo usuń i utwórz od
nowa webhooki w Discordzie.

**Inna osoba.** Zawsze własne konto, nigdy parowanie. Na instancji publicznej administrator daje
jej kod zaproszenia (`npm run invite`). Konta są od siebie oddzielone: nikt nie widzi cudzych plików.
- metadata only: podłącza własne kanały i webhooki. Najlepiej utworzone przez nią samą: kto
  tworzy webhook, ten zna jego adres, a adres to sekret pozwalający wysyłać i kasować wiadomości.
- e2ee / plain: używane są wspólne kanały instancji, webhooki niepotrzebne (własne może dodać w
  Ustawieniach → Kanały i webhooki).

**Jeden plik dla kogoś.** **Udostępnij** na liście plików daje link `https://…/s/<id>#<klucz>`.
Odbiorca nie potrzebuje konta. Klucz po `#` nie trafia na serwer. Udostępnianie wymaga bota
Discord instancji (ustawianego w `npm run setup`). Wyłączenie linku zatrzymuje nowych odbiorców,
ale kto już ma link, zachowuje dostęp, dopóki fragmenty pliku istnieją na Discordzie.

**Wspólnych folderów między kontami nie ma i nie są planowane.**

## Polecenia

| Co | Polecenie (w katalogu `discordrive`) |
|---|---|
| włącz dysk | `npm start` (zatrzymanie: Ctrl+C) |
| zmień ustawienia | `npm run setup` |
| coś nie działa | `npm run doctor` |
| wyłącz uruchamianie w tle | `npm run uninstall-autostart` |
| kod zaproszenia (instancja publiczna) | `npm run invite` |
| aktualizacja do najnowszej wersji | `npm run update`, potem ponownie włącz dysk |

## Aktualizacja

`npm run update`, potem ponownie włącz dysk. To `git pull` + `npm install` + świeże zbudowanie
aplikacji przeglądarkowej. Sam `git pull` też wystarczy: `npm start` zauważy, że źródła aplikacji
przeglądarkowej się zmieniły, i przed startem ją przebuduje (kilka sekund). Działający dysk (albo
start w tle: systemd, Harmonogram zadań, LaunchAgent) pokazuje starą stronę, dopóki się go nie
uruchomi ponownie.

## Gdzie co jest

Dane serwera (konfiguracja i zaszyfrowany spis) są w `~/.local/share/discordrive-next`
(Linux), `~/Library/Application Support/discordrive-next` (macOS) albo
`%LOCALAPPDATA%\discordrive-next` (Windows). Same pliki są na Twoich kanałach Discorda.

## Dla zaawansowanych

Serwer z domeną i HTTPS, start w tle na Linuksie/Windows/macOS, opcje bez pytań:
[apps/ddn-server/README.md](apps/ddn-server/README.md) (po angielsku).

Uwaga: trzymanie plików na Discordzie jest niezgodne z jego regulaminem; Discord może usunąć
wiadomości albo zablokować konto. Trzymaj kopię ważnych plików gdzie indziej.
