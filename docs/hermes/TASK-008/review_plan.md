# TASK-008 — review planu vs koncepcja

## Ocena ogólna
PASS

## Checklist
- [OK] Plan zachowuje główny cel koncepcji: lokalny model ma przejąć granie w Pokémon Emerald bez spalania limitów OpenAI.
- [OK] Plan respektuje preferowany kierunek architektoniczny: osobny profil `pokemonlocal`, a nie mieszanie tego z głównym Hermesem.
- [OK] Plan prawidłowo identyfikuje dependency TASK-007 jako warunek docelowego trybu `state-first`.
- [OK] Plan nie próbuje ukrywać obecnego ryzyka Emerald i jawnie przewiduje `vision-first degraded mode`.
- [OK] Plan zawiera konkretne punkty integracji po obu stronach: profil Hermesa oraz `pokemon-agent` / dashboard.
- [OK] Plan ogranicza action space i wymusza structured output, co jest krytyczne dla małego lokalnego modelu.
- [OK] Plan zawiera observability, logowanie decyzji i widoczny dla operatora wskaźnik trybu pracy.
- [OK] Plan definiuje praktyczne smoke testy i rollout eksperymentalny zamiast skoku od razu do pełnej autonomii.

## Uwagi
- Największy punkt kontrolny implementacji pozostaje ten sam: czy minimalny Emerald state z TASK-007 jest wystarczająco wiarygodny, by agent mógł grać w trybie `state-first`.
- Jeśli `qwen3:4b` okaże się zbyt niestabilny nawet przy wąskim kontrakcie, plan nadal pozostaje poprawny architektonicznie — zmieni się tylko model bazowy, nie konstrukcja rozwiązania.
- Podczas implementacji warto pilnować, aby dashboard najpierw dawał observability, a dopiero później kontrolki uruchamiania pętli, żeby nie mieszać debugowania z UX automation.
