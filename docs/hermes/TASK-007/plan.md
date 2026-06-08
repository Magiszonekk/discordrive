# Pokemon Emerald support in `pokemon-agent` — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Dodać minimalne, realnie użyteczne wsparcie Pokemon Emerald w `pokemon-agent`, tak aby backend zwracał prawdziwy stan gry dla ROM-u Emerald/GBA zamiast błędów `NotImplementedError` i błędnej identyfikacji jako FireRed.

**Architecture:** Zamiast obchodzić problem przez osobny bridge lub vision-only loop, rozszerzamy istniejącą architekturę `pokemon-agent`: poprawiamy wykrywanie ROM-u, dodajemy dedykowany reader Emerald oraz wynosimy wspólne prymitywy Gen 3 do współdzielonego modułu pomocniczego. Pierwszy pionowy slice ma dostarczyć poprawne `metadata`, `map`, `player` i `dialog`, bo to najszybciej odblokuje sensowną nawigację i podstawowe decyzje Hermesa; `party`, `battle`, `bag` i `flags` etapujemy później.

**Tech Stack:** Python 3.11, FastAPI, mGBA/pygba, lokalny HTTP API `pokemon-agent`, ręczne smoke testy (`test_server.py`, `test_imports.py`, endpointy `/health`, `/state`, `/action`), ROM Emerald USA/Europe.

---

## Current context / assumptions

- Repo gry: `/home/ubuntu/pokemon-agent`
- Działający GBA env: `/home/ubuntu/pokemon-agent/.venv311`
- ROM: `/home/ubuntu/pokemon-agent/roms/Pokemon - Emerald Version (USA, Europe).gba`
- Dziś `pokemon_agent/cli.py` i `pokemon_agent/server.py` wykrywają każde `.gba` jako `firered`.
- `pokemon_agent/memory/firered.py` to Phase 2 stub; wszystkie główne sekcje stanu rzucają `NotImplementedError`.
- `pokemon_agent/memory/red.py` jest jedynym kompletnym przykładem contractu `GameMemoryReader`.
- `pokemon_agent/emulator.py` umie już czytać pamięć GBA, robić screenshoty i wykonywać inputy.
- Użytkownik docelowo chce grać w Emerald i preferować startera `Torchic`, ale to jest logika agenta; na potrzeby tego taska najpierw trzeba odblokować wiarygodny stan gry.

## Success criteria for implementation

Minimalne ukończenie pierwszej iteracji oznacza:
1. `pokemon-agent info --rom <emerald.gba>` wykrywa `emerald`, nie `firered`.
2. `pokemon-agent serve --rom <emerald.gba>` ustawia reader Emerald i `/state.metadata.game` raportuje Emerald.
3. `/state` zwraca bez `NotImplementedError` sekcje:
   - `metadata`
   - `map`
   - `player`
   - `dialog`
4. `player.position`, `player.name`, `player.money`, `player.badges` oraz `map.map_id/map_name` są sensownie wypełnione dla uruchomionego save/state.
5. `dialog.active` reaguje przynajmniej na podstawowe okna tekstowe / blokadę wejścia.
6. Sekcje jeszcze niegotowe (`party`, `bag`, `battle`, `flags`) mają jasny status etapowania — albo pozostają jako świadome `NotImplementedError`, albo zwracają ograniczony, ale poprawny subset.

---

## Proposed approach

### Phase 0 — Stabilizacja detekcji i struktury kodu
Najpierw poprawiamy klasyfikację ROM-ów GBA, bo dziś cały pipeline startuje od błędnego założenia „`.gba` == FireRed”. W tym etapie nie dotykamy jeszcze decryptu party.

### Phase 1 — Minimalny vertical slice Emerald
Implementujemy tylko to, co daje Hermesowi praktyczną wartość do sterowania grą poza walką:
- poprawny `game_name`
- podstawowe `player`
- `map`
- `dialog`

