# TASK-007 — podejście 1: realne wsparcie Pokemon Emerald w pokemon-agent

## Opis taska
Spróbować ogarnąć temat podejściem 1, czyli nie omijać ograniczeń `pokemon-agent`, tylko dopisać właściwe wsparcie dla Pokemon Emerald / GBA tak, aby agent Hermesa mógł grać na podstawie prawdziwego stanu z pamięci emulatora.

## Cel
Doprowadzić do stanu, w którym backend gry:
- poprawnie rozpoznaje ROM Pokemon Emerald,
- tworzy właściwy reader dla Emerald zamiast wpadać w ścieżkę `firered`,
- zwraca użyteczny `/state` bez kluczowych `NotImplementedError` dla podstawowych sekcji,
- zachowuje kompatybilność z dashboardem i istniejącym workflow Hermesa,
- respektuje preferencję użytkownika, aby dla Emerald docelowo wybierać startera `Torchic`.

## Stan wejściowy
- Lokalny model `qwen3:4b` przez Ollama jest już skonfigurowany i odseparowany profilem `pokemonlocal`.
- Dashboard `pokemon-agent` da się uruchomić lokalnie na porcie `9876`.
- `/health` zwraca `200` i `emulator_ready=true`.
- `/state` zwraca `200`, ale metadata pokazuje `Pokemon FireRed (USA)` nawet dla ROM-u Emerald.
- `player`, `party`, `bag`, `battle`, `dialog`, `map`, `flags` są dziś zależne od readera GBA, który pozostaje stubowy.

## Ustalenia techniczne
- `pokemon_agent/server.py` wykrywa `.gba` jako `firered` wyłącznie po rozszerzeniu pliku.
- `pokemon_agent/memory/firered.py` zawiera adresy i szkic readera, ale praktycznie wszystkie publiczne metody rzucają `NotImplementedError`.
- `pokemon_agent/memory/red.py` jest jedyną pełniej zaimplementowaną referencją architektury readera stanu.
- `pokemon_agent/state/builder.py` toleruje sekcje niezaimplementowane, ale przez to agent nie ma danych potrzebnych do autonomicznej gry.
- `pokemon_agent/emulator.py` ma już działający backend GBA do odczytu pamięci, screenshotów i inputów, więc główny brak jest w warstwie dekodowania stanu gry.

## Zakres podejścia 1
### In scope
1. Odróżnienie Emerald od FireRed na poziomie detekcji i readera.
2. Zaprojektowanie oraz wdrożenie minimalnego działającego readera Emerald.
3. Ustalenie kolejności implementacji sekcji `/state` tak, by szybko uzyskać praktyczną wartość dla Hermesa.
4. Zachowanie zgodności HTTP API i dashboardu.

### Out of scope na start
- pełna perfekcyjna obsługa wszystkich event flags i całego Pokedexu,
- zaawansowana nawigacja map i kompletna baza nazw wszystkich map/flag,
- battle AI i prompt engineering Hermesa,
- fallback vision-only jako główna ścieżka.

## Definicja ukończenia planu
Plan ma jednoznacznie opisywać:
- jakie pliki trzeba zmienić,
- jak wykrywać Emerald,
- jaką minimalną funkcjonalność readera wdrażać w pierwszej iteracji,
- jak testować poprawność bez pełnego automatycznego test suite,
- jakie ryzyka dotyczą adresów pamięci, save blocków i dekodowania struktur Gen 3.

## Ryzyka
- Niepewność co do dokładnych offsetów i wersji ROM-u Emerald.
- Różnice między FireRed i Emerald w strukturze pamięci, event flags i map tables.
- Dekodowanie party wymaga pracy z PID/OTID, szyfrowaniem i kolejnością substruktur.
- Część sekcji może wymagać etapowania: najpierw player/map/dialog, potem party/battle/bag/flags.

## Aktualna decyzja
- Idziemy podejściem 1, bo użytkownik chce spróbować prawdziwego wsparcia Emerald zamiast obchodzenia problemu przez osobny bridge albo vision-first loop.
