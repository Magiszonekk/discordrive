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

