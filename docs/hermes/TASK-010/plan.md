# TASK-010 — plan implementacji osobnego serwera MCP dla OVH DNS

## Cel
Dowieźć osobny projekt MCP dla OVH DNS jako sibling repo obok `/home/ubuntu/Desktop/mcp`, preferencyjnie w `/home/ubuntu/Desktop/mcp-ovh`, tak aby agent korzystał wyłącznie z wąskich, bezpiecznych tooli DNS i nigdy nie dostawał do promptu sekretów OVH (`AK` / `AS` / `CK`).

## Założenia projektowe
- Scope MVP obejmuje wyłącznie **OVH DNS**.
- Nie robimy generycznego raw proxy typu `ovh_request(method, path, body)`.
- Sekrety są trzymane po stronie serwera MCP, ładowane z `.env`.
- Istnieją dwa profile credentiali:
  - `readClient` — odczyt,
  - `writeClient` — mutacje DNS.
- Mutacje są dodatkowo ograniczone allowlistą stref, np. `OVH_ALLOWED_ZONES`.
- Preferowane tools MVP:
  - `list_zones`
  - `list_records`
  - `get_record`
  - `get_me`
  - `create_record`
  - `update_record`
  - `delete_record`
  - `refresh_zone`
  - `ensure_a_record`
- Serwer ma wspierać `stdio` oraz opcjonalnie HTTP, wzorując się na `/home/ubuntu/Desktop/mcp/src/index.ts`.
- Trzeba dostarczyć minimalne artefakty operacyjne: `.env.example`, `README`, plik service, minimalne testy / walidację.
- Logi i błędy nie mogą ujawniać `AK` / `AS` / `CK`.

## Referencja z istniejącego projektu `/home/ubuntu/Desktop/mcp`
Na podstawie analizy:
- projekt jest prostym serwerem MCP w TypeScript + Node.js,
- używa `@modelcontextprotocol/sdk`, `dotenv`, `express`,
- wspiera dwa transporty:
  - `StdioServerTransport`,
  - `StreamableHTTPServerTransport`,
- ma pojedynczy `src/index.ts`,
- ma prosty `tsconfig.json`,
- ma systemd service z `WorkingDirectory`, `EnvironmentFile`, `ExecStart`,
- auth dla HTTP jest realizowany przez `MCP_TOKEN`.

Wniosek: dla MVP najlepiej skopiować ten kształt projektu, ale od razu rozdzielić kod na małe moduły zamiast wkładać wszystko do jednego `index.ts`.

---

## Proponowana architektura projektu

### Lokalizacja projektu
- nowy katalog: `/home/ubuntu/Desktop/mcp-ovh`

### Proponowana struktura
- `/home/ubuntu/Desktop/mcp-ovh/package.json`
- `/home/ubuntu/Desktop/mcp-ovh/tsconfig.json`
- `/home/ubuntu/Desktop/mcp-ovh/.gitignore`
- `/home/ubuntu/Desktop/mcp-ovh/.env.example`
- `/home/ubuntu/Desktop/mcp-ovh/README.md`
- `/home/ubuntu/Desktop/mcp-ovh/ovh-mcp.service`
- `/home/ubuntu/Desktop/mcp-ovh/src/index.ts`
- `/home/ubuntu/Desktop/mcp-ovh/src/config.ts`
- `/home/ubuntu/Desktop/mcp-ovh/src/ovh-client.ts`
- `/home/ubuntu/Desktop/mcp-ovh/src/guards.ts`
- `/home/ubuntu/Desktop/mcp-ovh/src/tools.ts`
- `/home/ubuntu/Desktop/mcp-ovh/src/sanitize.ts`
- `/home/ubuntu/Desktop/mcp-ovh/src/types.ts`
- `/home/ubuntu/Desktop/mcp-ovh/src/http.ts` albo transport utrzymany w `src/index.ts`
- `/home/ubuntu/Desktop/mcp-ovh/test/` lub `/home/ubuntu/Desktop/mcp-ovh/src/__tests__/`

