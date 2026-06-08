# TASK-003: Plan E2E

## Status
Propozycja do zatwierdzenia

## Cel
Dodać mały, utrzymywalny zestaw frontendowych testów end-to-end, który potwierdza najważniejsze flow użytkownika bez zamieniania E2E w główną warstwę pokrycia całego systemu.

## Proponowane narzędzie
- **Playwright** — jako preferowana opcja do wdrożenia.
- Uzasadnienie: dobre wsparcie dla nowoczesnego frontendu, sensowna praca w CI, screenshoty/video/logi przy failach, wygodne fixture'y i storage state.

## Zakres scenariuszy

### P0
1. **Logowanie i wejście na główny widok**
   - użytkownik loguje się poprawnymi danymi
   - aplikacja przechodzi do głównego widoku
   - brak błędu auth / redirect loop

2. **Upload małego pliku i pojawienie się na liście**
   - upload pliku o małym rozmiarze
   - po zakończeniu plik jest widoczny na liście
   - podstawowe metadane zgadzają się z oczekiwaniem

### P1
3. **Upload większego pliku wymuszającego wiele chunków**
   - plik jest dzielony na wiele chunków
   - upload kończy się sukcesem
   - plik jest finalnie widoczny jako gotowy

4. **Utworzenie folderu i przeniesienie pliku**
   - użytkownik tworzy folder
   - przenosi plik do folderu
   - widok listy odzwierciedla zmianę

5. **Pobranie pliku i podstawowa weryfikacja zawartości**
   - użytkownik pobiera plik
   - test potwierdza nazwę / rozmiar / podstawową zgodność zawartości

## Założenia uruchomieniowe
- E2E nie są częścią domyślnego szybkiego gate dla każdego PR.
- Preferowany tryb uruchamiania:
  - ręcznie,
  - nightly,
  - przed releasem,
  - albo w dedykowanym jobie full-stack.
- Środowisko powinno zapewniać:
  - działający frontend,
  - działające API,
  - działającą bazę,
  - testowe dane / konto,
  - stabilne webhooki lub tryb testowy ograniczający zależność od produkcyjnego Discorda.

## Ryzyka
- E2E będą drogie i kruche, jeśli będą zależne od realnego środowiska Discord bez warstwy testowej.
- Flow upload/download może wymagać dodatkowych helperów lub fixture'ów do przygotowania danych.
- Bez jasnego środowiska testowego utrzymanie E2E może być nieproporcjonalnie kosztowne.

## Decyzje do zatwierdzenia
- [ ] Czy wdrażamy Playwright?
- [ ] Czy E2E mają działać lokalnie, w CI full-stack, czy tylko na staging?
- [ ] Czy upload/download w E2E ma używać prawdziwego Discord storage, czy warstwy testowej/mockowanej?
- [ ] Czy uruchomienia mają być nightly, manualne, czy release-only?

## Rekomendacja
Na teraz traktować E2E jako **warstwę confidence**, a nie główny mechanizm testowania logiki. Najpierw utrzymać stabilny rdzeń: `typecheck`, `build`, smoke, unit, integration. Dopiero potem wdrażać mały zestaw Playwright P0/P1.
