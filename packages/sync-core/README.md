# @ddv4/sync-core

Wspólny rdzeń discordrive-next (etap 1, koncept §4, §5, §6.2): model indeksu, log
operacji, deterministyczne reguły konfliktów 1–10, snapshoty. Pakiet nie używa Discorda,
bazy, Redisa ani UI i działa w Node oraz w przeglądarce (sprawdzone na headless Chromium).

## Model

- **Drzewo** (`NodeRecord`): stałe losowe ID od klienta, nazwa i rodzic jako atrybuty.
  Pliki trzymają tylko wskaźnik do bieżącej wersji: `manifestRef`, rozmiar i liczbę
  fragmentów. Dwa korzenie systemowe: `root` oraz `recovered` („Odzyskane”, nieusuwalny).
- **Manifesty** (`manifest.ts`) to osobna warstwa pobierana na żądanie (§4.1), z cache LRU.
  Format jest zgodny z `FileChunkManifestPlaintext` z discordrive.
- **Uploady** (`UploadRecord`): `open → committed → bound → released`, albo `aborted`.
  Tylko `released` (po retencji) i `aborted` wolno fizycznie skasować (`gc.ts`).
- **Log**: `OpEnvelope` (opId, rulesVersion, baseSeq, urządzenie, leaseGuard, op) plus
  `seq` i `serverTime` nadawane przez serwer (`Sequencer`). Kolejność wyznacza tylko `seq`.
- **Magazyn** (`IndexStore`): synchroniczny interfejs pod SQLite (OPFS w przeglądarce,
  plik w CLI). Na razie istnieje implementacja w pamięci. Każdy wpis logu jest stosowany
  w nakładce (`OverlayStore`) i zatwierdzany atomowo, dzięki czemu operacje grupowe
  wchodzą w całości albo wcale.

## Reguły

Wszystkie w `src/apply.ts`, każda opisana w komentarzu z numerem z §5.3. Tam, gdzie
koncept milczy, przyjęte zachowanie jest opisane w [QUESTIONS.md](QUESTIONS.md).

## Testy

```
npm test -w @ddv4/sync-core                                # jednostkowe + losowy (300 przebiegów)
FUZZ_RUNS=20000 npx vitest run test/fuzz.test.ts           # dłuższy test losowy
npx tsx test/run-sim.ts <seed> <n>                         # symulacja poza vitestem, zapisuje przypadek, który padł
CHROMIUM_PATH=... npx tsx test/browser-check.ts 40 7       # te same logi w Chromium, porównanie stanów z Node
python3 scripts/mutation-check.py                          # czy testy łapią celowo zepsute reguły
```

Test losowy symuluje 3–4 urządzenia i serwer: nieaktualne widoki, częściowe pobieranie
logu, pracę offline, uploady z dzierżawami, porzucone uploady, sprzątanie, GC, dołączenie
urządzenia ze snapshotu i błędne operacje. Sprawdza:
identyczny stan wszystkich replik (także przy odwróconej kolejności iteracji magazynu),
niezmienniki drzewa po **każdym** prefiksie logu, brak utraty treści bez operacji
usunięcia, brak odwołań do skasowanych fragmentów oraz to, że snapshot plus ogon logu
daje ten sam stan co pełny log.

`scripts/gen-casefold.mjs` generuje zamrożoną tabelę case-fold. Zmiana tabeli wymaga
podbicia `RULES_VERSION`.