### Dlaczego osobne moduły
W istniejącym `mcp` całość siedzi w jednym pliku, ale tutaj zakres bezpieczeństwa jest większy. Rozdzielenie plików ułatwi:
- testowanie guardrailów,
- uniknięcie przypadkowego logowania sekretów,
- czytelny routing `readClient` vs `writeClient`,
- prostsze utrzymanie przy przyszłym dodaniu np. `ensure_cname_record`.

---

## Lista plików do stworzenia / zmodyfikowania z uzasadnieniem

### 1. `/home/ubuntu/Desktop/mcp-ovh/package.json`
**Po co:** definicja nowego projektu Node/TS i zależności.

**Powinno zawierać:**
- skrypty:
  - `build`
  - `start`
  - `dev`
  - `typecheck`
  - `test` lub przynajmniej `test:smoke`
- zależności runtime:
  - `@modelcontextprotocol/sdk`
  - `dotenv`
  - `express`
  - klient OVH, jeśli zostanie wybrana biblioteka (`ovh`) albo własny klient HTTP podpisujący requesty
- devDependencies:
  - `typescript`
  - `tsx`
  - `@types/node`
  - `@types/express`
  - opcjonalnie `vitest`

**Uwaga projektowa:**
- jeżeli biblioteka `ovh` daje stabilne podpisywanie requestów i prostą obsługę endpointów DNS, można jej użyć;
- jeżeli jej ergonomia lub kontrola nad błędami jest słaba, lepiej zrobić cienki własny wrapper nad OVH API.

### 2. `/home/ubuntu/Desktop/mcp-ovh/tsconfig.json`
**Po co:** zbliżenie do działającego wzorca z `/home/ubuntu/Desktop/mcp/tsconfig.json`.

**Plan:**
- zacząć od konfiguracji niemal 1:1 z istniejącego serwera,
- dodać `strict: true`,
- `rootDir=src`, `outDir=dist`.

### 3. `/home/ubuntu/Desktop/mcp-ovh/.gitignore`
**Po co:** wykluczenie `node_modules`, `dist`, `.env`, logów testowych.

### 4. `/home/ubuntu/Desktop/mcp-ovh/.env.example`
**Po co:** jawny kontrakt konfiguracyjny bez ujawniania prawdziwych sekretów.

**Powinno zawierać co najmniej:**
- `OVH_ENDPOINT=ovh-eu`
- `OVH_APP_KEY=`
- `OVH_APP_SECRET=`
- `OVH_READ_CK=`
- `OVH_WRITE_CK=`
- `OVH_ALLOWED_ZONES=example.com,example.org`
- `PORT=`
- `MCP_TOKEN=`
- opcjonalnie `LOG_LEVEL=info`

### 5. `/home/ubuntu/Desktop/mcp-ovh/README.md`
**Po co:** instrukcja uruchomienia, konfiguracji, ograniczeń bezpieczeństwa i sposobu użycia przez Hermesa.

**Powinno opisać:**
- cel serwera,
- scope MVP,
- dostępne tools,
- znaczenie `readClient` i `writeClient`,
- działanie allowlisty stref,
- stdio mode i HTTP mode,
- przykładowe komendy build/start,
- jak przygotować consumer keys read-only i write,
- znane ograniczenia MVP.

### 6. `/home/ubuntu/Desktop/mcp-ovh/ovh-mcp.service`
**Po co:** operacjonalizacja analogiczna do `/home/ubuntu/Desktop/mcp/ssh-mcp.service`.

**Powinno zawierać:**
- `WorkingDirectory=/home/ubuntu/Desktop/mcp-ovh`
- `EnvironmentFile=/home/ubuntu/Desktop/mcp-ovh/.env`
- `ExecStart=.../node dist/index.js`
- `Restart=on-failure`
- ewentualnie opis wskazujący, że to OVH DNS MCP Server.

### 7. `/home/ubuntu/Desktop/mcp-ovh/src/types.ts`
**Po co:** wspólne typy dla rekordów DNS, konfiguracji i wyników tooli.

**Powinno objąć:**
- `EnvConfig`
- `OvhCredentialProfile`
- `DnsRecordSummary`
- `ToolResult`
- typy wejść dla tooli

### 8. `/home/ubuntu/Desktop/mcp-ovh/src/config.ts`
**Po co:** bezpieczne wczytanie i walidacja konfiguracji z env.

