# @ddv4/ddn-server: instancja discordrive-next (`discordrive`)

Jeden proces: API trybu metadata only (`/v1/...`), websocket powiadomień (`/v1/notify`) i
zbudowana aplikacja przeglądarkowa (`apps/web-mo/dist`) z tego samego originu (service
worker do odtwarzania wideo wymaga tego samego originu i HTTPS).

## Szybki start

```
npm run setup                 # z katalogu głównego repo; albo: npx discordrive setup
```

Kreator (po polsku, Enter = wartość w nawiasie) pyta o:
1. tryb (dziś `metadata-only`; e2ee i plain widoczne jako „wkrótce”),
2. adres publiczny (np. `https://dysk.example.com`),
3. adres i port nasłuchu (sprawdza, czy adres jest na tej maszynie i czy port jest wolny;
   jeśli zajęty, proponuje następny wolny),
4. zaufane reverse proxy (tylko od niego `X-Forwarded-For`),
5. token bota instancji do udostępniania (opcjonalny, wpisywany bez echa, sprawdzany przez
   `GET /users/@me`, zapisywany tylko w pliku konfiguracji 0600),
6. kto może zakładać konta (kod zaproszenia / każdy / nikt),

potem zapisuje `config.json`, generuje kod zaproszenia, opcjonalnie instaluje i uruchamia
`discordrive-next.service` (systemd --user), robi test (`/v1/health` lokalnie i pod adresem
publicznym) i drukuje gotowy snippet vhosta nginx (niczego na zdalnych hostach nie zmienia).
Ponowne uruchomienie = edycja: obecne wartości są domyślne, zapisany token zostaje, chyba że
wybierzesz inaczej.

## Polecenia

```
discordrive setup  [--data-dir DIR]          # kreator; ponownie = edycja
discordrive serve  [--data-dir DIR]          # serwer (to uruchamia unit systemd)
discordrive doctor [--data-dir DIR]          # konfiguracja, uprawnienia, port, bind, unit, health lokalnie i publicznie, token bota
discordrive invite [--days N] [--note TXT]   # nowy jednorazowy kod zaproszenia
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

- `<katalog danych>/config.json` (0600; katalog 0700; domyślnie
  `~/.local/share/discordrive-next/`): jedyne źródło konfiguracji serwera. Opis pól:
  [.env.example](.env.example) (dokumentacja, serwer nie czyta zmiennych środowiskowych).
- `<katalog danych>/ddn.db` (0600): baza serwera (zaszyfrowany log, sejfy, klucze publiczne
  urządzeń, kody zaproszeń jako SHA-256, adresy załączników udostępnionych plików).
- `~/.config/systemd/user/discordrive-next.service`: unit z pełną ścieżką do Node.

## Preview

https://drive.example.com → nginx na a VPS (TLS, websocket) → `192.0.2.10:3020` na serwerze
domowym; skonfigurowane samym `discordrive setup` (przebieg w pty w raporcie 2026-10-09).

## Testy

```
npm test -w @ddv4/ddn-server     # kreator bez pytań i ze skryptowanym wejściem, zaproszenia, limity per IP, health, statyka, doctor
```
