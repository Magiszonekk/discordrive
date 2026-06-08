# TASK-003: Plan implementacji — przegląd strategii testów w discordrive

**Status:** draft  
**Data:** 2026-04-23  
**Powiązana koncepcja:** `docs/hermes/TASK-003/concept.md`

---

## Cel planu

Przeprowadzić audyt obecnych testów, podjąć decyzje keep/remove/refactor dla każdego pliku testowego, a następnie zaimplementować docelową strukturę testów zgodną ze strategią mieszaną opisaną w koncepcji. Plan dzieli pracę na małe, weryfikowalne etapy.

---

## Etap 0 — Przegląd i audyt (bez zmian w kodzie)

**Cel:** udokumentować stan obecny i podjąć ostateczne decyzje przed jakąkolwiek zmianą.

### Zadania

1. Przeczytać i uruchomić każdy istniejący plik testowy (jeśli środowisko dostępne), zanotować wyniki.
2. Wypełnić tabelę decyzji poniżej.
3. Zatwierdzić tabelę przed przejściem do Etapu 1.

### Tabela decyzji — obecne testy

| Plik | Typ (obecny) | Wartość | Decyzja | Uwagi |
|------|-------------|---------|---------|-------|
| `apps/api/src/__tests__/health.test.ts` | Smoke/HTTP | Średnia–wysoka | **KEEP + refactor** | Przenieść do `graphql-health.test.ts`, upewnić się że działa bez pełnego backendu lokalnie lub oznaczyć jako smoke job |
| `apps/api/src/__tests__/db-connection.test.ts` | Smoke/DB | Niska | **REMOVE** | Nie testuje logiki aplikacyjnej; informacja o dostępności DB jest powiązana z testami integracyjnymi |
| `apps/api/src/__tests__/auth.test.ts` | Integration/E2E | Wysoka | **KEEP + refactor** | Przenieść do `auth.integration.test.ts`, wydzielić jako osobny job (wymaga API + DB) |
| `apps/api/src/__tests__/resolvers/files.test.ts` | Integration/E2E | Wysoka | **KEEP + refactor** | Przenieść do `storage.integration.test.ts`, oznaczyć jako integration job |

**Artefakt etapu:** uzupełniona tabela w tym dokumencie (aktualizacja przed przejściem dalej).  
**Kryterium zakończenia:** wszystkie decyzje zatwierdzone, brak otwartych pytań o zakres.

---

## Etap 1 — Reorganizacja istniejących testów

**Cel:** doprowadzić istniejące testy do stanu odpowiadającego docelowej strukturze katalogów, bez pisania nowych przypadków testowych.

### Zadania

1. Stworzyć nową strukturę katalogów:
   ```
   apps/api/src/__tests__/
   ├── smoke/
   │   └── graphql-health.test.ts        # przeniesiony health.test.ts
   ├── integration/
   │   ├── auth.integration.test.ts      # przeniesiony auth.test.ts
   │   └── storage.integration.test.ts   # przeniesiony files.test.ts
   └── unit/
       └── (pusty, wypełniony w Etapie 2)
   ```
2. Usunąć `db-connection.test.ts`.
3. Zaktualizować `vitest.config.ts`:
   - domyślny include: `src/__tests__/smoke/**` + `src/__tests__/unit/**`
   - osobny config lub flaga środowiskowa dla `integration/**`
4. Upewnić się, że `npm test` (bez dodatkowych flag) uruchamia tylko smoke + unit.

**Artefakt etapu:** PR / commit z przeorganizowanymi plikami.  
**Kryterium zakończenia:** `npm test` przechodzi bez integration testów, integration testy uruchamiają się poprawnie przy jawnym wskazaniu configu.

---

## Etap 2 — Nowe testy jednostkowe w `packages/processing`

**Cel:** zbudować szybki, stabilny rdzeń testów domenowych niezależnych od DB i HTTP.

### Pliki do stworzenia

| Plik | Priorytet | Co testować |
|------|-----------|-------------|
| `packages/processing/src/__tests__/chunker.test.ts` | P0 | `calculateChunkCount`, podział bufora na N chunków, edge case: plik < chunk size, plik == chunk size, plik wielokrotność chunk size |
| `packages/processing/src/__tests__/hash.test.ts` | P0 | `hashBuffer` dla znanych danych → oczekiwany SHA-256, zgodność `hashBuffer` z `hashStream` dla tych samych danych, pusty input |
| `packages/processing/src/__tests__/crypto.test.ts` | P1 | roundtrip `encryptChunk` → `decryptChunk`, `wrapKey` → `unwrapKey`, `toBase64`/`fromBase64`, błąd dla uszkodzonego ciphertextu |

### Zadania

1. Sprawdzić eksportowane funkcje w `packages/processing/src/` i dobrać przypadki testowe.
2. Dodać `vitest.config.ts` do `packages/processing` (lub rozszerzyć root config).
3. Napisać testy — bez mocków zewnętrznych zależności, tylko czysta logika.
4. Dodać `"test"` script do `packages/processing/package.json`.
5. Zweryfikować, że `npm run test` z roota uruchamia też te testy (workspace).