**Odpowiedzialność:**
- parse env,
- walidacja wymaganych zmiennych,
- parsowanie `OVH_ALLOWED_ZONES` do `Set<string>`,
- bezpieczne błędy startowe bez echo sekretów,
- walidacja, że read/write CK są obecne i niepuste.

### 9. `/home/ubuntu/Desktop/mcp-ovh/src/sanitize.ts`
**Po co:** centralna sanitizacja błędów i logów.

**Odpowiedzialność:**
- redakcja `AK` / `AS` / `CK` z wyjątków i logów,
- helper typu `sanitizeError(err, config)`,
- helper do obcinania zbyt długich odpowiedzi,
- ewentualne maskowanie `Authorization`-like stringów.

### 10. `/home/ubuntu/Desktop/mcp-ovh/src/guards.ts`
**Po co:** centralizacja reguł bezpieczeństwa.

**Odpowiedzialność:**
- `assertAllowedZone(zone)`
- `assertRecordTypeAllowed(fieldType)` jeśli chcemy zawęzić typy już w MVP
- `assertMutationAllowed(zone)`
- walidacja `id`, `ttl`, `subDomain`, `target`
- odmowa mutacji poza allowlistą jeszcze przed wywołaniem OVH API

### 11. `/home/ubuntu/Desktop/mcp-ovh/src/ovh-client.ts`
**Po co:** enkapsulacja komunikacji z OVH i routing do właściwego profilu credentiali.

**Odpowiedzialność:**
- utworzenie dwóch klientów:
  - `readClient`
  - `writeClient`
- metody domenowe zamiast generic proxy, np.:
  - `getMe()`
  - `listZones()`
  - `listRecords(zone, params)`
  - `getRecord(zone, id)`
  - `createRecord(...)`
  - `updateRecord(...)`
  - `deleteRecord(...)`
  - `refreshZone(zone)`
- brak eksportu niskopoziomowego `request(path, method, body)` do warstwy tools

### 12. `/home/ubuntu/Desktop/mcp-ovh/src/tools.ts`
**Po co:** definicja MCP tools i ich input schema.

**Odpowiedzialność:**
- jedna lista tooli dla `ListToolsRequestSchema`,
- osobne handlery dla każdego toola,
- czytelne mapowanie:
  - read operations → `readClient`
  - mutations → `writeClient`
- implementacja `ensure_a_record` jako tool wyższego poziomu.

### 13. `/home/ubuntu/Desktop/mcp-ovh/src/index.ts`
**Po co:** bootstrap serwera MCP, analogiczny do wzorca z `/home/ubuntu/Desktop/mcp/src/index.ts`.

**Odpowiedzialność:**
- utworzenie serwera MCP,
- rejestracja `ListToolsRequestSchema` i `CallToolRequestSchema`,
- start w `stdio` gdy brak `PORT`,
- opcjonalny start HTTP gdy `PORT` jest ustawiony,
- auth przez `MCP_TOKEN` dla HTTP,
- brak wypisywania sekretów przy błędach startu.

### 14. `/home/ubuntu/Desktop/mcp-ovh/src/http.ts` albo sekcja HTTP w `src/index.ts`
**Po co:** separacja transportu HTTP, jeśli kod zacznie rosnąć.

### 15. `/home/ubuntu/Desktop/mcp-ovh/src/__tests__/config.test.ts`
**Po co:** sprawdzenie, że konfiguracja jest poprawnie parsowana i walidowana.

### 16. `/home/ubuntu/Desktop/mcp-ovh/src/__tests__/guards.test.ts`
**Po co:** testy allowlisty stref i odmowy mutacji poza dozwolonym zakresem.

### 17. `/home/ubuntu/Desktop/mcp-ovh/src/__tests__/sanitize.test.ts`
**Po co:** testy redakcji sekretów w błędach i logach.

### 18. `/home/ubuntu/Desktop/mcp-ovh/src/__tests__/tools.test.ts`
**Po co:** minimalne testy routingu read/write i kontraktu `ensure_a_record`.

---

## Proponowany kontrakt konfiguracyjny

