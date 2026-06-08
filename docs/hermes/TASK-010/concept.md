# [TASK-010] stworzyć serwer MCP do bezpiecznego dostępu do OVH API bez podawania credentiali agentowi

## Opis taska
Użytkownik chce zaprojektować i najpewniej wdrożyć osobny serwer MCP obok istniejącego projektu w `~/Desktop/mcp`, tak aby agent korzystał z narzędzi MCP zamiast bezpośrednio dostawać credentiale OVH (`AK/AS/CK`).

## Stan rozpoznania
- W `~/Desktop/mcp` istnieje już działający serwer MCP w TypeScript/Node.js.
- Obecny serwer używa `@modelcontextprotocol/sdk`, wspiera zarówno `stdio`, jak i `StreamableHTTP`, ma auth token dla HTTP i jest uruchamiany jako systemd service.
- Architektura istniejącego serwera jest dobrym wzorcem do postawienia sibling projektu obok niego.

## Wstępne założenia
- serwer MCP ma wystawić bezpieczne operacje na OVH API
- credentiale mają pozostać po stronie serwera MCP, nie w promptach agenta
- istnieją różne `consumerKey` dla odczytu i dla mutacji DNS
- trzeba obsłużyć rozdział uprawnień i ograniczyć ryzyko nadużyć
- nowy serwer może zostać postawiony obok istniejącego serwera MCP w `~/Desktop/mcp`

## Rekomendowany kierunek architektury
### 1. Nie robić generycznego proxy do całego OVH API
Lepiej wystawić wąskie, domenowe tools niż uniwersalne `ovh_request(method, path, body)`.

Powód:
- łatwiejsze guardraile
- mniejsze ryzyko nadużyć
- prostszy auditing
- łatwiejsze routowanie do właściwego CK

### 2. Rozdzielić tools read-only i mutation na poziomie implementacji
Najbezpieczniej mieć wspólny serwer, ale wewnętrznie dwa profile credentiali:
- `readClient` → AK/AS + CK do odczytu
- `writeClient` → AK/AS + CK do mutacji

Routing:
- listing / get / inspect → `readClient`
- create / update / delete / refresh → `writeClient`

### 3. Na start ograniczyć scope do DNS OVH
Najlepsze MVP:
- lista domen/stref
- lista rekordów w strefie
- pobranie konkretnego rekordu
- dodanie rekordu
- update rekordu
- delete rekordu
- refresh strefy
- opcjonalnie: `ensure_a_record` / `ensure_cname_record`

Dopiero później ewentualnie:
- VPS endpoints
- cert / mail / inne usługi OVH

### 4. Ograniczyć mutacje do allowlisty stref
Np. w configu:
- `OVH_ALLOWED_ZONES=cikowice.pl,...`

Dzięki temu nawet write CK nie będzie używany poza dozwolonymi strefami.

### 5. Sekrety w `.env`, nie w rozmowie
Proponowany zestaw:
- `OVH_APP_KEY`
- `OVH_APP_SECRET`
- `OVH_READ_CK`
- `OVH_WRITE_CK`
- `OVH_ALLOWED_ZONES`
- `MCP_TOKEN` jeśli będzie HTTP mode

## Proponowane MCP tools
### Read-only
- `ovh_list_zones()`
- `ovh_list_records(zone, fieldType?, subDomain?)`
- `ovh_get_record(zone, id)`
- `ovh_get_me()`

### Mutation
- `ovh_create_record(zone, fieldType, subDomain, target, ttl?)`
- `ovh_update_record(zone, id, target?, ttl?, subDomain?)`
- `ovh_delete_record(zone, id)`
- `ovh_refresh_zone(zone)`
- `ovh_ensure_a_record(zone, subDomain, target, ttl?)`

## Decyzje bezpieczeństwa do utrzymania
- brak toola raw proxy do dowolnego path
- mutacje tylko dla allowlisty zones
- jawny routing read/write CK
- bez logowania sekretów
- błędy mają nie wypisywać AK/AS/CK

## Pytania projektowe do doprecyzowania
- czy serwer ma obsługiwać tylko DNS OVH, czy szerzej także inne endpointy OVH
- czy chcemy osobne MCP tools do read-only i do mutacji, czy jeden tool z polityką routingu do odpowiedniego CK
- czy mutacje mają być jawnie zawężone np. tylko do `cikowice.pl`
- czy serwer ma być stdio-only dla Hermesa, czy też opcjonalnie HTTP/remote MCP

## Moja rekomendacja MVP
- osobny sibling project obok `~/Desktop/mcp`, np. `~/Desktop/mcp-ovh`
- TypeScript + ten sam MCP SDK
- stdio + opcjonalnie HTTP jak w obecnym serwerze
- tylko DNS scope
- read/write split przez dwa CK
- allowlista stref
- później dopiero rozszerzenie na inne usługi OVH