To wystarczy, żeby:
- odróżnić Emerald od FireRed,
- wiedzieć gdzie postać stoi,
- widzieć, czy dialog jest aktywny,
- poruszać się po intro i mapach przy wsparciu screenshotów.

### Phase 2 — Team / inventory / battle essentials
Po odblokowaniu nawigacji dokładamy:
- `party`
- minimalny `battle`
- podstawowy `bag`

To etap trudniejszy, bo wymaga poprawnego wejścia w Gen 3 structs i decrypt danych Pokémonów.

### Phase 3 — Flags / polish / map naming
Na końcu dopieszczamy:
- story flags
- szerszą bazę map names
- lepsze smoke testy i dokumentację

---

## Files likely to change

### Create
- `/home/ubuntu/pokemon-agent/pokemon_agent/memory/emerald.py`
  - nowy reader Emerald implementujący `GameMemoryReader`
- `/home/ubuntu/pokemon-agent/pokemon_agent/memory/gen3.py`
  - współdzielone helpery Gen 3: text decoding, save block dereference, decrypt helpers, ewentualne enums/tabele
- `/home/ubuntu/pokemon-agent/test_emerald_state.py`
  - dedykowany smoke test dla `/state` na ROM-ie Emerald
- `/home/ubuntu/pokemon-agent/docs/emerald-notes.md` *(opcjonalnie, ale zalecane)*
  - notatka z offsetami, assumptions i źródłami adresów

### Modify
- `/home/ubuntu/pokemon-agent/pokemon_agent/cli.py`
  - poprawa `_detect_game_type()`
- `/home/ubuntu/pokemon-agent/pokemon_agent/server.py`
  - poprawa `_detect_game_type()` i wybór readera `emerald`
- `/home/ubuntu/pokemon-agent/pokemon_agent/memory/firered.py`
  - ewentualne wyciągnięcie wspólnych helperów do `gen3.py`; nie próbować kończyć pełnego FireRed przy okazji
- `/home/ubuntu/pokemon-agent/pokemon_agent/memory/__init__.py`
  - eksporty, jeśli projekt zacznie ich używać
- `/home/ubuntu/pokemon-agent/README.md`
  - sekcja statusu wsparcia Emerald i instrukcja smoke testów
- `/home/ubuntu/pokemon-agent/test_server.py`
  - opcjonalne rozszerzenie o flow Emerald po wprowadzeniu nowego readera

---

## Task-by-task plan

### Task 1: Udokumentować źródła prawdy dla Gen 3 / Emerald

**Objective:** Zebrać i ustabilizować dokładne założenia o pamięci Emerald przed pisaniem kodu.

**Files:**
- Create: `/home/ubuntu/pokemon-agent/docs/emerald-notes.md`
- Reference only: `/home/ubuntu/pokemon-agent/pokemon_agent/memory/firered.py`
- Reference only: `/home/ubuntu/pokemon-agent/pokemon_agent/memory/red.py`

**Step 1: Spisać minimalny zestaw danych potrzebnych w pierwszym slice**
- player name
- money
- badges
- current map id / map group
- player x/y
- dialog active

**Step 2: Spisać per pole, czy pochodzi z SaveBlock1, SaveBlock2, czy live WRAM/IWRAM**
To ważne, bo pozycja i część UI state niekoniecznie powinny być czytane wyłącznie z save blocków.

**Step 3: Zanotować niepewności**
- wersja ROM-u (USA/Europe)
- czy offsets FireRed są częściowo zbieżne, a gdzie na pewno się rozjeżdżają
- które pola można zweryfikować live przez porównanie stanu po ruchu / dialogu

**Verification:**
- notatka istnieje i da się z niej zaimplementować reader bez zgadywania nazw pól

---

### Task 2: Rozdzielić detekcję ROM-u od samego rozszerzenia pliku

**Objective:** Zamiast mapować każde `.gba` na `firered`, wykrywać Emerald po sygnaturze ROM-u / tytule w headerze.

