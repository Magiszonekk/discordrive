# [TASK-011] Zdiagnozować niską prędkość uploadu w DiscordDrive

## Status
Koncepcja / root-cause investigation

## Zgłoszenie użytkownika
Na https://discordrive.cikowice.pl/ upload pliku osiąga około 4 MB/s, mimo że speedtest łącza pokazuje około 1000/600. Użytkownik chce zrozumieć skąd bierze się limit oraz czy warto dodać logowanie z frontendu do backendu, aby łatwiej debugować bottleneck.

## Cele
- Przeanalizować aktualny pipeline uploadu w DiscordDrive.
- Zidentyfikować potencjalne bottlenecks architektoniczne, sieciowe lub implementacyjne.
- Sprawdzić istniejące benchmarki / testy wydajnościowe.
- Ocenić sens i zakres dodatkowego logowania FE → BE.
- Przygotować rekomendacje dalszych kroków.

## Hipotezy do sprawdzenia
- Bottleneck nie leży w speedteście łącza, tylko w samym pipeline uploadu (chunking, szyfrowanie, Discord API, storage abstraction, concurrency).
- Frontend może wysyłać dane sekwencyjnie albo zbyt małymi chunkami.
- Backend może ograniczać throughput przez CPU, serializację, Discord rate limits lub sposób zapisu blobów.
- Brakuje telemetry / structured logs pozwalających zobaczyć czas per etap uploadu.

## Pytania badawcze
- Jak dokładnie wygląda przepływ uploadu od przeglądarki do finalnego storage?
- Jakie są rozmiary chunków, poziom równoległości i retry logic?
- Czy istnieją już benchmarki E2E / integration testy dla storage/uploadu?
- Czy 4 MB/s jest zgodne z ograniczeniami Discord API lub obecną implementacją?
- Jakie logi/metryki dadzą największą wartość diagnostyczną przy najmniejszym koszcie?
