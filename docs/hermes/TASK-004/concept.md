# TASK-004 — Frontend mobile friendly

## Opis taska
Dostosować frontend projektu `discordrive`, aby był mobile friendly — zarówno pod kątem layoutu, nawigacji, czytelności, jak i podstawowej używalności na małych ekranach oraz urządzeniach dotykowych.

## Cel
Wypracować i wdrożyć taki zakres zmian, żeby frontend działał sensownie na telefonach i mniejszych tabletach bez psucia desktopowego UX.

## Ustalenia koncepcyjne
- Nie robimy rozbudowanej fazy koncepcyjnej — bazujemy na szybkim audycie obecnego frontendu i od razu przekładamy to na konkretne decyzje implementacyjne.
- Priorytetem jest **realna używalność na telefonie**, a nie tylko kosmetyczna responsywność.
- Desktopowy UX ma zostać zachowany tam, gdzie jest sensowny.

## Uzgodniony kierunek

### 1. Nawigacja i layout
Wybrano wariant **1B / rekomendowany kierunek layoutu**:
- **desktop:** obecny sidebar zostaje,
- **mobile:** pojawia się **topbar + hamburger + wysuwany sidebar (drawer) z lewej strony**,
- drawer ma overlay i zamyka się po kliknięciu poza nim oraz po wyborze linku.

### 2. Header dashboardu
Wybrano **Opcję A**:
- na mobile header dashboardu ma przechodzić w układ pionowy,
- breadcrumb / tytuł u góry,
- główny przycisk akcji (`Upload`) pod spodem, preferencyjnie na pełną szerokość.

### 3. Lista plików
Wybrano **Opcję A + D**:
- **desktop:** tabela zostaje,
- **mobile:** zamiast tabeli renderowana jest **lista kart**,
- akcje dla pliku mają być uproszczone i przeniesione do bardziej mobilnego UI, preferencyjnie **menu „więcej” / action menu** zamiast szeregu drobnych ikon.

### 4. Modale / overlaye
Wybrano **Opcję A** dla mobile modal UX:
- `ShareModal` ma dostać bardziej mobilną formę (sheet albo fullscreen mobile-first overlay),
- `VideoPlayer` ma działać jako bardziej naturalny overlay na mobile, zgodnie z wcześniejszą rekomendacją fullscreen mobile.

### 5. Drag & drop upload
Wybrano **Opcję A**:
- mobilny widok ma **ukrywać desktopowy dropzone**,
- na telefonie zostaje czytelny standardowy przycisk uploadu.

### 6. Upload progress
Wybrano **Opcję A**:
- panel uploadów na mobile ma być **zwijany (collapsible)**,
- domyślnie ma nie zajmować niepotrzebnie dużej części ekranu.

### 7. Breadcrumb / folder context
Wybrano **Opcję A**:
- na mobile breadcrumb ma zostać uproszczony,
- preferowany kierunek: **Back + uproszczony kontekst aktualnego folderu** zamiast desktopowego układu breadcrumb.

## Dodatkowe ustalenia z audytu
- Touch targety i gęstość UI mają zostać poprawione zgodnie z wcześniejszą rekomendacją responsive sizing dla mobile.
- Auth pages i Settings nie wymagają pełnego redesignu, ale mają dostać lekki mobile polish:
  - lepsze spacingi,
  - bardziej komfortowe CTA,
  - sensowne zachowanie na małych ekranach.
- Zakładamy podejście etapowe:
  1. layout + nawigacja,
  2. dashboard i files view,
  3. modale / upload UX,
  4. polish pozostałych ekranów.

## Definicja oczekiwanego efektu
Po wdrożeniu:
- aplikacja ma być wygodna w użyciu na telefonie,
- nawigacja ma być dostępna bez stałego zajmowania szerokości ekranu,
- lista plików ma być czytelna i łatwa w obsłudze dotykiem,
- najważniejsze flow (nawigacja, upload, przeglądanie plików, akcje na plikach, share flow) mają być sensowne na mobile,
- desktop nie ma zostać niepotrzebnie pogorszony.