**Files:**
- Modify: `/home/ubuntu/pokemon-agent/pokemon_agent/cli.py`
- Modify: `/home/ubuntu/pokemon-agent/pokemon_agent/server.py`
- Test: `/home/ubuntu/pokemon-agent/test_imports.py` *(lub nowy prosty smoke test CLI)*

**Implementation notes:**
- Dodać helper czytający ROM header GBA i zwracający np. `emerald`, `firered`, `unknown_gba`.
- Najprościej: czytać wewnętrzny game title / game code z ROM-u, a nie tylko extension.
- Nie rozpraszaj logiki w dwóch plikach: helper powinien mieszkać w jednym miejscu, np. `pokemon_agent/rom_detection.py` *(jeśli uznasz, że warto dodać plik)* lub być wydzielony z `cli.py`/`server.py`.

**Step 1: Napisać failing smoke test detekcji dla ROM-u Emerald**
Run: `cd /home/ubuntu/pokemon-agent && .venv311/bin/python -m pokemon_agent.cli info --rom 'roms/Pokemon - Emerald Version (USA, Europe).gba'`
Expected before fix: `Detected as: firered`

**Step 2: Wdrożyć helper detekcji**
Expected after fix: `Detected as: emerald`

**Step 3: Użyć tego samego helpera w `server.py` i `cli.py`**
Żeby `info` i `serve` nie rozjeżdżały się logiką.

**Verification:**
- `info --rom emerald.gba` pokazuje `emerald`
- dotychczasowe `.gb/.gbc` nadal wykrywają się jako `red`

---

### Task 3: Dodać szkielet dedykowanego readera Emerald

**Objective:** Wprowadzić osobną klasę readera Emerald zamiast przeciążać stub FireRed.

**Files:**
- Create: `/home/ubuntu/pokemon-agent/pokemon_agent/memory/emerald.py`
- Modify: `/home/ubuntu/pokemon-agent/pokemon_agent/server.py`
- Modify: `/home/ubuntu/pokemon-agent/pokemon_agent/memory/__init__.py` *(jeśli potrzebne)*

**Implementation notes:**
- Nazwa klasy: np. `PokemonEmeraldReader`
- Dziedziczenie: bezpośrednio z `GameMemoryReader` albo przez nowy wspólny base/helper dla Gen 3
- Na starcie wystarczy, by klasa poprawnie raportowała `game_name = 'Pokemon Emerald (USA/Europe)'`

**Step 1: Dodać nową klasę z pustymi metodami i czytelnymi `NotImplementedError`**
To pozwoli od razu sprawdzić routing readera.

**Step 2: Podłączyć ją w `server.py` dla `game_type == 'emerald'`**

**Step 3: Zweryfikować `/state.metadata.game`**
Run server i sprawdzić:
`curl http://127.0.0.1:9876/state`
Expected: metadata.game = Emerald, nawet jeśli część sekcji dalej jest pusta.

**Verification:**
- czy `/state.metadata.game` przestaje raportować FireRed
- czy wszystkie błędy pochodzą już z Emerald readera, nie FireRed stubu

---

### Task 4: Wydzielić wspólne helpery Gen 3

**Objective:** Nie duplikować trudnych elementów FireRed/Emerald i przygotować grunt pod party/bag/battle.

**Files:**
- Create: `/home/ubuntu/pokemon-agent/pokemon_agent/memory/gen3.py`
- Modify: `/home/ubuntu/pokemon-agent/pokemon_agent/memory/emerald.py`
- Modify: `/home/ubuntu/pokemon-agent/pokemon_agent/memory/firered.py`

**Helpery, które warto tam umieścić:**
- odczyt SaveBlock1 / SaveBlock2 pointerów
- dekoder tekstu Gen 3
- wspólne utility do little-endian / XOR-encrypted values
- decrypt scaffold dla party structs
- substructure order lookup

