# TASK-008 — plan wdrożenia dedykowanego lokalnego agenta Hermes do gry w Pokémon Emerald

## Goal
Dowieźć praktyczne wdrożenie, w którym Hermes Agent używa lokalnego modelu jako dedykowanego profilu do sterowania `pokemon-agent` w Pokémon Emerald, minimalizując koszty chmurowe i zachowując czytelny fallback, gdy structured state dla Emerald nie jest jeszcze w pełni gotowy.

## Architecture
Docelowa architektura ma 4 warstwy:
1. **Local inference layer** — lokalny endpoint OpenAI-compatible dla małego modelu (`qwen3:4b` lub następca) dostępny przez Hermesa.
2. **Hermes Pokemon profile** — osobny profil `pokemonlocal`, odseparowany od głównego Hermesa, z własną konfiguracją modelu, personą i workspace.
3. **Pokemon control layer** — `pokemon-agent` wystawiający emulator, HTTP API, screenshoty i structured state.
4. **Decision loop** — cienka pętla orkiestracyjna, która pobiera stan, pyta model o 1-3 akcje, wykonuje je, zapisuje telemetrykę i ocenia, czy działa w trybie `state-first` czy `vision-first degraded`.

## Tech Stack
- **Hermes Agent**: `/home/ubuntu/.hermes/hermes-agent`
- **Hermes profile config**: `/home/ubuntu/.hermes/profiles/pokemonlocal/config.yaml`
- **Hermes persona / operational context**: `/home/ubuntu/.hermes/profiles/pokemonlocal/SOUL.md`
- **Pokemon emulator backend**: `/home/ubuntu/pokemon-agent`
- **Game server**: `/home/ubuntu/pokemon-agent/pokemon_agent/server.py`
- **CLI**: `/home/ubuntu/pokemon-agent/pokemon_agent/cli.py`
- **Emerald memory reader dependency**: `/home/ubuntu/pokemon-agent/pokemon_agent/memory/emerald.py`
- **Dashboard static UI**: `/home/ubuntu/pokemon-agent/pokemon_agent/dashboard/static/index.html`, `app.js`, `style.css`
- **Optional local runtime**: Ollama / llama.cpp-compatible OpenAI endpoint

## Current context / assumptions
- Lokalny provider i profil nie są już czystą teorią: istnieje `qwen-local` oraz profil `/home/ubuntu/.hermes/profiles/pokemonlocal` wskazujący na `http://127.0.0.1:11434/v1` z modelem `qwen3:4b`.
- Obecny największy blocker nie leży w samym Hermesie, tylko w dojrzałości warstwy Emerald w `pokemon-agent`.
- TASK-007 jest dependency dla docelowego trybu `state-first`; ten task nie ma duplikować implementacji parsera Emerald, tylko opisać integrację wokół niego.
- Celem nie jest pełna autonomia od dnia 1, tylko tani i stabilny loop decyzyjny dla prostych akcji: ruch, dialog, podstawowa nawigacja i recovery.
- Jeśli TASK-007 dowiezie tylko minimalny slice (`metadata/map/player/dialog`), to nadal wystarczy do pierwszej używalnej wersji agenta.

## Success criteria
- Hermes ma osobny, lokalny profil do Pokémonów i nie zużywa domyślnie limitów OpenAI.
- Lokalny agent potrafi wykonać powtarzalny loop: odczytaj stan → podejmij krótką decyzję → wykonaj akcje → zweryfikuj wynik.
- Tryb pracy jest jawny: `state-first` lub `vision-first degraded`.
- Każda decyzja jest logowalna wraz z wejściem, wyjściem modelu, wykonanymi akcjami i powodem fallbacku.
- Dashboard / API pokazują operatorowi, z jakiego źródła stanu korzysta agent i czy structured state dla Emerald jest wystarczający.
- Istnieje smoke path pozwalający zweryfikować całość bez długiego autonomicznego grania.

## Proposed approach