### Zmienne środowiskowe
- `OVH_ENDPOINT` — np. `ovh-eu`
- `OVH_APP_KEY`
- `OVH_APP_SECRET`
- `OVH_READ_CK`
- `OVH_WRITE_CK`
- `OVH_ALLOWED_ZONES`
- `PORT` — opcjonalne, tylko dla HTTP mode
- `MCP_TOKEN` — wymagane zawsze przy HTTP mode

### Decyzja o credentialach
Na MVP plan zakłada:
- wspólne `OVH_APP_KEY` i `OVH_APP_SECRET`,
- dwa różne `consumerKey`:
  - `OVH_READ_CK`
  - `OVH_WRITE_CK`

Jeśli podczas implementacji okaże się, że bezpieczniej lub organizacyjnie prościej jest rozdzielić także `AK/AS`, warto zostawić architekturę gotową do przyszłego rozszerzenia na:
- `OVH_READ_APP_KEY`
- `OVH_READ_APP_SECRET`
- `OVH_WRITE_APP_KEY`
- `OVH_WRITE_APP_SECRET`

Ale na MVP nie trzeba tego wymuszać, jeśli obecny model operacyjny ma wspólną aplikację i dwa CK.

---

## Proponowany zestaw tooli MCP

### Read-only
1. `list_zones`
   - brak argumentów albo opcjonalny filtr
   - używa `readClient`
   - zwraca tylko strefy w zasięgu konta; opcjonalnie można oznaczyć, które są na allowliście

2. `list_records`
   - input:
     - `zone`
     - opcjonalnie `fieldType`
     - opcjonalnie `subDomain`
   - używa `readClient`

3. `get_record`
   - input:
     - `zone`
     - `id`
   - używa `readClient`

4. `get_me`
   - brak argumentów
   - używa `readClient`
   - przydatne do smoke testu autoryzacji bez mutacji

### Mutations
5. `create_record`
   - input:
     - `zone`
     - `fieldType`
     - `subDomain`
     - `target`
     - opcjonalnie `ttl`
   - używa `writeClient`
   - przed wykonaniem: `assertAllowedZone(zone)`

6. `update_record`
   - input:
     - `zone`
     - `id`
     - opcjonalnie `target`
     - opcjonalnie `ttl`
     - opcjonalnie `subDomain`
   - używa `writeClient`
   - walidacja, że payload nie jest pusty

7. `delete_record`
   - input:
     - `zone`
     - `id`
   - używa `writeClient`

8. `refresh_zone`
   - input:
     - `zone`
   - używa `writeClient`

9. `ensure_a_record`
   - input:
     - `zone`
     - `subDomain`
     - `target`
     - opcjonalnie `ttl`
   - logika:
     - odczytaj rekordy `A` dla `(zone, subDomain)` przez `readClient`
     - jeśli istnieje dokładnie jeden zgodny rekord z tym targetem/ttl → zwróć `noop`
     - jeśli istnieje jeden rekord różniący się targetem/ttl → `update_record`
     - jeśli nie istnieje → `create_record`
     - jeśli istnieje wiele rekordów i sytuacja jest niejednoznaczna → zwróć błąd wymagający jawnej decyzji operatora
   - mutacja/refresh używa `writeClient`

### Zachowanie po mutacjach
Plan zakłada, że:
- `create_record`, `update_record`, `delete_record` **nie muszą automatycznie** robić `refresh_zone`, jeśli OVH wymaga jawnego odświeżenia;
- ale praktyczniej dla agenta może być, by tool zwracał komunikat: „record changed, call refresh_zone”, albo opcjonalnie wykonywał refresh sam.

**Rekomendacja MVP:**
- `create/update/delete` wykonują tylko zmianę,
- `refresh_zone` pozostaje osobnym, jawnym toolem,
- `ensure_a_record` może opcjonalnie wykonać refresh na końcu, bo jest to tool wyższego poziomu i naturalnie ma domknąć workflow.

---

## Kolejność kroków implementacji

