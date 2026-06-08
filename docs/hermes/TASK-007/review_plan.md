# TASK-007 — review planu vs koncepcja

## Ocena ogólna
PASS

## Checklist
- [OK] Plan realizuje główny kierunek koncepcji: podejście 1, czyli dopisanie realnego wsparcia Emerald w `pokemon-agent`, a nie fallback vision-only.
- [OK] Plan uwzględnia stan wejściowy: lokalny model i dashboard już działają, a blockerem jest błędna detekcja ROM-u i stubowy reader GBA.
- [OK] Plan rozdziela etap minimum usable (`metadata`/`map`/`player`/`dialog`) od późniejszych, trudniejszych etapów (`party`/`battle`/`bag`/`flags`).
- [OK] Plan wskazuje dokładne pliki do stworzenia i modyfikacji, w tym `memory/emerald.py`, `memory/gen3.py`, `cli.py`, `server.py` i smoke test Emerald.
- [OK] Plan zachowuje zgodność z obecnym HTTP API i dashboardem.
- [OK] Plan opisuje walidację bez wymagania pełnego test suite — przez smoke testy CLI, `/health`, `/state` i prosty action/position check.
- [OK] Plan identyfikuje kluczowe ryzyka: wersje ROM-u, offset mismatch, różnicę saveblock vs live state oraz blokujący decrypt danych party w Gen 3.
- [OK] Plan nie gubi preferencji użytkownika dotyczącej Emerald i docelowego Torchica; słusznie odkłada tę logikę na warstwę agenta po odblokowaniu stanu gry.

## Uwagi
- Największy punkt kontrolny implementacji to szybka walidacja, czy `player.position` i `dialog.active` reagują na realne akcje w emulatorze. Jeśli nie, trzeba będzie wcześniej wrócić do etapu ustalania live runtime offsets.
- Warto podczas implementacji nie rozlewać zakresu na pełne FireRed support improvements, chyba że wynikają bezpośrednio ze wspólnych helperów Gen 3.