**Important:**
- Na tym etapie nie próbować „naprawić całego FireRed” — tylko wynieść to, co naprawdę wspólne.
- Jeśli któryś helper nie jest jeszcze potrzebny w Phase 1, można zostawić go jako private scaffold, ale w jednym miejscu.

**Verification:**
- `emerald.py` nie duplikuje całej masy stałych / helperów, które za chwilę przydadzą się też do FireRed

---

### Task 5: Zaimplementować `read_map_info()` dla Emerald

**Objective:** Dostarczyć pierwszy naprawdę użyteczny kawałek live state.

**Files:**
- Modify: `/home/ubuntu/pokemon-agent/pokemon_agent/memory/emerald.py`
- Create/Modify: map table w `emerald.py` lub osobnym module, jeśli urośnie
- Test: `/home/ubuntu/pokemon-agent/test_emerald_state.py`

**Scope minimum:**
- map group
- map number / map id
- proste `map_name` (nawet jeśli początkowo tylko fallback `Group X / Map Y`)

**Implementation notes:**
- Nie blokuj się na pełnej bazie nazw map. Na pierwszy przebieg wystarczy stabilny identyfikator + czytelny fallback.
- Ważniejsze od ładnej nazwy jest to, by po przejściu między mapami identyfikator realnie się zmieniał.

**Verification:**
- przejście przez warp / wejście do budynku powoduje zmianę map identifier w `/state`

---

### Task 6: Zaimplementować `read_player()` dla Emerald (minimal usable subset)

**Objective:** Zwracać podstawowe dane gracza potrzebne do sterowania i obserwacji.

**Files:**
- Modify: `/home/ubuntu/pokemon-agent/pokemon_agent/memory/emerald.py`
- Possibly modify: `/home/ubuntu/pokemon-agent/pokemon_agent/state/builder.py` *(tylko jeśli potrzeba drobnego ujednolicenia formatu)*
- Test: `/home/ubuntu/pokemon-agent/test_emerald_state.py`

**Scope minimum:**
- `name`
- `money`
- `badges`
- `badge_count`
- `position.x`
- `position.y`
- `facing` *(jeśli live address zostanie wiarygodnie ustalony; jeśli nie, oznaczyć jako `unknown` zamiast zgadywać)*
- `play_time` *(opcjonalne w minimum, jeśli offset jest pewny)*

**Implementation notes:**
- `position` musi reagować na `walk_*` z endpointu `/action`.
- Jeżeli live coords i saved coords różnią się semantyką, wybierz live coords do sterowania agentem.
- Dla badge list początkowo wystarczy count + bitmask decode; nie trzeba mieć pełnej semantyki eventowej.

**Verification:**
- po `POST /action {"actions":["walk_up"]}` pozycja zmienia się zgodnie z ruchem
- `name` i `money` nie są pustymi / oczywiście śmieciowymi wartościami

---

### Task 7: Zaimplementować `read_dialog()` dla Emerald

**Objective:** Odtwarzać kluczową informację, czy agent jest aktualnie zablokowany dialogiem / textboxem.

**Files:**
- Modify: `/home/ubuntu/pokemon-agent/pokemon_agent/memory/emerald.py`
- Test: `/home/ubuntu/pokemon-agent/test_emerald_state.py`

**Implementation notes:**
- Szukaj live UI / input lock flag zamiast zgadywania po samym ekranie.
- Jeśli nie uda się szybko ustalić jednego idealnego bitu, można zwracać ostrożny wynik oparty na 2-3 sygnałach, ale musi być jawnie opisany w kodzie i docs.

**Verification:**
- przed rozmową z NPC `dialog.active == false`
- w trakcie textboxa `dialog.active == true`
- po zamknięciu dialogu wraca do `false`

---

### Task 8: Dodać smoke test dla Emerald `/state`

**Objective:** Mieć powtarzalny test regresyjny dla minimalnego wsparcia Emerald.

