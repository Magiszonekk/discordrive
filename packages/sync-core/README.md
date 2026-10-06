# @ddv4/sync-core

Wspólny rdzeń discordrive-next (etap 1, koncept §4, §5, §6.2): model indeksu, log
operacji, deterministyczne reguły konfliktów 1–10 (wersja reguł 2), snapshoty. Pakiet nie używa Discorda,
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

Wszystkie w `src/apply.ts`, każda opisana w komentarzu z numerem z §5.3. Przypadki, których
koncept nie rozstrzygał, rozstrzygnął właściciel 2026-10-05: [DECISIONS.md](DECISIONS.md)
(wersja reguł 2). W skrócie:

- usunięcie folderu zabiera do kosza także zmiany, których autor nie widział, a ich autor
  dostaje `unseen_trashed_with_folder` (Q1),
- kosz pliku z niewidzianą nową treścią jest pomijany po cichu (Q2),
- purge usuwa tylko to, co autor widział; reszta zostaje w koszu z nowym licznikiem 30 dni (Q3),
- kopia konfliktowa ma w nazwie czas lokalny autora (`tzOffsetMin` w kopercie, Q6),
- identyczna treść (`plaintextSha256`) to nie konflikt (Q7),
- w operacji grupowej elementy pominięte przez regułę wypadają, a wycofanie całości
  następuje tylko przy błędnym elemencie (Q9).

Powiadomienia z `silent: true` (`SILENT_NOTICE_CODES`) UI domyślnie ukrywa.

### Polityka klienta na etap 2 (rdzeń jej nie wymusza)

- **Automatyczne czyszczenie kosza (Q4):** kandydatów wskazuje `expiredTrash()`. Domyślnie
  czyści urządzenie główne (desktop / główna karta). Gdy nikt nie czyścił przez 7 dni,
  może dowolne urządzenie. Zawsze: urządzenie w pełni zsynchronizowane, tylko węzły
  starsze niż 30 dni w koszu, nie na łączu taryfowym.
- **Błędne operacje (Q10):** licznik `invalid_op` na urządzenie, komunikat w UI po N
  (np. 5) błędach.
- **Nazwy (Q5):** klient normalizuje do NFC przed utworzeniem operacji; przy cudzej nazwie
  nie-NFC tylko ostrzega.

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
usunięcia (albo zamiany na identyczną treść, Q7), to, że niewidziana treść nie znika po
cichu (zostaje albo trafia do kosza razem z folderem i jej autor dostaje powiadomienie,
koncept §5.2.3, Q1 + #11), brak odwołań do
skasowanych fragmentów, to, że wpis pominięty lub odrzucony nie zmienia stanu, oraz to,
że snapshot plus ogon logu daje ten sam stan co pełny log. Urządzenia w symulacji mają
różne strefy czasowe (Q6), a część treści ma ten sam hash (Q7).

`scripts/gen-casefold.mjs` generuje zamrożoną tabelę case-fold. Zmiana tabeli wymaga
podbicia `RULES_VERSION`.
