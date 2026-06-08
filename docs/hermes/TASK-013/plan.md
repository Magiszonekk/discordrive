# Plan implementacji TASK-013 – naprawa pobierania przez share link oraz revokacja linków

## 1. Lista plików do modyfikacji / tworzenia
| Plik | Typ | Powód modyfikacji |
|------|-----|-------------------|
| `apps/api/src/resolvers/sharing.ts` | modyfikacja | Sprawdzić i zapewnić, że `accessShare` nie wymaga tokenu sesyjnego, a jedynie capability token; dodać weryfikację statusu `revoked` i zwracanie odpowiedniego błędu.
| `apps/api/src/resolvers/sharing.ts` | dodanie nowej funkcji `listShares(fileId)` | UI dashboard potrzebuje listy aktywnych linków dla pliku.
| `apps/api/src/schema.ts` | modyfikacja | Dodanie pól i zapytań: `listShares(fileId: ID!): [Share!]!` oraz ewentualnie `shareStatus(shareId: ID!): ShareStatus!`.
| `apps/api/src/types.ts` (lub w `packages/types`) | dodanie typu `Share` z polami `id`, `fileId`, `status`, `createdAt`, `expiresAt`, `maxViews`, `revokedAt`.
| `apps/frontend/src/lib/media.ts` | modyfikacja | Obsługa nowego błędu `revoked` przy pobieraniu; zwracanie odpowiedniego `ShareState`.
| `apps/frontend/src/lib/download.ts` | modyfikacja | Przy pobieraniu używać samego capability token (bez Bearer) – zmiana endpointu lub headera.
| `apps/frontend/src/pages/Dashboard.tsx` (or .js) | modyfikacja | Dodanie UI listy share linków z przyciskiem **Revoke**; wywołanie nowego mutation `revokeShare` oraz odświeżenie listy.
| `apps/frontend/src/pages/Dashboard.tsx` | ewentualne nowe komponenty `ShareItem` | UI dla pojedynczego linku.
| `apps/api/src/__tests__/integration/share-access.integration.test.ts` | modyfikacja / dodanie testów | Testy: (a) pobranie w incognito (bez auth) succeeds; (b) po revocation dostęp zwraca błąd `revoked`.
| `apps/frontend/src/__tests__/unit/share-ui.test.ts` (lub podobny) | nowy plik | Testy UI: render list, kliknięcie revoke wywołuje mutation i usuwa element.
| `docs/hermes/TASK-013/plan.md` | nowy plik | **Ten plik** – zostaje zapisany.

## 2. Kolejność kroków implementacji
1. **Zrozumienie istniejącej logiki share** – przejrzeć `createShare`, `accessShare`, `revokeShare` w `apps/api/src/resolvers/sharing.ts`.  
2. **Modyfikacja `accessShare`**:
   - Upewnić się, że po weryfikacji capability token nie jest wymagany `Authorization: Bearer …`.
   - Dodać sprawdzenie `share.status !== 'REVOKED'` oraz `revokedAt`.
   - Zwracać kod/komunikat `revoked` jeśli odrzucony.
3. **Rozszerzenie schematu GraphQL**:
   - Dodaj `type Share { id: ID! fileId: ID! status: String! createdAt: Date! expiresAt: Date revokedAt: Date maxViews: Int currentViews: Int }`.
   - Dodaj zapytanie `listShares(fileId: ID!): [Share!]!`.
   - Dodaj mutation `revokeShare(shareId: ID!): Boolean!` (już istnieje, ale upewnij się, że zwraca `true` po sukcesie).
4. **Implementacja `listShares`** w resolverze – zwraca wszystkie sharey nie‑revoked (lub wszystkie, z flagą).
5. **Aktualizacja typów w `packages/types`** aby front‑end miał dostęp do nowych pól.
6. **Front‑end – media download**:
   - W `download.ts` przy pobieraniu pliku używać endpointu `/share/:shareId/blob?token=capabilityToken` bez `Authorization` header.
   - Obsłużyć odpowiedź 401/403 i zamapować na `ShareState.revoked`.
