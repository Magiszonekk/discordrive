# @ddv4/ddn-server: instancja discordrive-next (`discordrive`)

Jeden proces: API trybu metadata only (`/v1/...`), websocket powiadomień (`/v1/notify`) i
zbudowana aplikacja przeglądarkowa (`apps/web-mo/dist`) z tego samego originu (service
worker do odtwarzania wideo wymaga tego samego originu i HTTPS).

## Szybki start

Patrz „Szybki start” w głównym [README](../../README.md): `git clone` → `npm run setup`.
`bin/discordrive.mjs` jest w czystym JS: sprawdza wersję Node (≥ 22.13, czytelny komunikat),
przy pierwszym uruchomieniu doinstalowuje tylko zależności tej aplikacji
(`npm ci --workspace @ddv4/ddn-server --omit=dev`, ok. 50 pakietów, bez Prismy/Postgresa
starego ddv4), potem ładuje źródła TS przez tsx.

Kreator (po polsku, Enter = wartość w nawiasie):
0. sprawdza wymagania (Node, zapis w katalogu danych),
1. gdzie ma działać: **tylko ten komputer** (domyślnie: `http://localhost:<port>`, bind
   127.0.0.1, rejestracja otwarta; localhost to bezpieczny kontekst, więc service worker i
   WebCrypto działają bez TLS) albo **serwer z domeną** (adres https, adres nasłuchu,
   zaufane proxy, rejestracja domyślnie z kodem zaproszenia); port z wykryciem zajętego,
2. tryb (dziś `metadata-only`; e2ee i plain widoczne jako „wkrótce”),
3. udostępnianie linkiem: „Pomiń na razie” jest domyślne i wyjaśnia, co się traci; „teraz”
   pokazuje krok po kroku Discord Developer Portal; token wpisywany bez echa, sprawdzany przez
   `GET /users/@me`, zapisywany tylko w pliku konfiguracji,
4. kto zakłada konta (tylko dla serwera z domeną),
5. katalog danych (sprawdza zapis),

potem zapisuje `config.json`, buduje aplikację przeglądarkową, na Linuksie z systemd pyta o
usługę `discordrive-next.service` (domyślnie tak dla serwera, nie dla „tylko ten komputer”),
w przeciwnym razie proponuje uruchomienie w tym oknie (Ctrl+C zatrzymuje), robi test
`/v1/health` i kończy podsumowaniem: adres do otwarcia, co zrobić w przeglądarce, gdzie są
konfiguracja i dane, `npm start` / `npm run setup` / `npm run doctor`.
Ponowne uruchomienie = edycja: obecne wartości są domyślne, zapisany token zostaje, chyba że
wybierzesz inaczej.

Wieloplatformowość: katalog danych `~/.local/share` / `~/Library/Application Support` /
`%LOCALAPPDATA%` (nadpisanie: `DISCORDRIVE_DATA_DIR`), ścieżki przez `path`/`os.homedir()`,
systemd tylko na Linuksie, uprawnienia POSIX (0600/0700) tylko poza Windows. Na żywo
sprawdzone na Linuksie; macOS i Windows tylko przeglądem kodu.

## Polecenia

```
discordrive setup  [--data-dir DIR]          # kreator; ponownie = edycja         (npm run setup)
discordrive start  [--data-dir DIR]          # serwer w tym oknie (alias: serve)  (npm start)
discordrive doctor [--data-dir DIR]          # (npm run doctor) Node, zapis, konfiguracja, uprawnienia, port, bind, unit, health lokalnie i publicznie, token bota
discordrive invite [--days N] [--note TXT]   # nowy jednorazowy kod zaproszenia (npm run invite)
```

Bez pytań (testy, automatyzacja):

```
discordrive setup --yes --public-url https://dysk.example.com --host 10.0.0.2 --port 3020 \
  --trust-proxy 10.0.0.1 --signup invite --bot-token-file ~/bot.token --systemd
discordrive setup --yes --answers odpowiedzi.json      # te same klucze w JSON (publicUrl, host, port, trustProxy, signup, botTokenFile, systemd, …)
```

`--bot-token` w linii poleceń jest odrzucany (trafiłby do historii powłoki).
`--bot-token-file` przyjmuje sam token albo plik `.env` z linią `NAZWA=token`.

## Pliki

- `<katalog danych>/config.json` (0600; katalog 0700; domyślnie wg platformy, wyżej): jedyne źródło konfiguracji serwera. Opis pól:
  [.env.example](.env.example) (dokumentacja, serwer nie czyta zmiennych środowiskowych).
- `<katalog danych>/ddn.db` (0600): baza serwera (zaszyfrowany log, sejfy, klucze publiczne
  urządzeń, kody zaproszeń jako SHA-256, adresy załączników udostępnionych plików).
- `~/.config/systemd/user/discordrive-next.service`: unit z pełną ścieżką do Node.

## Preview

Publiczny preview projektu stoi za nginx z TLS (websocket przekazywany) i został
skonfigurowany samym `discordrive setup` w trybie „serwer z domeną”.

## Testy

```
npm test -w @ddv4/ddn-server     # kreator bez pytań i ze skryptowanym wejściem, zaproszenia, limity per IP, health, statyka, doctor
```
