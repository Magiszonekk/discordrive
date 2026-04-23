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