## Etap 0 — przygotowanie i decyzje techniczne
1. Porównać istniejący wzorzec `/home/ubuntu/Desktop/mcp` z potrzebami nowego serwera.
2. Zdecydować, czy używamy biblioteki `ovh`, czy własnego cienkiego wrappera HTTP.
3. Zamrozić scope MVP tylko do DNS.
4. Zamrozić listę tooli MVP i brak raw proxy.
5. Zamrozić politykę refresh po mutacjach.

**Weryfikacja:**
- plan zaakceptowany,
- lista tooli i zachowań nie ma luk semantycznych.

## Etap 1 — scaffold projektu
1. Utworzyć katalog `/home/ubuntu/Desktop/mcp-ovh`.
2. Skopiować bazowy kształt z `/home/ubuntu/Desktop/mcp`:
   - `package.json`
   - `tsconfig.json`
3. Utworzyć:
   - `.gitignore`
   - `.env.example`
   - `README.md`
   - `ovh-mcp.service`
   - katalog `src/`
4. Dodać zależności i uruchomić instalację.

**Przykładowe komendy:**
```bash
cd /home/ubuntu/Desktop
mkdir -p mcp-ovh/src mcp-ovh/src/__tests__
cd /home/ubuntu/Desktop/mcp-ovh
npm install
```

**Weryfikacja:**
- `package.json` istnieje,
- `npm install` kończy się sukcesem,
- `npm run build` może jeszcze nie przejść, ale repo ma poprawny scaffold.

## Etap 2 — warstwa konfiguracji i bezpieczeństwa
1. Napisać `src/types.ts`.
2. Napisać `src/config.ts` z walidacją env.
3. Napisać `src/sanitize.ts`.
4. Napisać `src/guards.ts`.
5. Dodać testy:
   - `config.test.ts`
   - `sanitize.test.ts`
   - `guards.test.ts`

**Weryfikacja:**
- brak możliwości startu bez wymaganych env,
- `OVH_ALLOWED_ZONES` parsuje się poprawnie,
- testy redakcji sekretów przechodzą,
- mutacja poza allowlistą daje kontrolowany błąd.

## Etap 3 — klient OVH i routing credentiali
1. Napisać `src/ovh-client.ts`.
2. Zaimplementować tworzenie dwóch klientów:
   - `readClient`
   - `writeClient`
3. Udostępnić tylko metody domenowe DNS.
4. Dodać minimalne mapowanie błędów OVH → bezpieczne błędy domenowe.
5. Dodać testy jednostkowe z mockami klienta.

**Weryfikacja:**
- `list/get` używają `readClient`,
- `create/update/delete/refresh` używają `writeClient`,
- żaden publiczny moduł nie eksportuje generic request proxy.

## Etap 4 — definicja tooli MCP
1. Napisać `src/tools.ts`.
2. Dodać schematy wejść dla wszystkich tooli.
3. Zaimplementować read-only tools.
4. Zaimplementować mutation tools.
5. Zaimplementować `ensure_a_record`.
6. Dodać testy kontraktu tooli.

**Weryfikacja:**
- lista tooli zgadza się z planem MVP,
- input schema ma sensowne required fields,
- `ensure_a_record` rozróżnia `noop/create/update/ambiguous`.

## Etap 5 — bootstrap MCP i transporty
1. Napisać `src/index.ts`.
2. Podłączyć `ListToolsRequestSchema`.
3. Podłączyć `CallToolRequestSchema`.
4. Dodać stdio mode.
5. Dodać opcjonalny HTTP mode wzorowany na `/home/ubuntu/Desktop/mcp/src/index.ts`.
6. Dodać auth przez `MCP_TOKEN` w HTTP mode.
7. Zadbać, by błędy startowe i runtime przechodziły przez sanitizację.

**Weryfikacja:**
- `npm run build` przechodzi,
- serwer startuje w stdio,
- serwer startuje z `PORT=...` w HTTP tylko wtedy, gdy `MCP_TOKEN` jest ustawiony,
- start HTTP bez `MCP_TOKEN` kończy się kontrolowanym błędem startowym bez ujawniania sekretów.

## Etap 6 — dokumentacja i artefakty operacyjne
1. Uzupełnić `README.md`.
2. Dopracować `.env.example`.
3. Dopracować `ovh-mcp.service`.
4. Opisać minimalny runbook smoke testu.

