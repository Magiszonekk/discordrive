# TASK-003: ogarnąć temat testów w discordrive

## Opis taska
Przejrzeć obecne testy w projekcie discordrive, ocenić które warto zostawić, które usunąć lub przepisać, oraz określić jakie nowe testy przydałyby się dla sensownego pokrycia najważniejszych ścieżek.

## Zakres koncepcji do ustalenia
- Jakie testy obecnie istnieją i jaki mają poziom wartości.
- Czy obecny podział na smoke / integration / unit ma sens.
- Które testy są zbyt kruche, redundantne albo za drogie w utrzymaniu.
- Jakich testów brakuje w krytycznych obszarach systemu.
- Jaki docelowy minimalny zestaw testów powinien zostać w repo.

## Pytania do sesji koncepcyjnej
- Czy celem jest tylko audyt + rekomendacje, czy też późniejsza implementacja zmian w testach?
- Czy preferowany jest minimalny zestaw testów szybki w CI, czy szerszy zestaw z integracją runtime/DB?
- Czy zostawiamy testy wymagające działającego lokalnie API/DB, czy wolimy bardziej izolowane testy in-process?

## Wstępne ustalenia z przeglądu repo
- Wbrew wcześniejszej ogólnej notce w repo, projekt ma już zalążek testów w `apps/api/src/__tests__` oraz konfigurację Vitest w `apps/api/vitest.config.ts`.
- Obecne testy API są w praktyce bardziej smoke/integration niż unit: uderzają przez HTTP do `http://localhost:3000/graphql` i jednocześnie wykonują operacje bezpośrednio przez `@ddv4/database`.
- To oznacza silne sprzężenie z lokalnie działającym API oraz prawdziwą bazą danych; taki zestaw daje wartość diagnostyczną, ale jest kruchy i mało wygodny jako szybki gate w CI.
- `health.test.ts` wygląda sensownie jako lekki smoke test endpointu GraphQL.
- `db-connection.test.ts` ma ograniczoną wartość jako osobny test — głównie powiela informację "czy DB odpowiada" bez testowania logiki aplikacyjnej.
- `auth.test.ts` i `resolvers/files.test.ts` pokrywają ważne ścieżki biznesowe, ale obecnie są de facto testami integracyjnymi end-to-end zależnymi od środowiska, cleanupu danych i poprawnej konfiguracji auth/DB.
- W pakietach współdzielonych (`packages/processing`, `packages/stream-engine`, itd.) praktycznie nie ma jeszcze testów jednostkowych, mimo że właśnie tam są najlepsze kandydaty na szybkie, stabilne testy domenowe.
- Pierwsze wrażenie: obecny zestaw testów jest dobrym szkicem diagnostycznym dla backendu, ale nie stanowi jeszcze dobrze zbalansowanej strategii testów dla całego monorepo.
- Dla wariantu mieszanego sensowny kierunek to: szybki rdzeń (`typecheck`/`build` + unit testy w `packages/processing` + lekki smoke GraphQL) oraz mały zestaw cięższych testów integration dla auth i file/storage uruchamianych osobno albo w dedykowanym jobie.
- Wstępnie zaakceptowany kierunek dla TASK-003: strategia mieszana z małym, stabilnym rdzeniem testów oraz selektywnym zestawem frontendowych testów E2E dla najważniejszych flow użytkownika.

## Proponowany docelowy podział testów

### Unit (szybki rdzeń)
- `packages/processing/chunker.test.ts` — podział pliku na chunki, indeksowanie chunków, edge-case'y `calculateChunkCount`.
- `packages/processing/hash.test.ts` — znane SHA-256 dla stałych danych, zgodność `hashBuffer` i `hashStream`, pusty input.
- `packages/processing/crypto.test.ts` — roundtrip `toBase64`/`fromBase64`, `encryptChunk`/`decryptChunk`, `wrapKey`/`unwrapKey`, błąd dla uszkodzonego ciphertextu.
- `apps/api/auth-middleware.test.ts` — `extractToken`, podstawowe przypadki nagłówka `Authorization`, ewentualnie helpery auth niezależne od DB.

### Smoke
- `apps/api/graphql-health.test.ts` — lekkie sprawdzenie, że `/graphql` odpowiada i introspekcja / `{ __typename }` działa.

### Integration
- `apps/api/auth.integration.test.ts` — `register`, `login`, `login` z błędnymi danymi, `me` po poprawnym tokenie.
- `apps/api/storage.integration.test.ts` — `storageUsage`, podstawowe listowanie plików dla właściciela, ewentualnie najważniejsze query file metadata.
- Opcjonalnie osobny test share flow, jeśli feature sharing ma być traktowany jako krytyczny.

### Frontend E2E
- logowanie do aplikacji i wejście na główny widok.
- upload małego pliku i potwierdzenie, że pojawia się na liście.
- upload większego pliku testowego wymuszającego wiele chunków.
- utworzenie folderu i umieszczenie / przeniesienie do niego pliku.
- pobranie pliku i weryfikacja jego podstawowych właściwości lub zawartości.

## Założenia organizacyjne
- Fast CI: `typecheck`, `build`, unit tests, ewentualnie 1 lekki smoke test.
- Heavier / dedicated job: integration tests zależne od API/DB.
- Frontend E2E: mały zestaw krytycznych scenariuszy, uruchamiany osobno (np. nightly, ręcznie lub w dedykowanym jobie), a nie jako domyślny szybki gate dla każdego PR.
- E2E mają służyć jako warstwa "confidence", potwierdzająca najważniejsze flow użytkownika, a nie jako główne miejsce pokrywania wszystkich edge-case'ów.
