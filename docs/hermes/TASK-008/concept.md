# TASK-008 — wdrożenie dedykowanego lokalnego agenta Hermes do gry w Pokemon Emerald

## Opis taska
Przygotować plan implementacji docelowego rozwiązania, w którym Hermes Agent może używać lokalnego modelu jako wybieralnego providera / osobnego profilu i sterować agentem do gry w Pokemon Emerald bez spalania limitów OpenAI.

## Cel
Spisać plan wdrożenia architektury, która:
- wykorzystuje lokalny model do częstych decyzji w grze,
- zachowuje separację od głównego Hermesa używanego do innych zadań,
- integruje się z istniejącym `pokemon-agent` i dashboardem,
- uwzględnia zależność od realnego wsparcia Emerald/GBA w warstwie stanu gry,
- ma jasny fallback, jeśli parser Emerald nie będzie jeszcze gotowy.

## Stan wejściowy
- Hermes ma już wsparcie dla custom OpenAI-compatible endpointów.
- W `~/.hermes/config.yaml` istnieje już lokalny provider `qwen-local` wskazujący na `http://127.0.0.1:11434/v1`.
- Koncepcyjnie i częściowo technicznie został już przygotowany kierunek lokalnego profilu `pokemonlocal` na Qwen 3 4B.
- `pokemon-agent` ma działający dashboard i API emulatora, ale pełne wsparcie Pokemon Emerald w odczycie stanu pozostaje osobnym torem prac.
- TASK-007 opisuje plan podejścia 1: dopisanie realnego wsparcia Emerald w `pokemon-agent`.

## Założenia robocze
- Lokalny model ma odpowiadać głównie za decyzje typu: dialog, ruch, prosta walka, recovery i nawigacja krótkiego zasięgu.
- Najbardziej opłacalny kierunek to pętla state-driven: `pokemon-agent` dostarcza RAM/state, a model zwraca ograniczony zestaw akcji.
- Vision ma być wsparciem, a nie jedynym źródłem stanu, jeśli tylko TASK-007 dowiezie minimalny slice Emerald.
- Integracja powinna wspierać dwa tryby: preferowany `state-first` oraz awaryjny `vision-first degraded mode`.

## Definicja gotowego planu
Plan ma jednoznacznie opisywać:
- jakie komponenty i pliki trzeba zmienić lub dodać,
- jak odseparować profil / providera Pokemon od głównego Hermesa,
- jak ma wyglądać pętla decyzyjna i format odpowiedzi modelu,
- jak obsłużyć fallback między `state-first` a `vision-first`,
- jak testować konfigurację i zachowanie bez wdrażania pełnej produkcyjnej automatyzacji.

## Ryzyka
- TASK-007 może pozostać częściowo niedomknięty, więc plan musi tolerować etapowe wdrożenie.
- Małe modele lokalne mogą wymagać bardzo ścisłego formatu wyjścia i ograniczonej przestrzeni decyzji.
- Zbyt luźny prompt lub zbyt szeroki action space może powodować niestabilne granie.
- Vision-only fallback może działać znacznie gorzej od state-driven loop i powinien być jasno oznaczony jako degradacja.

## Aktualna decyzja
- Chcemy przejść z samej koncepcji do konkretnego planu implementacji dedykowanego lokalnego agenta Hermes dla Pokemon Emerald, bez wykonywania jeszcze pełnego wdrożenia.