**Weryfikacja:**
- nowa osoba jest w stanie skonfigurować projekt wyłącznie na podstawie README,
- nie ma potrzeby czytania kodu, by uruchomić MVP.

## Etap 7 — smoke testy lokalne i walidacja końcowa
1. Zbudować projekt.
2. Uruchomić testy jednostkowe.
3. Uruchomić serwer w stdio.
4. Uruchomić serwer w HTTP.
5. Zweryfikować `get_me` i `list_zones` na prawdziwych credentialach.
6. Zweryfikować próbę mutacji poza allowlistą.
7. Zweryfikować bezpieczny przepływ `ensure_a_record` na strefie testowej.
8. Zweryfikować, że logi i błędy nie zawierają sekretów.

**Przykładowe komendy:**
```bash
cd /home/ubuntu/Desktop/mcp-ovh
npm run build
npm run test
npm run start
PORT=8080 MCP_TOKEN=test-token npm run start
```

---

## Propozycja konkretnych zadań bite-sized

### Task 1 — utworzenie skeletonu projektu
- utwórz katalog `/home/ubuntu/Desktop/mcp-ovh`
- dodaj `package.json`
- dodaj `tsconfig.json`
- dodaj `src/index.ts` jako minimalny placeholder
- uruchom `npm install`
- uruchom `npm run build`

**Done gdy:** projekt buduje pusty serwer.

### Task 2 — kontrakt env
- dodaj `.env.example`
- dodaj `src/config.ts`
- dodaj testy parsowania env
- uruchom `npm run test`

**Done gdy:** błędny env failuje bez ujawniania sekretów.

### Task 3 — sanitizacja
- dodaj `src/sanitize.ts`
- dodaj testy redakcji
- pokryj przypadki: AK/AS/CK w treści wyjątku, obiekcie error, stack trace

**Done gdy:** testy potwierdzają maskowanie.

### Task 4 — guardraile stref i wejść
- dodaj `src/guards.ts`
- przetestuj allowlistę, walidację `ttl`, `id`, `zone`

**Done gdy:** mutacje poza allowlistą są blokowane przed requestem do OVH.

### Task 5 — warstwa OVH client
- dodaj `src/ovh-client.ts`
- utwórz read/write client
- dodaj metody domenowe DNS
- dodaj mockowane testy routingu

**Done gdy:** test pokazuje, że mutation nigdy nie używa `readClient`.

### Task 6 — read-only tools
- dodaj `list_zones`
- dodaj `list_records`
- dodaj `get_record`
- dodaj `get_me`
- zarejestruj je w `ListToolsRequestSchema`

**Done gdy:** smoke w stdio zwraca listę tooli i poprawne odpowiedzi.

### Task 7 — mutation tools
- dodaj `create_record`
- dodaj `update_record`
- dodaj `delete_record`
- dodaj `refresh_zone`
- dodaj testy wejść i blokad bezpieczeństwa

**Done gdy:** każda mutacja ma jawny guard allowlisty i bezpieczne błędy.

### Task 8 — `ensure_a_record`
- dodaj algorytm identyfikacji istniejącego stanu
- zwracaj wynik ustrukturyzowany: `noop`, `created`, `updated`, `ambiguous`
- zdecyduj, czy tool sam robi `refresh_zone`
- dodaj testy edge-case’ów

**Done gdy:** tool jest idempotentny dla prostego scenariusza A record.

### Task 9 — HTTP mode i auth
- dodaj `PORT`
- dodaj `MCP_TOKEN`
- skopiuj wzorzec `StreamableHTTPServerTransport`
- dodaj auth middleware
- dodaj twardą blokadę startu HTTP przy braku `MCP_TOKEN`

**Done gdy:** request bez tokena dostaje `401`, a start HTTP bez `MCP_TOKEN` kończy się kontrolowanym błędem.

### Task 10 — dokumentacja i service
- dopisz `README.md`
- dodaj `ovh-mcp.service`
- sprawdź ścieżki Node i working directory

**Done gdy:** operator może wdrożyć usługę bez zgadywania.

---

## Potencjalne problemy i jak je rozwiązać

