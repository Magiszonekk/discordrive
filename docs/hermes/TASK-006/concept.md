# TASK-006 — lokalny model AI do Hermes dla gry w Pokemon Emerald

## Opis taska
Sprawdzić koncepcyjnie, czy da się uruchomić lokalny model AI i podpiąć go do Hermes Agent jako model do wyboru, a następnie użyć go jako dedykowanego agenta do grania w Pokemon Emerald z dashboardem do podglądu.

## Cel
Zaprojektować sensowną architekturę, która:
- nie zużywa limitów OpenAI na trywialne akcje w grze,
- pozwala wybrać lokalny model w Hermes,
- umożliwia wydzielenie osobnego agenta/profilu tylko do grania,
- uwzględnia realne ograniczenia warstwy emulatora i integracji Pokemon Emerald.

## Ustalenia koncepcyjne
- Początkowo była to faza czysto koncepcyjna, ale została rozszerzona o realne uruchomienie lokalnego modelu i konfiguracji profilu Hermesa.
- Priorytetem pozostaje oddzielenie "taniego / lokalnego" agenta do gry od głównego Hermesa używanego do poważniejszych zadań.
- Kluczowe pytanie nie brzmi tylko "czy Hermes obsłuży lokalny model", ale też "czy obecna warstwa pokemon-agent faktycznie wspiera Emerald na poziomie wymaganym do autonomicznej gry".

## Co zostało realnie wdrożone
- Zainstalowano lokalny runtime `Ollama` jako user service `ollama-local.service`.
- Pobrano model `qwen3:4b` w kwantyzacji `Q4_K_M`.
- Dodano do Hermesa provider `qwen-local` oraz custom provider dla lokalnego endpointu `http://127.0.0.1:11434/v1`.
- Utworzono osobny profil Hermesa `pokemonlocal` oparty o lokalny model Qwen.
- W profilu `pokemonlocal` ustawiono lokalny fallback zamiast zdalnych providerów.
- W profilu `pokemonlocal` dodano dedykowaną personę do gry w Pokémon Emerald z preferencją wyboru startera `Torchic`.
- Utworzono alias CLI `pokemonlocal` do wygodnego uruchamiania osobnego profilu.
- Potwierdzono, że Hermes potrafi odpowiedzieć przez lokalny model (`qwen-local`).

## Wstępne ustalenia techniczne
- Hermes wspiera custom endpointy zgodne z OpenAI API przez `model.provider=custom`, `model.base_url`, `model.api_key` oraz `api_mode=chat_completions`.
- Obecna lokalna konfiguracja Hermesa już używa custom endpointu (`/home/ubuntu/.hermes/config.yaml` wskazuje `provider: custom`, `base_url: http://127.0.0.1:8080`). To potwierdza, że technicznie podpięcie lokalnego modelu jest wspierane przez sam framework.
- `hermes_cli/models.py` traktuje `custom` jako pełnoprawny typ providera (`Custom endpoint`), a alias `ollama` mapuje się na `custom`, więc lokalny endpoint przez Ollama albo `llama-server` jest zgodny z kierunkiem architektury Hermesa.
- Skill `pokemon-player` i repo `pokemon-agent` pokazują model integracji: Hermes/LLM -> HTTP API gry -> emulator + dashboard.

## Najważniejsze ograniczenie
- Największym blockerem nie jest Hermes ani lokalny model, tylko obecna dojrzałość `pokemon-agent` dla Pokemon Emerald / GBA.
- W repo `/home/ubuntu/pokemon-agent/README.md` Emerald jest nadal opisany jako `planned / phase 2`.
- `pokemon_agent/server.py` mapuje ROM `.gba` na tryb `firered`.
- `pokemon_agent/memory/firered.py` jest oznaczone jako `Phase 2 stub` i kluczowe metody nadal rzucają `NotImplementedError`.
- Wniosek: dziś łatwiej podpiąć lokalny model do Hermesa niż uzyskać stabilną, autonomiczną grę w Emerald na obecnym backendzie gry.

## Uzgodniony kierunek roboczy
### Wariant A — rekomendowany
1. Hermes dostaje osobny profil / konfigurację dla lokalnego modelu.
2. Lokalny model jest wystawiony przez OpenAI-compatible endpoint (np. `llama.cpp` server albo Ollama-compatible bridge/OpenAI bridge).
3. Agent do Pokemonów działa jako osobny Hermes profile / osobna instancja, żeby nie mieszać ustawień z głównym agentem.
4. Dashboard pozostaje po stronie `pokemon-agent`.
5. Dla Emerald trzeba albo:
   - dopisać realny reader stanu GBA/Emerald,
   - albo przejść na gorszy, vision-first loop bez pełnego RAM/state parsera.

### Wariant B — szybki eksperyment
- Najpierw odpalić lokalny model z Hermes tylko dla prostych agentowych decyzji,
- a samą warstwę gry testować nie na Emerald, tylko na lepiej wspieranym tytule / prostszym flow,
- dopiero później wracać do Emerald.

## Definicja sensownego efektu końcowego
Za sensowny sukces tej koncepcji uznajemy sytuację, w której:
- Hermes ma lokalny model jako wybór lub osobny profil,
- agent Pokemon nie używa płatnego OpenAI,
- dashboard pozwala obserwować rozgrywkę,
- a dla Emerald istnieje albo działający parser stanu, albo świadomie zaakceptowany fallback vision-only z gorszą niezawodnością.

## Otwarte pytania do dalszej koncepcji
- Jaki lokalny model ma być priorytetem: ultraszybki mały model do prostych akcji czy nieco większy model z lepszym planowaniem?
- Czy agent ma działać w pełni autonomicznie, czy półautonomicznie z Twoją interwencją przy trudniejszych momentach?
- Czy Emerald jest twardym wymaganiem już na start, czy można najpierw udowodnić cały pipeline na lepiej wspieranej grze?