**Files:**
- Create: `/home/ubuntu/pokemon-agent/test_emerald_state.py`
- Maybe modify: `/home/ubuntu/pokemon-agent/test_server.py`

**Test strategy:**
Nie zakładaj pełnego pytest suite. To repo już używa skryptowych smoke testów.

**Minimalny flow testu:**
1. Uruchom server z ROM-em Emerald i ewentualnym `--load-state`, jeśli istnieje sensowny save.
2. Poll `GET /health` aż będzie gotowy.
3. Zawołaj `GET /state`.
4. Assert / print-check:
   - `metadata.game` zawiera `Emerald`
   - `map` nie jest `None`
   - `player` nie jest `None`
   - `dialog` nie jest `None`
   - `player_error`, `map_error`, `dialog_error` nie istnieją
5. Wykonaj 1-2 ruchy i sprawdź zmianę pozycji.

**Verification:**
- skrypt kończy się exit code 0
- wynik można uruchamiać ręcznie po każdej zmianie

---

### Task 9: Dopiero potem wejść w `party`

**Objective:** Rozszerzyć reader o team state, ale nie blokować na tym pionowego slice'a.

**Files:**
- Modify: `/home/ubuntu/pokemon-agent/pokemon_agent/memory/emerald.py`
- Modify: `/home/ubuntu/pokemon-agent/pokemon_agent/memory/gen3.py`
- Test: `/home/ubuntu/pokemon-agent/test_emerald_state.py`

**Scope minimum:**
- liczba Pokémonów w party
- species
- level
- current HP / max HP
- status
- moves (nawet bez pełnego bogactwa fields)

**Hard parts:**
- PID / OTID
- XOR decrypt
- substructure reorder
- species / move tables Gen 3

**Advice:**
- Najpierw doprowadzić do tego, żeby pierwszy slot party dekodował się poprawnie i stabilnie.
- Dopiero potem uogólnić na wszystkie 6 slotów.

**Verification:**
- dane pierwszego Pokémona zgadzają się z ekranem / stanem gry
- po walce / exp level / heal HP zmienia się sensownie

---

### Task 10: Minimalne `battle` i `bag`

**Objective:** Umożliwić agentowi najprostsze decyzje w walce i basic item awareness.

**Files:**
- Modify: `/home/ubuntu/pokemon-agent/pokemon_agent/memory/emerald.py`
- Modify: `/home/ubuntu/pokemon-agent/pokemon_agent/memory/gen3.py`
- Test: `/home/ubuntu/pokemon-agent/test_emerald_state.py`

**Battle minimum:**
- `in_battle`
- `type` (wild / trainer, jeśli możliwe)
- enemy species / level / HP when available

**Bag minimum:**
- kilka pierwszych slotów item bag
- poprawny decode quantity

**Verification:**
- podczas walki `in_battle == true`
- po jej zakończeniu `false`
- item quantity nie jest losowym garbage value

---

### Task 11: Flags i polishing

**Objective:** Dodać to, co poprawia długoterminową autonomię, ale nie było konieczne do pierwszego odpalenia.

**Files:**
- Modify: `/home/ubuntu/pokemon-agent/pokemon_agent/memory/emerald.py`
- Modify: `/home/ubuntu/pokemon-agent/README.md`
- Modify: `/home/ubuntu/pokemon-agent/docs/emerald-notes.md`

**Scope:**
- story flags / badge flags cleanup
- lepsza tabela nazw map
- update README: Emerald status = partial / supported in phases, z jasnym zakresem

---

## Validation plan

### Read-only checks after each stage
- `cd /home/ubuntu/pokemon-agent && .venv311/bin/python test_imports.py`
- `cd /home/ubuntu/pokemon-agent && .venv311/bin/python -m pokemon_agent.cli info --rom 'roms/Pokemon - Emerald Version (USA, Europe).gba'`