### 1. Biblioteka OVH może być niewygodna lub słabo typowana
**Ryzyko:** trudne mapowanie błędów, nieczytelne typy, nieoczywiste podpisywanie requestów.

**Mitigacja:**
- zacząć od biblioteki tylko jeśli pozwala łatwo obsłużyć DNS,
- jeśli zacznie przeszkadzać, zamknąć ją za `src/ovh-client.ts`, żeby łatwo wymienić implementację bez ruszania tooli.

### 2. Niejasne zachowanie OVH DNS po create/update/delete
**Ryzyko:** część operacji wymaga osobnego `refresh`, część zwraca zmiany, ale nie publikuje ich od razu.

**Mitigacja:**
- jawnie przetestować workflow na strefie testowej,
- utrzymać `refresh_zone` jako osobny tool,
- w README opisać, kiedy trzeba go użyć.

### 3. `ensure_a_record` może być niejednoznaczny przy wielu rekordach A
**Ryzyko:** agent może nieświadomie zmienić zły rekord.

**Mitigacja:**
- dla MVP nie próbować „mądrze zgadywać”,
- jeśli wynik listy rekordów jest niejednoznaczny, zwracać `ambiguous` i wymagać jawnego użycia `get_record` / `update_record`.

### 4. Sekrety mogą wyciec przez stack trace lub serializację błędu klienta
**Ryzyko:** nawet przy braku jawnego logowania, biblioteka może wrzucać pełny request config do wyjątków.

**Mitigacja:**
- centralny `sanitizeError`,
- nie zwracać surowych obiektów błędów do MCP content,
- testy na przykładowych wyjątkach zawierających AK/AS/CK.

### 5. HTTP mode bez auth będzie niebezpieczny
**Ryzyko:** zdalny dostęp do mutacji DNS.

**Mitigacja:**
- w README jasno zaznaczyć, że `MCP_TOKEN` jest wymagany dla HTTP mode,
- przy ustawionym `PORT` i braku `MCP_TOKEN` serwer ma nie startować,
- błąd startowy ma być krótki, kontrolowany i przejść przez sanitizację.

### 6. Zbyt szeroki input tooli zwiększy ryzyko błędów
**Ryzyko:** agent poda dziwne `fieldType`, `target`, `ttl`.

**Mitigacja:**
- walidować pola wejściowe,
- na MVP rozważyć ograniczenie `fieldType` tylko do najczęstszych typów (`A`, `AAAA`, `CNAME`, `TXT`, `MX`) albo nawet tylko `A` dla `ensure_a_record`.

### 7. Allowlista stref może rozjechać się z realną listą stref na koncie
**Ryzyko:** operator nie zrozumie, czemu dana strefa jest widoczna w `list_zones`, ale mutacja nie działa.

**Mitigacja:**
- `list_zones` może opcjonalnie oznaczać `allowed: true/false`,
- README powinno jasno odróżniać „strefa dostępna na koncie” od „strefa dopuszczona do mutacji”.

### 8. Service file może wskazywać złą wersję Node
**Ryzyko:** analogicznie do `/home/ubuntu/Desktop/mcp/ssh-mcp.service`, ścieżka do Node jest twarda i zależna od środowiska.

**Mitigacja:**
- podczas wdrożenia sprawdzić `which node`,
- wpisać konkretną ścieżkę zgodną z hostem,
- opisać to jawnie w README.

---

## Propozycja testów i weryfikacji

### A. Testy jednostkowe

#### `config.test.ts`
Sprawdzić:
- sukces przy kompletnym env,
- błąd przy braku `OVH_APP_KEY`, `OVH_APP_SECRET`, `OVH_READ_CK`, `OVH_WRITE_CK`,
- poprawne parsowanie `OVH_ALLOWED_ZONES=a.com,b.com`,
- brak echo sekretów w wiadomości błędu.

#### `sanitize.test.ts`
Sprawdzić:
- maskowanie surowych wartości `AK`, `AS`, `CK`,
- maskowanie sekretów osadzonych w stack trace,
- maskowanie sekretów w zserializowanym JSON wyjątku.

#### `guards.test.ts`
Sprawdzić:
- allowlistę stref,
- blokadę mutacji poza allowlistą,
- walidację `ttl > 0`,
- walidację `zone` i `id`.

