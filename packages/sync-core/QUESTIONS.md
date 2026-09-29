# @ddv4/sync-core: pytania do właściciela (etap 1)

Tam, gdzie koncept nie rozstrzygał, przyjąłem zachowanie **tymczasowe**,
oznaczone w kodzie jako `PROVISIONAL` albo opisane poniżej. Nie zmieniałem
konceptu. Każda z tych decyzji siedzi w jednym miejscu `src/apply.ts`, więc
zmiana to kilka linii i jeden test.

## Q1. Reguła 4 w odwrotnej kolejności (usunięcie folderu PO niewidzianym dodaniu)
Koncept: „plik dodany do usuniętego folderu trafia do Odzyskane”. To opisuje kolejność
„najpierw kosz, potem dodanie”. Przy kolejności odwrotnej (A dodaje plik, B usuwa folder,
nie widząc tego pliku) plik trafiłby do kosza razem z folderem, a praca A zniknęłaby
z widoku bez wiedzy A.

**Przyjęte:** przy wrzucaniu folderu do kosza węzły, które autor usunięcia nie widział
(dodane, przeniesione albo przywrócone po jego `base_seq`, także z nową treścią), trafiają
do „Odzyskane” zamiast do kosza (`rescueUnseen`). Stan wynikowy jest więc taki sam
niezależnie od kolejności. **Pytanie:** czy tak ma być?

## Q2. Kosz pliku, który w międzyczasie dostał nową treść (reguła 3 w odwrotnej kolejności)
Reguła 3: nowa treść wyciąga plik z kosza. W odwrotnej kolejności (A zapisuje nową wersję,
B wrzuca plik do kosza, nie widząc jej) koncept nic nie mówi.

**Przyjęte:** `trash` jest pomijany z powiadomieniem `trash_skipped_unseen_content`
(zasada 5.2.3: praca nie ginie po cichu), co daje ten sam wynik co reguła 3 w kolejności
prostej. **Alternatywa:** plik idzie do kosza, a A dostaje powiadomienie. Który wariant?

## Q3. Trwałe usunięcie (purge), gdy poddrzewo ma zmiany niewidziane przez autora
Przykład: A czyści kosz, a B w tym czasie wgrał nową wersję pliku, który w nim leżał
(reguła 3 go przywróciła), albo dodał plik do usuwanego folderu.

**Przyjęte:** cały `purge` jest pomijany (`purge_skipped_unseen_changes`), jeśli jakikolwiek
węzeł poddrzewa ma niewidzianą przez autora treść albo miejsce. Purge dotyczący wyłącznie
znanych rzeczy działa normalnie. Klient może ponowić czyszczenie, kiedy zobaczy zmiany.
**Pytanie:** czy zamiast tego purge ma usuwać resztę, a tylko niewidziane węzły
przenosić do „Odzyskane”? (Trudniejsze, bo to operacja grupowa na drzewie.)

## Q4. Automatyczne czyszczenie kosza po 30 dniach vs. zasada 3 (nowa treść wyciąga z kosza)
`expiredTrash()` wskazuje węzły, które leżą w koszu dłużej niż 30 dni. Purge musi jednak
wykonać któryś klient (w metadata only serwer nie może, §3.6). Po Q3 taki purge pominie
węzły z niewidzianymi zmianami. **Pytanie:** który klient ma czyścić kosz? Proponuję
„główną kartę” / desktop, tak samo jak snapshoty (§6.2).

## Q5. Nazwy: normalizacja Unicode i porównywanie bez wielkości liter
Koncept: „porównanie bez rozróżniania wielkości liter i z normalizacją Unicode”.
- **Normalizacja (NFC):** robi ją klient przy tworzeniu operacji (`normalizeName`), a w logu jest
  już nazwa znormalizowana. `apply()` nie normalizuje, bo tablice NFC różnią się między
  silnikami JS/ICU, a wtedy repliki mogłyby się rozjechać. Konsekwencja: stary albo
  zepsuty klient może zapisać nazwę w NFD, która nie zderzy się z tą samą nazwą w NFC.