### Server smoke checks
Start:
```bash
cd /home/ubuntu/pokemon-agent
.venv311/bin/python -m pokemon_agent.cli serve \
  --rom 'roms/Pokemon - Emerald Version (USA, Europe).gba' \
  --port 9876 \
  --data-dir '/home/ubuntu/.pokemon-agent-emerald'
```

Then verify:
```bash
python3 - <<'PY'
import requests, json
for path in ['/health', '/state']:
    r = requests.get('http://127.0.0.1:9876' + path, timeout=20)
    print(path, r.status_code)
    print(r.text[:1200])
    print('---')
PY
```

### Action/position smoke test
```bash
python3 - <<'PY'
import requests, json
base='http://127.0.0.1:9876'
state1=requests.get(base+'/state', timeout=20).json()
requests.post(base+'/action', json={'actions':['walk_up']}, timeout=20).raise_for_status()
state2=requests.get(base+'/state', timeout=20).json()
print('before', state1.get('player',{}).get('position'))
print('after ', state2.get('player',{}).get('position'))
PY
```

### Optional stronger smoke test
- `cd /home/ubuntu/pokemon-agent && .venv311/bin/python test_emerald_state.py`

---

## Risks and tradeoffs

### Risk 1: Offset mismatch for Emerald ROM revision
**Impact:** reader zwraca śmieci mimo poprawnej architektury.
**Mitigation:**
- zapisać źródło każdego offsetu w `docs/emerald-notes.md`
- weryfikować każde pole live against screenshot / action response
- nie implementować 20 pól naraz; tylko 1-2 i walidować

### Risk 2: SaveBlock fields vs live overworld state
**Impact:** pozycja lub dialog będą „stare” / niestabilne.
**Mitigation:**
- preferować live runtime addresses tam, gdzie chodzi o bieżące sterowanie
- save block zostawić dla danych trwałych (name, money, badges, inventory)

### Risk 3: Party decrypt zablokuje cały projekt
**Impact:** utkniesz na Gen 3 crypto zanim agent zrobi cokolwiek użytecznego.
**Mitigation:**
- party/battle/bag nie mogą blokować Phase 1
- dowieźć najpierw map/player/dialog

### Risk 4: Brak pełnej bazy map names
**Impact:** stan mniej czytelny dla człowieka, ale nadal użyteczny.
**Mitigation:**
- fallback `group:number` jest akceptowalny w pierwszej iteracji

### Risk 5: Pokusa naprawiania równolegle FireRed i Emerald
**Impact:** rozlanie scope i opóźnienie.
**Mitigation:**
- helpery wspólne tak, przepisywanie obu readerów naraz nie

---

## Recommended execution order

**Najbardziej sensowna kolejność praktyczna:**
1. Task 1 — notatka offsetów / assumptions
2. Task 2 — detekcja ROM-u
3. Task 3 — skeleton `PokemonEmeraldReader`
4. Task 5 — `read_map_info()`
5. Task 6 — `read_player()`
6. Task 7 — `read_dialog()`
7. Task 8 — smoke test Emerald
8. Dopiero potem Task 4 / 9 / 10 / 11 zależnie od tego, co boli najbardziej

Uwaga: Task 4 jest architektonicznie ważny, ale jeśli zacznie spowalniać pionowy slice, można go zrealizować jako „minimum helperów teraz, pełne porządki później”.

---

## Definition of done for TASK-007

Task będzie można uznać za wykonany, gdy istnieje zatwierdzony plan i implementer ma bez zgadywania odpowiedzi na pytania:
- jak rozpoznać Emerald zamiast FireRed,
- jaki pierwszy działający slice wdrażać,
- które pliki zmieniać,
- jak testować postęp po każdej iteracji,
- jakie rzeczy świadomie odłożyć na później, żeby nie ugrzęznąć w decrypt/flags za wcześnie.

---

## Execution handoff

Plan gotowy. Następny sensowny krok to implementacja etapami, zaczynając od detekcji ROM-u + readera Emerald + `map/player/dialog`, a dopiero później rozszerzenie na `party/battle/bag`.