**Artefakt etapu:** nowe pliki testowe + działający `npm test` w CI-mode.  
**Kryterium zakończenia:** min. 10 przypadków testowych przechodzi, czas < 5s.

---

## Etap 3 — Testy jednostkowe helpera auth w `apps/api`

**Cel:** wydzielić logikę auth-middleware do postaci testowalnej bez uruchamiania serwera.

### Zadania

1. Sprawdzić czy `extractToken` / logika parsowania `Authorization` header jest wyeksportowana jako czysta funkcja.
2. Jeśli tak — napisać `apps/api/src/__tests__/unit/auth-middleware.test.ts`.
3. Jeśli nie — ocenić koszt refaktoru: jeśli < 30 min, zrobić go tutaj; jeśli większy, oznaczyć jako tech-debt i pominąć w tym etapie.

**Artefakt etapu:** plik testowy lub wpis tech-debt w tym dokumencie.  
**Kryterium zakończenia:** decyzja podjęta i udokumentowana.

---

## Etap 4 — Konfiguracja CI: fast gate vs heavy job

**Cel:** skonfigurować podział jobów w CI zgodnie ze strategią mieszaną.

### Propozycja podziału

#### Fast gate (każdy PR, ~< 60s)
```
npm run typecheck
npm run build
npm test  # smoke + unit tylko
```

#### Heavy / integration job (dedykowany, np. scheduled lub ręczny)
```
docker compose up -d  # uruchomienie infra
npm run test:integration
docker compose down
```

### Zadania

1. Dodać script `"test:integration"` w `apps/api/package.json` wskazujący na `integration/**`.
2. Stworzyć / zaktualizować plik CI (np. `.github/workflows/ci.yml`) z dwoma jobami.
3. Upewnić się, że integration job ma health-check czekający na gotowość API i DB.
4. Dodać dokumentację zmiennych środowiskowych potrzebnych dla integration testów.

**Artefakt etapu:** zaktualizowany workflow CI.  
**Kryterium zakończenia:** fast gate przechodzi bez środowiska runtime; integration job wymaga jawnego uruchomienia.

---

## Etap 5 — Propozycja frontendowych testów E2E (opcjonalny)

**Cel:** przygotować plan dla warstwy E2E — bez implementacji w tym etapie.

> ⚠️ Ten etap to **propozycja do zatwierdzenia**, nie implementacja. Wymaga decyzji o narzędziu (np. Playwright) i środowisku staging.

### Proponowane scenariusze

| Scenariusz | Priorytet | Uwagi |
|-----------|-----------|-------|
| Logowanie i przejście na główny widok | P0 | Weryfikacja flow auth E2E |
| Upload małego pliku, potwierdzenie na liście | P0 | Najważniejszy happy path |
| Upload pliku > 1 chunk (wymusza multi-chunk) | P1 | Weryfikacja `stream-engine` + `processing` |
| Utworzenie folderu, przeniesienie pliku | P1 | Weryfikacja operacji na drzewie plików |
| Pobranie pliku, weryfikacja zawartości | P1 | Pełny roundtrip upload→download |

### Decyzje do podjęcia przed implementacją

- [ ] Zatwierdzić Playwright jako narzędzie E2E (lub alternatywę)
- [ ] Wskazać środowisko (lokalne, staging, CI z Docker Compose full-stack)
- [ ] Określić częstotliwość uruchomień (nightly, przed releasem, ręcznie)

**Artefakt etapu:** zatwierdzony dokument `docs/hermes/TASK-003/e2e-plan.md`.  
**Kryterium zakończenia:** decyzje podjęte i udokumentowane.

---

## Kolejność i zależności

```
Etap 0 (audyt)
    └─► Etap 1 (reorganizacja)
            ├─► Etap 2 (unit: processing)
            ├─► Etap 3 (unit: auth-middleware)
            └─► Etap 4 (CI config)  ← zależy od Etapu 1 + 2 + 3
                        └─► Etap 5 (E2E plan, opcjonalny)
```

Etapy 2 i 3 mogą iść równolegle po Etapie 1.

---

## Tech-debt i otwarte kwestie

| ID | Opis | Priorytet |
|----|------|-----------|
| TD-001 | `packages/stream-engine` i `packages/discord-client` — brak jakichkolwiek testów. Wymagają mocków Discord API; warto wrócić po ustabilizowaniu strategii. | Niski |
| TD-002 | Integration testy wymagają spójnego setupu / teardown danych testowych — rozważyć fabrykę fixture'ów | Średni |
| TD-003 | `packages/redis` — brak testów cache layer; można mockować ioredis | Niski |

---

## Definicja ukończenia TASK-003

- [ ] Tabela audytu (Etap 0) wypełniona i zatwierdzona
- [ ] Istniejące testy przeorganizowane zgodnie z nową strukturą (Etap 1)
- [ ] Min. 10 nowych unit testów w `packages/processing` przechodzi w < 5s (Etap 2)
- [ ] Decyzja o auth-middleware teście udokumentowana (Etap 3)
- [ ] CI workflow z podziałem fast/heavy działa (Etap 4)
- [ ] Plan E2E zatwierdzony lub świadomie odłożony z uzasadnieniem (Etap 5)