### 1) Utrzymać pełną separację profilu Pokémon od głównego Hermesa
`pokemonlocal` powinien pozostać osobnym profilem z własnym `config.yaml`, `SOUL.md`, pamięcią i workspace. To daje trzy korzyści: izolację kosztów, brak ryzyka przypadkowego użycia drogiego modelu oraz możliwość agresywniejszego dostrajania promptów pod grę.

Decyzja projektowa:
- **Preferowane**: osobny profil `pokemonlocal`.
- **Niepreferowane na start**: jeden wspólny profil z ręcznym przełączaniem modelu przy każdej sesji.

### 2) Zbudować cienką warstwę orchestration loop nad istniejącym HTTP API
Nie warto wkładać pełnej logiki decyzyjnej do samego promptu. Lepszy jest cienki kontroler, który:
- pobiera `/health`, `/state`, opcjonalnie `/screenshot`,
- normalizuje stan do krótkiego kontekstu dla modelu,
- wymusza structured output,
- wykonuje maksymalnie 1-3 akcje,
- robi re-check stanu,
- zapisuje log decyzji.

Ta warstwa może żyć w profilu Hermesa jako prosty skrypt / runbook, bez wpychania wszystkiego do core Hermesa.

### 3) Ograniczyć przestrzeń decyzji modelu
Lokalny model 4B będzie działał sensownie tylko przy wąskim kontrakcie. Zamiast pozwalać mu pisać dowolne instrukcje, trzeba wymusić mały action space.

Rekomendowany format odpowiedzi modelu:
```json
{
  "mode": "state-first",
  "goal": "continue_dialog",
  "reasoning_brief": "dialog active, continue by pressing A",
  "actions": ["press_a"],
  "expectation": "dialog should advance or close",
  "fallback": null
}
```

Kontrakt wykonawczy:
- tylko z whitelisty: `press_a`, `press_b`, `press_start`, `walk_up`, `walk_down`, `walk_left`, `walk_right`, `wait_30`, `a_until_dialog_end`
- maks. 3 akcje na turę
- bez zagnieżdżonych planów wieloetapowych
- bez "wolnego tekstu" sterującego wykonaniem

Mapowanie na aktualny backend może się odbywać w cienkim adapterze, np.:
- `press_a` → `press_a`
- `walk_up` → `walk_up`
- `wait_30` → `wait_30`
- `continue_dialog` może być rozwijane do `a_until_dialog_end` tylko wtedy, gdy `dialog.active=true`

### 4) Rozdzielić dwa tryby odczytu stanu
#### Tryb A — `state-first` (docelowy)
Warunek wejścia:
- TASK-007 dostarcza wiarygodne `metadata/map/player/dialog` dla Emerald.

Źródła wejścia dla modelu:
- `game`, `map`, `player.position`, `player.facing`, `dialog.active`, ewentualnie `last_action_result`
- screenshot tylko pomocniczo albo w trybie debug

Zaleta:
- niski koszt tokenów i wysoka powtarzalność.

#### Tryb B — `vision-first degraded`
Warunek wejścia:
- structured state dla Emerald nie przechodzi sanity-checku albo zwraca stuby.

Źródła wejścia dla modelu:
- screenshot + minimalne metadata z API (`game_type`, health servera, ostatnia pozycja jeśli dostępna)

Ograniczenia:
- tylko proste scenariusze: dialog, menu, ruch o 1 krok, potwierdzanie wyborów
- wyraźne oznaczenie w logach i dashboardzie, że agent działa w degradacji

### 5) Dodać warstwę sanity-check przed każdą decyzją
Zanim model dostanie prompt, orchestrator powinien ocenić jakość stanu:
- czy `/health` jest zielone,
- czy `game_type == emerald`,
- czy `player.position` ma sensowny kształt,
- czy `dialog.active` zmienia się po `press_a`,
- czy screenshot jest aktualny.

Na tej podstawie ustawiany jest `decision_mode`:
- `state-first`
- `vision-first-degraded`
- `blocked`

Jeśli `blocked`, agent nie gra dalej — zamiast tego raportuje blocker operatorowi.