- **Wielkość liter:** zamrożona tabela case-fold (Unicode 17.0, `casefold-table.ts`) zamiast
  `toLowerCase()`, z tego samego powodu. „ß” ≠ „ss” (jak w NTFS), „ς”=„σ”, „İ” → „i̇”.
**Pytanie:** czy w bramce serwera odrzucać operacje z nazwą nie-NFC? (W metadata only
serwer nie widzi nazw, więc to musiałaby być walidacja po stronie klientów, czyli
tylko ostrzeżenie.)

## Q6. Kopia konfliktowa (reguła 7): czas i urządzenie w nazwie
Format: `nazwa (konflikt, <urządzenie>, <data>).ext`, data w **UTC**
(`2026-09-29 14.05 UTC`, bez `:` ze względu na Windows). Strefa czasowa urządzenia
dawałaby różne nazwy na różnych replikach. Data pochodzi z zegara autora przegranej
wersji i służy tylko do wyświetlania (§5.2.1). **Pytanie:** UTC w nazwie jest OK, czy wolisz
czas lokalny w UI (np. w kolumnie „konflikt”), a w nazwie tylko datę bez godziny?

## Q7. Konflikt treści, gdy autor nie znał żadnej wersji (`baseVersionId = null`)
Traktowane jak konflikt: bieżąca wersja idzie do kopii. **Pytanie:** OK?

## Q8. Reguła 8: kolejność „abort przed kasowaniem” i dzierżawa jako strażnik na serwerze
Koncept: „sprzątanie (kasowanie fragmentów + upload_abort) po wygaśnięciu dzierżawy”.
**Przyjęte:** najpierw `upload_abort` w logu, dopiero potem kasowanie fragmentów.
Odwrotna kolejność tworzy okno, w którym commit mógłby przejść dla już skasowanych
fragmentów. Dodatkowo operacje dotykające uploadu niosą jawną listę `leaseGuard`
(ID uploadów), a serwer przyjmuje je tylko od aktualnego posiadacza dzierżawy.
Serwer widzi więc ID uploadów jawnie, co i tak wynika z §3.3 („dzierżawy uploadów”).
**Pytanie:** czy ID uploadu jawne dla serwera jest akceptowalne (to losowy identyfikator,
bez nazw i rozmiarów)?

## Q9. Operacje grupowe: „w całości albo wcale” także przy pominięciu przez regułę
Jeśli jakakolwiek pod-operacja zostanie pominięta przez regułę (np. move do folderu
w koszu, reguła 5) albo odrzucona, **cała grupa jest wycofywana** (`group_rolled_back`).
To najprostsza wykładnia §4. Skutek uboczny: przeniesienie 1000 plików, z których jeden
został w międzyczasie wyczyszczony, nie przeniesie niczego. **Alternatywa:** pomijać
tylko pod-operacje „skipped”, a wycofywać grupę wyłącznie przy „rejected”. Którą wersję?

## Q10. Nieprawidłowe operacje w logu
Operacja błędna semantycznie (np. zła nazwa, zapis do folderu systemowego, duplikat ID
węzła) zostaje w logu i jest stosowana jako deterministyczne no-op z powiadomieniem
`invalid_op`. Nie blokuje innych replik. W metadata only serwer nie może jej zweryfikować
przed zapisem, bo payload jest zaszyfrowany. OK?

## Q11. Sprzeczność w dzienniku decyzji konceptu (sekcja 9)
Ostatni wpis (2026-09-29, „opt-in przez wpuszczenie bota”) przeczy wcześniejszemu
wpisowi z tego samego dnia i sekcji 3.7 („bez wpuszczania bota”). Wygląda na nieaktualny.
Etapu 1 to nie dotyczy, zgłaszam do poprawy w koncepcie.