#### `tools.test.ts`
Sprawdzić:
- `list_zones` używa `readClient`,
- `create/update/delete/refresh` używają `writeClient`,
- `ensure_a_record` daje `noop` przy zgodnym rekordzie,
- `ensure_a_record` daje `created` przy braku rekordu,
- `ensure_a_record` daje `updated` przy różnym target,
- `ensure_a_record` daje `ambiguous` przy wielu kandydatach.

### B. Testy integracyjne / smoke bezpieczne
Jeśli będą prawdziwe credentiale i strefa testowa:
1. `get_me` — test autoryzacji read-only.
2. `list_zones` — test listowania stref.
3. `list_records(zone)` — test odczytu strefy.
4. Próba `create_record` lub `ensure_a_record` na strefie testowej z allowlisty.
5. `refresh_zone(zone)`.
6. `get_record(zone, id)` po zmianie.
7. `delete_record(zone, id)` tylko jeśli użyto rekordu testowego.

### C. Testy bezpieczeństwa
1. Próba mutacji w strefie poza `OVH_ALLOWED_ZONES` — oczekiwany błąd lokalny, bez requestu do OVH.
2. Wstrzyknięcie sekretu do mockowanego wyjątku klienta — oczekiwane zamaskowanie w odpowiedzi MCP.
3. HTTP request bez `MCP_TOKEN` — `401`.
4. HTTP request z błędnym tokenem — `401`.
5. Start z `PORT` i bez `MCP_TOKEN` — twarda blokada startu z kontrolowanym błędem.

### D. Weryfikacja build/runtime
Uruchomić:
```bash
cd /home/ubuntu/Desktop/mcp-ovh
npm run build
npm run typecheck
npm run test
```

Jeśli jest smoke script:
```bash
npm run start
PORT=8080 MCP_TOKEN=test-token npm run start
```

---

## Definicja ukończenia
Task jest ukończony, gdy wszystkie poniższe warunki są spełnione:

1. Istnieje osobny projekt w `/home/ubuntu/Desktop/mcp-ovh`.
2. Projekt buduje się i uruchamia jako MCP server w `stdio`.
3. Projekt opcjonalnie uruchamia się także w HTTP mode, ale wyłącznie z ustawionym `MCP_TOKEN`.
4. Serwer wystawia tylko wąskie tools DNS, bez raw proxy do całego OVH API.
5. Sekrety OVH są pobierane wyłącznie z env po stronie serwera MCP.
6. Są osobne profile credentiali `readClient` i `writeClient`.
7. Mutacje są blokowane poza `OVH_ALLOWED_ZONES`.
8. Dostępne są co najmniej tools:
   - `list_zones`
   - `list_records`
   - `get_record`
   - `get_me`
   - `create_record`
   - `update_record`
   - `delete_record`
   - `refresh_zone`
   - `ensure_a_record`
9. Logi i błędy nie ujawniają `AK` / `AS` / `CK`.
10. Repo zawiera `.env.example`, `README.md` i `ovh-mcp.service`.
11. Istnieje minimalny zestaw testów / walidacji obejmujący konfigurację, guardraile i sanitizację.
12. Jest wykonany co najmniej jeden smoke test read-only oraz jeden smoke test mutacji na bezpiecznej strefie testowej lub z mockami, jeśli prawdziwe credentiale nie są dostępne.

---

## Rekomendacja końcowa
Najbezpieczniejszy i najszybszy kierunek MVP to:
- zachować wzorzec transportów z `/home/ubuntu/Desktop/mcp`,
- ale od razu rozdzielić kod na małe moduły,
- ograniczyć scope do DNS,
- zrobić twardy split `readClient` / `writeClient`,
- postawić allowlistę stref jako obowiązkowy guardrail dla mutacji,
- potraktować `ensure_a_record` jako jedyny „smart” tool MVP, a resztę zostawić prostą i przewidywalną.

Taki zakres minimalizuje ryzyko wycieku sekretów i nadużyć, a jednocześnie daje agentowi praktyczny zestaw operacji do bezpiecznej pracy na OVH DNS.