### 6) Zrobić observability jako funkcję pierwszej klasy
To nie może być black box. Potrzebny jest prosty decision log z polami:
- timestamp
- decision_mode
- condensed_state
- prompt_digest / prompt_version
- raw_model_output
- normalized_actions
- execution_result
- fallback_reason
- post_state_summary

Na start wystarczą pliki JSONL w profilu `pokemonlocal`, np.:
- `/home/ubuntu/.hermes/profiles/pokemonlocal/workspace/logs/pokemon-decisions.jsonl`
- `/home/ubuntu/.hermes/profiles/pokemonlocal/workspace/logs/pokemon-fallbacks.jsonl`

### 7) Wystawić minimalny status operatorski do dashboardu
Dashboard nie musi od razu uruchamiać modelu, ale powinien pokazywać:
- aktualny `decision_mode`
- który provider/model jest używany
- ostatnią decyzję i ostatni fallback reason
- czy structured state jest oceniony jako healthy

To od razu skraca debug loop i pozwala odróżnić problem modelu od problemu parsera Emerald.

## Files likely to change

### Już istniejące pliki konfiguracyjne / operacyjne
- `/home/ubuntu/.hermes/profiles/pokemonlocal/config.yaml`
  - doprecyzowanie domyślnego modelu, fallbacków i ewentualnych parametrów dla lokalnego runtime
- `/home/ubuntu/.hermes/profiles/pokemonlocal/SOUL.md`
  - doprecyzowanie kontraktu agenta, zasad krótkich akcji, fallbacków i trybów pracy
- `/home/ubuntu/.hermes/config.yaml`
  - tylko jeśli profil ma współdzielić provider definitions albo potrzebny będzie globalny alias providera

### Nowe pliki proponowane po stronie profilu Hermes
- `/home/ubuntu/.hermes/profiles/pokemonlocal/workspace/pokemon_loop.py`
  - cienki orchestrator dla decision loop
- `/home/ubuntu/.hermes/profiles/pokemonlocal/workspace/prompt_contracts/pokemon_action_schema.json`
  - schema / dokument kontraktu structured output
- `/home/ubuntu/.hermes/profiles/pokemonlocal/workspace/logs/`...
  - decision logs, fallback logs, smoke artifacts
- opcjonalnie `/home/ubuntu/.hermes/profiles/pokemonlocal/workspace/runbooks/emerald-smoke.md`
  - operator checklist

### Punkty integracji w pokemon-agent
- `/home/ubuntu/pokemon-agent/pokemon_agent/server.py`
  - ewentualne dołożenie lekkiego endpointu statusowego dla decision mode / last decision lub łatwiejsze wystawienie telemetryki
- `/home/ubuntu/pokemon-agent/pokemon_agent/cli.py`
  - opcjonalne wygodne flagi do smoke uruchomień Emerald
- `/home/ubuntu/pokemon-agent/pokemon_agent/dashboard/static/index.html`
- `/home/ubuntu/pokemon-agent/pokemon_agent/dashboard/static/app.js`
- `/home/ubuntu/pokemon-agent/pokemon_agent/dashboard/static/style.css`
  - wskaźnik trybu `state-first` vs `vision-first degraded`, last fallback reason, model/provider info

### Dependency z TASK-007
- `/home/ubuntu/pokemon-agent/pokemon_agent/memory/emerald.py`
- `/home/ubuntu/pokemon-agent/pokemon_agent/state/builder.py`
- `/home/ubuntu/pokemon-agent/pokemon_agent/rom_detection.py`

Te pliki nie są zakresem tego taska jako takiego, ale plan integracji zależy od ich minimalnej używalności.

## Task-by-task plan

### Etap 0 — freeze kontraktu i dependency boundary
1. Formalnie uznać TASK-007 za dependency dla `state-first`.
2. Zdefiniować minimalny wymagany state contract dla lokalnego agenta:
   - `game_type`
   - `map`
   - `player.position`
   - `player.facing`
   - `dialog.active`
3. Spisać, które decyzje są legalne przy pełnym stanie, a które tylko w degraded mode.

**Deliverable:** krótki contract doc + lista sanity checks.