7. **Front‑end – dashboard UI**:
   - Pobierać listę share linków przez nowy query.
   - Wyświetlać tabelę z kolumnami: link, status, data utworzenia, data wygaśnięcia, maksymalna liczba view.
   - Przycisk **Revoke** wywołuje mutation `revokeShare`; po sukcesie odświeża listę.
8. **Testy backend**:
   - Dodaj test „download without auth succeeds” – symuluje incognito przy pomocy capability token.
   - Test „revoked share blocks download” – po wywołaniu `revokeShare` oczekuj błąd `revoked`.
9. **Testy front‑end** (jeśli projekt używa np. React Testing Library):
   - Mock GraphQL query `listShares`, sprawdź render, kliknięcie revoke wywołuje mutation i usuwa element.
10. **E2E manualny**: uruchom aplikację, utwórz share, otwórz w trybie incognito, pobierz; następnie revoke i upewnij się, że link przestaje działać.
11. **Dokumentacja** – zaktualizuj README/README.md sekcję Share Flow.
12. **Commit, CI, build** – uruchom `npm run typecheck`, `npm run build`, `npm run test`.

## 3. Potencjalne problemy i rozwiązania
| Problem | Rozwiązanie |
|---------|-------------|
| 401 nadal pojawia się po zmianie endpointu – przyczyna może leżeć w middleware autoryzacji (globalny `auth` guard). | W `apps/api/src/middleware/auth.ts` dodać wyjątek dla ścieżki `/share/:shareId/*` kiedy jest podany `capabilityToken`. |
| Cache (Redis) może przechowywać status share przed revokacją. | Po `revokeShare` wywołać `redis.del(shareCacheKey)` lub zaktualizować cache. |
| Front‑end może cachować stare linki. | Po revocation odświeżać listę oraz dodać `Cache-Control: no-store` w odpowiedzi blob. |
| Brak typów w GraphQL po dodaniu `listShares`. | Zaktualizować generatory typów (`npm run graphql:codegen`) i uruchomić `typecheck`. |
| Testy integracyjne wymagają uruchomienia bazy i Discord client mock. | Wykorzystać już istniejące fixture’y w `apps/api/src/__tests__/integration/` – dodaj nowy test podobny do istniejącego `share-access.integration.test.ts`. |

## 4. Propozycja testów
### Backend (Jest / integration)
1. **should download file via share link without auth** – tworzy share, wywołuje `accessShare` z capability token, oczekuje `status: OK` i poprawny blob URL.
2. **should reject download after revoke** – po `revokeShare` wywołuje `accessShare`, oczekuje błąd `revoked` (HTTP 403 lub kod w odpowiedzi).
3. **listShares returns correct entries** – tworzy dwa sharey (jeden aktywny, jeden revoked) i sprawdza, że query zwraca odpowiednie statusy.

### Frontend (React Testing Library)
1. **Dashboard renders share list** – mock GraphQL query, sprawdza, że tabela zawiera linki.
2. **Revoke button works** – po kliknięciu wywołuje mutation i usuwa element z listy.
3. **Download component handles revoked state** – symuluje pobranie i sprawdza, że UI pokazuje komunikat "Link został cofnięty".

## 5. Definicja ukończenia
- **Funkcjonalność**: otwarcie share linku w przeglądarce incognito umożliwia pobranie pliku bez błędu 401.
- **Revokacja**: w dashboardzie użytkownik może zobaczyć listę linków i kliknąć **Revoke**; po tym link natychmiast zwraca błąd `revoked` i nie pozwala na pobranie.
- **Testy**: przynajmniej dwa testy backendowe i dwa front‑endowe przechodzą (`npm run test`).
- **Typy**: wszystkie nowe pola i resolvery poprawnie typowane (type‑check przechodzi).
- **Build**: aplikacja buduje się (`npm run build`) i uruchamia (`npm run dev`) bez błędów.
- **Dokumentacja**: `docs/hermes/TASK-013/plan.md` (ten plik) oraz ewentualna aktualizacja README opisująca nowy flow.

---
*Plan przygotowany automatycznie. Wprowadź zmiany zgodnie z kolejnością i uruchom testy.*