# @ddv4/sync-core: decyzje właściciela (etap 1)

Wcześniej był tu plik `QUESTIONS.md` z pytaniami Q1–Q11 i zachowaniem tymczasowym
(`PROVISIONAL`). Właściciel odpowiedział 2026-10-05. Pełna treść decyzji:
`~/Desktop/discordrive-next/decyzje-sync-core-2026-10-05.md` (poza repo, obok
`koncept.md`; wpis w dzienniku konceptu z 2026-10-05). Konflikt Q1 z §5.2.3
rozstrzygnięty 2026-10-06 (owner inbox #11, niżej przy Q1).

Decyzje Q1–Q3, Q6, Q7 i Q9 zmieniają reguły deterministyczne, dlatego
**`RULES_VERSION = 2`** (`src/types.ts`). Testy jednostkowe każdej zmienionej reguły
są w `test/decisions.test.ts`.

## Wersja reguł i stare logi

`MIN_REPLAY_RULES_VERSION = 2`: log zapisany regułami 1 nie jest odtwarzany
(`UnsupportedRulesVersionError`), a snapshot zbudowany regułami 1 jest odrzucany
przy wczytaniu. Powód: reguły 1 istniały tylko w testach etapu 1, żaden serwer nie
trzyma logu v1. Trzymanie drugiego zestawu reguł tylko po to, żeby odtwarzać
nieistniejące logi, to koszt bez danych. Od pierwszego prawdziwego logu każda kolejna
zmiana reguł musi zostawić stare wersje odtwarzalne (rozgałęzienie w `applyEntry`
po `entry.rulesVersion`). Format snapshotu podbity do 2 (nowe pola w `FileVersion`).

## Q1. Usunięcie folderu po niewidzianej zmianie w nim: folder idzie do kosza RAZEM z nią
Decyzja: wariant 2 (zmiana względem tymczasowego „Odzyskane”), potwierdzona w #11:
usunięcie folderu usuwa **cały** folder.
- `trash` folderu nie przenosi już niczego do „Odzyskane”. Węzły dodane, przeniesione
  lub przywrócone do poddrzewa po `baseSeq` autora usunięcia oraz pliki z niewidzianą
  nową treścią trafiają do kosza razem z folderem.
- Każde urządzenie, którego niewidziana zmiana trafiła do kosza, dostaje powiadomienie
  `unseen_trashed_with_folder` (`notifyDeviceId` = to urządzenie, `nodeId` = węzeł,
  `relatedNodeId` = folder, `reason` = `placed` | `content`). Jedno powiadomienie na
  urządzenie i najwyższy węzeł z jego zmianą: wgranie folderu z 1000 plików daje jedno
  powiadomienie, nie 1001.
- Kolejność prosta (najpierw kosz, potem dodanie do folderu w koszu) bez zmian: plik
  trafia do „Odzyskane” (reguła 4). Wynik zależy więc od kolejności w logu, ale nadal
  jest deterministyczny. Jawne przeniesienie pliku wygrywa w obu kolejnościach.
- Wyrzucenie do kosza jest odwracalne przez 30 dni, a Q3 chroni takie węzły przed
  natychmiastowym purge przez autora, który ich nie widział.

### Rozstrzygnięcie #11 (2026-10-06): Q1 dosłownie, wyjątek w §5.2.3
Pytanie: Q1 kłóciło się z §5.2.3 konceptu („nowa treść zawsze ląduje w widocznym
miejscu”) i z niezmiennikiem I4 testu losowego, a do tego było niespójne z Q2 (kosz
samego pliku z niewidzianą treścią jest pomijany, kosz folderu z tym plikiem nie).
Właściciel wybrał opcję 1: zostaje jak jest. Uzasadnienie: prostota. Kto usuwa folder,
usuwa całość, jak w galerii na telefonie; zwykle jedno konto = jedna osoba, a urządzenia
są zsynchronizowane, więc to przypadek rzadki. Odrzucone: opcja 2 (niewidziana nowa
treść do „Odzyskane”) i opcja 3 (Q2 dostosowane do Q1).
- **Koncept §5.2.3** dostał wyjątek: niewidziana treść nie znika po cichu. Albo zostaje
  na miejscu, albo trafia do kosza razem z usuwanym folderem, a jej autor dostaje
  powiadomienie; z kosza da się ją przywrócić.
- **Niezmiennik I4** (`checkTrashSawContent` w `test/oracles.ts`): plik z bieżącą treścią
  leży w koszu tylko wtedy, gdy (a) wyrzucający widział tę treść, albo (b) plik trafił do
  kosza razem z folderem (wyrzucony węzeł to folder nad plikiem, nigdy sam plik) i autor
  treści dostał `unseen_trashed_with_folder` z tego wpisu. Treść dopisana po wyrzuceniu
  nie może zostać w koszu (reguła 3). „Da się przywrócić” pilnuje
  `checkNoSilentLoss`: wersja znika tylko przez purge autora, który ją widział (Q3).
- **Q2 bez zmian:** wyrzucenie samego pliku z niewidzianą treścią jest pomijane,
  zdarzenie ciche.
- Kod reguł się nie zmienił (wersja reguł zostaje 2). Doszły testy scenariusza z #11
  (`test/decisions.test.ts`) i mutacja „opcja 2” w `scripts/mutation-check.py`.

## Q2. Kosz pliku, który w międzyczasie dostał nową treść: pomijany, po cichu
Decyzja: wariant 1 bez powiadomienia. `trash` jest pomijany, plik zostaje z nową
wersją. Zdarzenie `trash_skipped_unseen_content` zostaje w wynikach (deterministyczne,
tanie), ale z `silent: true`, więc UI domyślnie go nie pokazuje. Lista cichych kodów:
`SILENT_NOTICE_CODES` (zmiana to jedna linia, nie zmienia stanu, więc nie wymaga
podbicia reguł). Ciche jest też podsumowanie grupy, jeśli wszystkie pominięcia w niej
były ciche.

## Q3. Purge, gdy poddrzewo ma zmiany niewidziane przez autora: częściowy
Decyzja: wariant 3 (zmiana względem tymczasowego „pomiń cały purge”).
- Purge usuwa to, co autor widział. Węzeł z niewidzianym miejscem (`placed`) albo treścią
  zostaje w koszu z całym poddrzewem; foldery na ścieżce do niego zostają jako pojemniki,
  żeby nic nie zostało sierotą. Niewidziana sama zmiana nazwy nie chroni.
- Licznik 30 dni liczy się od nowa od `serverTime` operacji purge. Technicznie:
  `trashed.at` najwyższego węzła w koszu na ścieżce (ten, który czyta `expiredTrash()`).
  Skutek uboczny: gdy purge dotyczył węzła wewnątrz folderu w koszu, ten folder i jego
  pozostała zawartość też dostaje nowe 30 dni.
- Powiadomienie dla autora purge: `purge_kept_unseen`, `items` = ID węzłów, które zostały
  (korzenie zachowanych poddrzew, posortowane). UI: „w koszu zostało N elementów
  zmienionych po tym, jak go otworzyłeś”.
- Wynik `applied` (część się usunęła). Opróżnianie kosza jako grupa korzysta z Q9:
  element przywrócony w międzyczasie jest pomijany (`purge_not_in_trash`), reszta się
  usuwa.

## Q4. Kto czyści kosz po 30 dniach (polityka klienta, etap 2)
Rdzeń bez zmian: `expiredTrash()` wskazuje kandydatów. Do implementacji w kliencie
(etap 2): domyślnie czyści urządzenie główne (desktop / główna karta), jak przy
snapshotach. Jeśli nikt nie czyścił przez 7 dni, może to zrobić dowolne urządzenie.
Zawsze: urządzenie w pełni zsynchronizowane (ma cały log), tylko węzły > 30 dni w koszu,
nie na łączu taryfowym.

## Q5. Nazwy: NFC i wielkość liter (bez zmian)
NFC robi klient przy tworzeniu operacji (`normalizeName`); `apply()` nie normalizuje
(tablice NFC zależą od silnika). Inne repliki przy nazwie nie-NFC tylko ostrzegają, nie
odrzucają. Wielkość liter: zamrożona tabela case-fold (Unicode 17.0, `casefold-table.ts`).
Backlog (np. import z macOS): zamrożona tabela NFC w regułach, jak casefold, z podbiciem
`RULES_VERSION`.

## Q6. Kopia konfliktowa: czas lokalny autora przegranej wersji
Decyzja: wariant 3. `raport (konflikt, Laptop, 2026-09-29 16.05).docx`, bez „UTC”.
- Koperta operacji ma pole `tzOffsetMin` (przesunięcie strefy autora w minutach, CEST =
  120, liczba całkowita z zakresu ±1080; brak = 0, poza zakresem = `invalid_op`).
  `Replica` wpisuje je sama (`ReplicaOptions.tzOffsetMin`, domyślnie strefa środowiska JS).
- `FileVersion` zapamiętuje `tzOffsetMin` wersji, a nazwa kopii to
  `createdAt + tzOffsetMin` formatowane wyłącznie getterami UTC, więc każda replika daje
  identyczną nazwę niezależnie od własnej strefy.
- `tzOffsetMin` należy do zaszyfrowanej części koperty, razem z `createdAt` i `device`.
  Jawne dla serwera są tylko `opId`, `rulesVersion`, `baseSeq` i `leaseGuard` (kontrakt
  §3.3), więc w metadata only serwer nie poznaje strefy urządzenia.

## Q7. Konflikt treści: brak `baseVersionId` = konflikt, ale identyczna treść = brak konfliktu
Decyzja: wariant 1 z wyjątkiem. Gdy nowa wersja ma ten sam hash treści co bieżąca, nie
powstaje kopia (`content_identical`, ciche), późniejsza wersja zostaje bieżącą, a
poprzednia jest zwalniana jak przy zwykłej zamianie (`superseded`).
- Hasha wcześniej nie było, dodane pole `ContentRef.plaintextSha256`: SHA-256 plaintextu
  całego pliku, hex małymi literami. Liczy go klient wgrywający plik w trakcie
  strumieniowania plaintextu przez chunker, przed szyfrowaniem. Jest tylko w
  zaszyfrowanym payloadzie operacji i w (zaszyfrowanym) drzewie, serwer go nie widzi.
  Nie jest to `ciphertextHash` z manifestu discordrive (ten zależy od klucza i nonce).
- Pole opcjonalne: gdy brak hasha po którejkolwiek stronie, obowiązuje zwykła reguła 7.
- Wyrocznia „treść nie ginie bez usunięcia” uznaje zamianę na identyczną treść za
  dozwoloną.

## Q8. Jawne ID uploadów dla serwera (`leaseGuard`) (bez zmian)
Akceptowalne. Najpierw `upload_abort` w logu, potem kasowanie fragmentów.

## Q9. Operacje grupowe: pomijane elementy wypadają, wycofanie tylko przy błędzie
Decyzja: wariant 2.
- Każdy element grupy stosowany jest we własnej nakładce. Element `skipped` (reguła
  konfliktu) wypada bez śladu, reszta się stosuje, a na końcu jest jedno powiadomienie
  `group_members_skipped` z listą indeksów (`items`).
- Element `rejected` (błędna operacja: zła nazwa, folder systemowy, zły upload itp.)
  wycofuje całą grupę (`group_rolled_back`); powiadomienia wcześniejszych elementów są
  wtedy usuwane, bo opisywały zmiany, których nie ma.
- Wynik grupy: `applied`, jeśli coś się zmieniło; `skipped`, jeśli wszystkie elementy
  zostały pominięte; `noop`, jeśli nic do zrobienia.

## Q10. Błędne operacje w logu (bez zmian) + licznik w etapie 2
Deterministyczne no-op z `invalid_op`, nie blokuje logu. Etap 2 (klient): licznik
`invalid_op` na urządzenie i komunikat w UI po N (np. 5) błędach.

## Q11
Nieaktualne (poprawione w koncepcie wcześniej).

## Etap 2 (metadata only, `@ddv4/metadata-client`)

### #12 (2026-10-06): kanały z webhookami przy zakładaniu konta
Limit zapytań Discorda jest na kanał (~30 wiadomości/min, koncept §7). Kreator wymaga
1 kanału z webhookiem i zachęca do 3–4. Klient rozkłada fragmenty po kanałach z sejfu, z
osobnym limiterem na kanał (`ChannelPacer`, `vaultAdvice`).

### #13 (2026-10-06): logowanie urządzeń
Para Ed25519 na urządzenie; serwer trzyma tylko klucze publiczne. Logowanie = podpis
losowego, jednorazowego wyzwania → krótki token sesji. Parowanie dopisuje klucz publiczny
nowego urządzenia podpisem już zalogowanego. Zestaw ratunkowy rejestruje nowe urządzenie
kluczem ratunkowym wyprowadzonym z klucza konta (część publiczna znana serwerowi od
założenia konta). Odwołanie = usunięcie klucza publicznego (i sesji). Szczegóły
wykonawcze (rozstrzygnięte samodzielnie): wyzwanie 2 min, sesja 1 h, każda wiadomość do
podpisu zawiera cel, ID instancji serwera i wyzwanie; odwołanie i dodanie urządzenia
wymagają świeżego podpisu, sama sesja nie wystarcza.


### Rozstrzygnięte samodzielnie 2026-10-09 (zlecenie: preview + setup)
Decyzje wykonawcze, których koncept i zlecenie nie przesądzały. Żadna nie zmienia kontraktu §3.3.

- **Nazwy urządzeń: zaszyfrowane kluczem konta** (podklucz HKDF `ddn-device-name-v1`, AAD =
  konto + ID urządzenia). Serwer trzyma nieczytelny blob (`devices.name_sealed`), więc §3.3
  bez zmian. Nazwę ustawia samo urządzenie po pierwszym zalogowaniu; każde urządzenie konta
  może zmienić nazwę dowolnego urządzenia tego konta.
- **Rozszerzenie nazw załączników na Discordzie: `.txt` zamiast `.bin`.** Pomiar na żywo
  2026-10-09 (a test Discord server): CDN Discorda wysyła `Access-Control-Allow-Origin` tylko dla
  części typów, wybieranych po rozszerzeniu (`.txt/.log/.json/.csv/.webm/.mp4/.png` tak;
  `.bin/.dat/.zip`/bez rozszerzenia nie), niezależnie od nagłówków żądania i `Content-Type`
  podanego przy wysyłce. Przeglądarka nie odczyta więc fragmentu `.bin` (koncept §3.1 z
  2026-09-23 zakładał `ACAO: *` dla wszystkiego). Bajty bez zmian (ten sam szyfrogram, format
  §6.2/discordrive zgodny), zmienia się tylko nazwa pliku. `.txt` sprawdzony do 10 MiB i
  z `Range` (206 + ACAO). Uwaga: przy `Accept-Encoding: br` CDN kompresuje `.txt` w locie;
  przeglądarka i `fetch` w Node dekompresują przezroczyście, więc treść jest ta sama.
  Ryzyko: Discord może zmienić listę typów z CORS; wtedy rezerwą jest pobieranie przez
  serwer instancji (jak w e2ee) albo inna lista rozszerzeń. Do wpisania w koncept §7
  (propozycja dla właściciela). Stare `.bin` (testy sprzed zmiany) są dalej czytelne z
  Node/CLI, ale nie z przeglądarki.
- **Rejestracja na instancji publicznej: jednorazowe kody zaproszenia** (`ddn-inv-XXXX-…`,
  16 znaków Crockford base32 = 80 bitów, ważne 7 dni, w bazie tylko SHA-256, wpisywanie
  odporne na wielkość liter/myślniki/O↔0). Kod jest zużywany atomowo przed założeniem konta
  i oddawany, gdy założenie się nie uda. Polityki: `invite` (domyślna w `setup`), `open`
  (z ostrzeżeniem), `closed`. Testy w pamięci dalej mają `open`.
- **Limity zapytań per IP** (kubełki w pamięci): wyzwania/logowanie 60 na start + 60/min,
  zakładanie konta i zestaw ratunkowy 5 + 2/min, skrzynka parowania 60 + 90/min, linki
  udostępniania 60 + 120/min. IP klienta z `X-Forwarded-For` (skrajnie prawy wpis) tylko od
  adresów z `trustProxy` (preview: 192.0.2.1), w przeciwnym razie adres gniazda.
- **Jeden proces, jeden origin**: `/v1/...` = API, reszta = zbudowane `apps/web-mo/dist`
  (`/s/<id>` i ścieżki bez rozszerzenia → `index.html`). CSP: `connect-src 'self'` + Discord
  (API i CDN), `script-src 'self' 'wasm-unsafe-eval'`, `frame-ancestors 'none'`. Konfiguracja
  dla strony przez `/config.js` (bez sekretów). Websocket przyjmuje ten sam origin (Origin
  host = Host) albo allow-listę CORS (`publicUrl`).
- **Konfiguracja instancji: jeden plik `<katalog danych>/config.json` (0600, katalog 0700)**,
  domyślnie `~/.local/share/discordrive-next/`. Serwer czyta tylko jego; token bota tylko
  tam (podawany interaktywnie bez echa albo plikiem `--bot-token-file`, nigdy w linii
  poleceń; `--bot-token` jest odrzucany). Baza `ddn.db` 0600 (umask 077).
- **Zestaw ratunkowy wymuszony raz na konto** zaraz po pierwszym kanale (nie da się zamknąć
  Esc, „Dalej” dopiero po zaznaczeniu potwierdzenia). Wtedy powstaje wiadomość wskaźnikowa
  (ID w sejfie webhooków, pole `pointer`), a główna karta zaczyna snapshoty wg §6.2
  (telefon = tylko segmenty). Urządzenia dołączone parowaniem albo zestawem nie są pytane
  ponownie; zestaw da się zawsze pokazać z panelu Urządzenia.
- **Udostępnianie (§3.7)**: klient wysyła adresy załączników jednego pliku (manifest +
  fragmenty) i `meta` zaszyfrowane kluczem tego pliku (nazwa, rozmiar, SHA-256), plus
  notatkę dla właściciela zaszyfrowaną kluczem konta (podklucz `share-note`). Link
  `/s/<22 znaki>#<klucz pliku base64url>`. Serwer odświeża linki botem (`refresh-urls`, po 50),
  trzyma odświeżone linki w pamięci do 1 h przed ich wygaśnięciem, przyjmuje tylko odpowiedzi
  z `cdn.discordapp.com`/`media.discordapp.net`. Wyłączenie linku = 404 dla nowych
  odbiorców (ograniczenia cofnięcia opisane w UI). Bez tokenu bota udostępnianie jest
  wyłączone (503, przycisk ukryty).
- **Nowe urządzenie przez QR**: kod QR na nowym urządzeniu zawiera link
  `https://<instancja>/#pair=ddn-pair1:…` (aparat telefonu otwiera aplikację na zalogowanym
  urządzeniu i wypełnia pole), obok tekst do wklejenia. Nowe urządzenie odpytuje skrzynkę co
  2 s, kod ważny 10 min, potem oba ekrany pokazują 6 cyfr i nowe urządzenie zapisuje konto
  dopiero po potwierdzeniu „ten sam kod”.
- **Stronicowanie**: 50 pozycji na stronę, kursor keyset `(name_key, id)` w obu rodzajach kart
  (OPFS i kopia w pamięci), bez cięcia po stronie UI.

### Rozstrzygnięte samodzielnie 2026-10-09, dopisek (test właściciela „jak zwykły użytkownik”)
- **Domyślny scenariusz `setup` = „tylko ten komputer”**: `http://localhost:<port>`, bind
  127.0.0.1, rejestracja otwarta (nikt spoza komputera nie dosięgnie serwera). Scenariusz
  „serwer z domeną” (adres https) dalej domyślnie z kodem zaproszenia. Zmiana scenariusza przy
  ponownym `setup` przestawia rejestrację na bezpieczną domyślną dla nowego scenariusza.
  Sprawdzone: na localhost `isSecureContext = true`, service worker steruje stroną i odtwarza
  wideo bez TLS.
- **Instalacja = pierwsze uruchomienie.** `npm run setup` w świeżym klonie (bez `npm install`)
  sam wykonuje `npm ci --workspace @ddv4/ddn-server` (ok. 85 pakietów, 3 s w sieci domowej),
  czyli tylko to, czego potrzebuje dysk, bez Prismy, argon2 i reszty starego ddv4 (pełne
  `npm install` monorepo nie jest potrzebne). Launcher (`bin/discordrive.mjs`) jest w czystym
  JS, żeby sprawdzić wersję Node (≥ 22.13: `node:sqlite` bez flagi) zanim cokolwiek się załaduje.
- **Polecenia dla użytkownika przez npm** (`npm run setup`, `npm start`, `npm run doctor`,
  `npm run invite`): działają tak samo w PowerShellu i powłokach POSIX, bez globalnej
  instalacji. Stary `npm start` monorepo (API + frontend ddv4) przeniesiony na `start:legacy`,
  stary `setup` na `setup:legacy`.
- **Katalog danych wg platformy**: XDG (`~/.local/share`), macOS `~/Library/Application
  Support`, Windows `%LOCALAPPDATA%`; nadpisanie `DISCORDRIVE_DATA_DIR`. Uprawnienia 0600/0700 i
  umask tylko poza Windows (tam domyślne ACL profilu użytkownika). systemd tylko na Linuksie;
  gdzie indziej `setup` proponuje start w tym oknie (Ctrl+C zatrzymuje).
- **Bot do udostępniania w `setup`**: wybór „Pomiń na razie” domyślny, z wyjaśnieniem, co się
  traci (tylko linki do plików), i instrukcją Developer Portal przy „Skonfiguruj teraz” oraz w
  podpowiedzi „włączysz w npm run setup”.
- **Instrukcja Discorda w aplikacji** (kreator kanałów): 5 kroków od konta przez własny
  serwer, kanał i webhook (gdzie kliknąć), że URL webhooka to sekret, czemu 3–4 kanały, oraz
  uwaga o regulaminie Discorda (koncept §6.5 „Ryzyko”: informować przy zakładaniu konta).

### Rozstrzygnięte samodzielnie 2026-10-12 (zlecenie: angielski domyślnie + przełącznik PL)
- **Kolejność języka w przeglądarce**: wybór użytkownika (`localStorage` `ddn.lang`) >
  `language` instancji (`config.json`, przekazany w `/config.js` jako `DDN_CONFIG.language` i w
  `/v1/health`) > angielski. `navigator.language` celowo nie jest brany pod uwagę (test w
  Chromium z `locale: pl-PL` sprawdza, że start jest po angielsku).
- **Przełącznik EN/PL** jest w nagłówku (widoczny na ekranie startowym i w aplikacji), działa
  bez przeładowania: statyczne teksty przez `data-i18n*`, dynamiczne przez ponowny render.
  Odbiorca linku `/s/…` też ma przełącznik (ten sam nagłówek).
- **Kolejność języka w CLI**: `--lang` > `DISCORDRIVE_LANG` > `language` z `config.json` >
  angielski. Kreator pyta o język jako pierwszy (Enter = zapisany albo English); `--yes` bez
  `--lang` zostawia zapisany (nowa instancja: `en`). Tryb polski akceptuje `t`/`tak`/`nie`,
  ale zawsze pokazuje `[Y/n]` / `[y/N]`; tryb angielski nie akceptuje `t`.
- **Teksty bibliotek (`@ddv4/metadata-client`) po angielsku** (`vaultAdvice().message`,
  `LogObserver.message`, domyślna nazwa urządzenia `device`). Aplikacja przeglądarkowa składa
  porady o kanałach z pól (`ok`, `suggestMore`, `channels`, `sharedChannels`) we własnym
  słowniku, więc tekst z biblioteki służy tylko CLI/logom.
- **Kody błędów serwera** (`invite_required`, `signup_closed`, `rate_limited`, …) zostają w
  API jako kody; UI tłumaczy znane kody i dopisuje kod w nawiasie (łatwiej szukać w zgłoszeniu).
- **`GET /v1/vault` dla nowego konta: 200 `{revision: 0, blob: null}`** zamiast 404 (404
  wyglądał w konsoli przeglądarki jak błąd). Klient przyjmuje obie odpowiedzi (stary serwer z
  404 dalej działa).
- **Nagłówek: mniej technicznych etykiet.** Zamiast „karta główna/pomocnicza” i „pamięć
  podręczna/trwała” jest jeden chip „synced/zsynchronizowano” ze szczegółami w tooltipie;
  osobny chip pojawia się tylko w karcie pomocniczej („open in another tab” / „otwarte w innej
  karcie”), bo ona startuje wolniej. Stan karty dla testów: `data-tab-role` na `[data-ddn=status]`.
- **Paginacja ‹ › ukryta przy jednej stronie** (≤ 50 pozycji); licznik pozycji zostaje.
- **Instrukcja Discorda po angielsku** wg aktualnych nazw z dokumentacji/supportu Discorda
  (Add a Server → Create My Own → For me and my friends → Create; Text Channels + → Create
  Channel; Edit Channel → Integrations → Webhooks → New Webhook (pierwszy raz: Create Webhook)
  → Copy Webhook URL). Źródła: support.discord.com „How do I create a server?”, „Intro to
  Webhooks”, „Server Integrations Page”. Wersja polska dostała tę samą uwagę o „Utwórz webhook”.
- **README**: `README.md` po angielsku (Quick start na górze), `README.pl.md` po polsku, linki w
  obie strony; stara dokumentacja ddv4 tylko w `README.md`.

### Rozstrzygnięte samodzielnie 2026-10-12, dopisek: kreator jako TUI
- **Biblioteka: `@clack/core` 1.5.1 + `@clack/prompts` 1.8.1** (przypięte dokładnie, w
  lockfile; razem 6 pakietów: sisteransi, fast-wrap-ansi, fast-string-width i pochodne, bez
  Reacta/Ink). Gotowe `select/confirm/text` z `@clack/prompts` mają angielskie podpowiedzi
  klawiszy na sztywno i znacznik ●, więc pola są rysowane własnym `render()` na prymitywach
  `@clack/core` (SelectPrompt, ConfirmPrompt, TextPrompt, PasswordPrompt): ◉/○, Yes/No, pomoc
  klawiszy i komunikaty walidacji z naszego słownika EN/PL. Z `@clack/prompts` używamy
  `spinner`, `note` (ramki), `log`, `cancel`, `outro`.
- **Jedna logika kreatora, dwa interfejsy** (`Prompter`): `tuiPrompter` na prawdziwym
  terminalu, `ttyPrompter` (numery, `[Y/n]`) bez TTY, przy `TERM=dumb`, `CI`, `--yes` i
  `DISCORDRIVE_PLAIN=1`. Testy z potokiem dalej przechodzą przez wersję tekstową.
- **Walidacja na żywo** zamiast pętli „zły wpis → pytanie od nowa”: adres publiczny, adres
  nasłuchu, port (zakres + zajęty, z podpowiedzią wolnego), katalog danych (zapis), token bota
  (sprawdzany w Discordzie, `GET /users/@me`, w czasie walidacji „sprawdzam…”).
- **Multi-select (◼/◻) nie jest użyty**: żadne pytanie kreatora nie wymaga dziś wielu wyborów
  (wyłączone tryby e2ee/plain są pokazane jako nieaktywne opcje, kursor je pomija).
- **Esc/Ctrl+C**: `Cancelled` → „Setup cancelled. Nothing was saved.”, kod wyjścia 130 (jak
  SIGINT), kursor przywrócony. Ctrl+C po starcie dysku w oknie dalej zatrzymuje dysk (kod 0).
- **`DISCORDRIVE_NO_SYSTEMD=1`** wyłącza pytanie o usługę systemd (testy i demo na maszynie,
  na której działa już instancja jako usługa: kreator z testu nie może nadpisać jej unitu).