### Etap 1 — utwardzenie profilu `pokemonlocal`
1. Uporządkować `/home/ubuntu/.hermes/profiles/pokemonlocal/config.yaml` tak, aby:
   - lokalny provider był jawnie domyślny,
   - fallback do chmury był wyłączony albo przynajmniej niejawny,
   - terminal cwd wskazywał repo `pokemon-agent`.
2. Dopisać do `SOUL.md` ścisłe zasady:
   - krótkie sekwencje akcji,
   - brak samowolnego przełączania modelu,
   - obowiązkowy health/state check,
   - jawne raportowanie degradacji.
3. Przygotować katalog `workspace/` pod prompty, logs i smoke artifacts.

**Deliverable:** stabilny profil gotowy do sesji Pokémon-only.

### Etap 2 — decision loop runner
1. Stworzyć `pokemon_loop.py` jako cienki orchestrator.
2. Dodać kroki:
   - fetch `/health`
   - fetch `/state`
   - opcjonalnie fetch `/screenshot`
   - `evaluate_state_quality()`
   - `build_model_input()`
   - `request_structured_decision()`
   - `normalize_actions()`
   - `execute_actions()`
   - `verify_post_state()`
   - `append_decision_log()`
3. Wprowadzić twarde limity:
   - max 3 akcje / turę
   - max 1 retry po niepoprawnym JSON
   - abort po 2 kolejnych turach bez obserwowalnej zmiany stanu

**Deliverable:** lokalny runner nadający agentowi deterministyczną ramę.

### Etap 3 — structured output i action adapter
1. Zdefiniować prosty JSON schema dla wyjścia modelu.
2. Zaimplementować parser i walidator odpowiedzi.
3. Zrobić adapter `semantic action -> pokemon-agent action strings`.
4. Dodać fallback dla niepoprawnych odpowiedzi modelu:
   - 1 reprompt z jeszcze krótszym stanem
   - potem `blocked` zamiast zgadywania

**Deliverable:** bezpieczne i przewidywalne sterowanie z małego modelu.

### Etap 4 — integracja z Emerald state dependency
1. Gdy TASK-007 dowiezie minimalny slice, podłączyć go do `evaluate_state_quality()`.
2. Zdefiniować heurystykę readiness, np.:
   - `game_type == emerald`
   - `player.position` nie jest nullem / stubem
   - `dialog.active` reaguje na testowy input
3. Jeśli warunki nie są spełnione, runner przechodzi w `vision-first degraded`.

**Deliverable:** płynne przełączanie między trybami bez ręcznego debugowania przy każdej sesji.

### Etap 5 — dashboard observability
1. Dołożyć do dashboardu status panel z polami:
   - current mode
   - state health
   - current provider/model
   - last action batch
   - last fallback reason
2. Jeśli łatwiej, telemetrykę można najpierw wystawiać z pliku / prostego endpointu, a dopiero potem renderować w UI.
3. Nie mieszać tego z pełnym autonomicznym sterowaniem z poziomu dashboardu — najpierw widoczność, potem kontrolki.

**Deliverable:** operator od razu widzi, czy zawiódł model, parser, czy emulator.

### Etap 6 — smoke workflow i ręczne scenariusze
1. Zrobić szybki smoke dla `state-first`:
   - uruchom serwer Emerald,
   - odczytaj `/health` i `/state`,
   - poproś model o 1 akcję przy prostym dialogu lub ruchu,
   - wykonaj akcję,
   - zweryfikuj zmianę.
2. Zrobić smoke dla `vision-first degraded`:
   - zasymuluj brak wiarygodnego stanu,
   - pobierz screenshot,
   - zleć modelowi prostą decyzję,
   - oznacz log jako degraded.
3. Zachować artefakty: screenshot before/after, response JSON, post-state summary.

**Deliverable:** szybki dowód, że architektura działa bez wielogodzinnej sesji gry.

### Etap 7 — rollout eksperymentalny
1. Tryb manual supervised only.
2. Potem krótkie autonomie 1-2 minuty.
3. Potem scenariusze specyficzne dla Emerald:
   - przechodzenie dialogów,
   - pierwszy ruch po mapie,
   - wejście/wyjście z menu,
   - wybór startera (Torchic) dopiero po potwierdzeniu stabilności state loop.

**Deliverable:** kontrolowany rollout bez spalania czasu na nieobserwowalną autonomię.

## Tests / validation

### Konfiguracja
- Profil `pokemonlocal` startuje bez potrzeby ręcznego podawania chmurowego providera.
- Provider lokalny odpowiada na prosty request testowy.
- `terminal.cwd` w profilu wskazuje `/home/ubuntu/pokemon-agent`.

### Contract tests
- Parser structured output odrzuca nie-JSON i nielegalne akcje.
- Action adapter generuje tylko komendy akceptowane przez `pokemon-agent`.
- `evaluate_state_quality()` poprawnie klasyfikuje: `state-first`, `vision-first-degraded`, `blocked`.

### Smoke tests
- `/health` zwraca gotowość emulatora.
- `/state` dla Emerald zwraca minimalny slice zgodny z dependency contract albo runner przełącza się w degraded mode.
- Jedna decyzja typu `press_a` lub `walk_right` kończy się obserwowalną zmianą w stanie lub screenshotcie.
- Dashboard pokazuje aktualny mode indicator i last fallback reason.

### Regression checks
- Główny Hermes nie traci swojej domyślnej konfiguracji przez zmiany dla `pokemonlocal`.
- Brak ukrytego fallbacku do OpenAI przy sesji `pokemonlocal`.
- Gdy parser Emerald wróci stubowy stan, agent nie udaje sukcesu.

## Risks / tradeoffs
- **Mały model vs niezawodność**: 4B może być wystarczający do prostych decyzji, ale nie do skomplikowanej taktyki i długich planów.
- **Vision-only jest droższe i mniej stabilne**: nawet lokalnie zwiększa koszt obliczeniowy i pogarsza deterministykę.
- **Zbyt bogaty prompt szkodzi**: mały model potrzebuje agresywnego skrócenia kontekstu i małej liczby akcji.
- **Fałszywa pewność parsera**: częściowo błędny state jest gorszy niż jawny degraded mode.
- **Telemetryka to nie opcja**: bez niej debugging zamieni się w zgadywanie, czy zawiódł model, API, czy emulator.

## Rollout strategy
- **Faza 1**: profile hardening + logs + schema + manual smoke
- **Faza 2**: state-first on minimal Emerald slice
- **Faza 3**: degraded fallback + dashboard visibility
- **Faza 4**: krótkie sesje supervised autonomy
- **Faza 5**: dopiero potem ambitniejsze cele gameplayowe

## Open questions
- Czy `qwen3:4b` zostaje baseline’em, czy ma być tylko pierwszy benchmark pod późniejszą podmianę?
- Czy operator ma odpalać pętlę jako skrypt w profilu, czy finalnie z dashboardu / komendy Hermesa?
- Czy smoke ma być wyłącznie ręczny, czy warto dodać półautomatyczny replay scenariusza startowego Emerald?
- Jak dużo danych z `/state` naprawdę trzeba pokazywać modelowi, żeby nie przepalić stabilności przez nadmiar kontekstu?
- Czy wybór startera Torchic ma być zaszyty jako twarda reguła w runnerze, czy tylko w personie / prompt contract?

## Recommended implementation order
1. Domknąć dependency boundary z TASK-007.
2. Utwardzić `pokemonlocal` config + persona.
3. Napisać `pokemon_loop.py` z structured output i loggingiem.
4. Dodać `evaluate_state_quality()` i tryby `state-first` / `degraded`.
5. Dodać dashboard observability.
6. Uruchomić smoke testy i zachować artefakty.
7. Dopiero potem rozwijać bardziej autonomiczne zachowania.

## Final note
Najważniejsza decyzja architektoniczna brzmi: **nie próbować robić „inteligencji” samym promptem**. Tani lokalny agent do Pokémonów będzie działał dobrze tylko wtedy, gdy większość stabilności dostarczy mu zewnętrzna rama: mały kontrakt wejścia, twardy schema outputu, krótki batch akcji, sanity-check stanu i jawny degraded mode.