# TASK-004 — Plan implementacji: Mobile Friendly Frontend

> **Status:** Do implementacji  
> **Oparty o:** concept.md + audyt kodu (apps/frontend/src)  
> **Język:** TypeScript + React + Tailwind CSS

---

## 1. Pliki do modyfikacji / stworzenia

### Pliki modyfikowane

| Plik | Zakres zmian | Uzasadnienie |
|------|-------------|-------------|
| `components/layout/MainLayout.tsx` | Pełna przebudowa layoutu — dodanie topbara, hamburgera, drawera | Obecnie `<aside>` jest zawsze widoczny, brak jakiejkolwiek obsługi mobile |
| `pages/Dashboard.tsx` | Header pionowy na mobile, ukrycie dropzone na mobile | `flex items-center justify-between` rozjeżdża się na małych ekranach; dropzone (`border-dashed`) nie ma sensu na dotykowym |
| `components/files/FileTable.tsx` | Warunkowe renderowanie: tabela (md+) vs karty (mobile); akcje w menu „więcej" na mobile | Tabela z 4 kolumnami nie mieści się na 375px; drobne ikony działań (15px) są niehittable na dotykowym |
| `components/files/FolderBreadcrumb.tsx` | Uproszczony wariant mobile: przycisk Back + nazwa folderu | Obecna implementacja jest prosta, ale `text-sm flex items-center gap-2` nie dostosowuje się do kontekstu mobile |
| `components/files/UploadProgress.tsx` | Zwijany panel (collapsible) na mobile | Panel zajmuje dużo miejsca, szczególnie przy wielu uploadach; brak `useState` do zarządzania zwinięciem |
| `components/files/ShareModal.tsx` | Bottom sheet na mobile zamiast wycentrowanego modala | `fixed inset-0 flex items-center justify-center` działa, ale `max-w-md mx-4` może być za wąskie i niekomfortowe na małych ekranach; brak swipe-to-close |
| `components/video/VideoPlayer.tsx` | Pełnoekranowy overlay na mobile (bez `max-w-5xl`, pełna wysokość viewportu) | `max-w-5xl mx-4` + `aspect-video` na telefonie zostawia duże puste pola; na mobile wideo powinno zajmować cały ekran |
| `pages/Settings.tsx` | Lekki mobile polish: padding, CTA na pełną szerokość | `p-6 max-w-2xl` jest OK, ale `px-4 py-2` na przycisku Log out jest za małym touch targetem |
| `pages/Login.tsx` | Lekki mobile polish: padding, touch targety | Analogicznie do Settings |
| `pages/Register.tsx` | Lekki mobile polish | Analogicznie |

### Pliki do stworzenia (nowe komponenty)

| Plik | Uzasadnienie |
|------|-------------|
| `components/layout/MobileTopbar.tsx` | Wyodrębniony topbar z hamburgerem — logika otwierania drawera, tytuł aplikacji |
| `components/layout/MobileDrawer.tsx` | Wysuwany sidebar z overlay, animacja, zamykanie po kliknięciu poza/wyborze linku |
| `components/files/FileCard.tsx` | Karta pliku/folderu do renderowania na mobile zamiast wiersza tabeli |
| `components/files/FileActionMenu.tsx` | Dropdown/popover „więcej" z akcjami (download, share, delete, play) — mobile-first, ale użyty też w karcie |

---

## 2. Kolejność wdrożenia — etapy

### Etap 1 — Layout i nawigacja (fundament)

**Pliki:** `MainLayout.tsx`, `MobileTopbar.tsx` (nowy), `MobileDrawer.tsx` (nowy)

**Kroki:**
1. Stworzyć `MobileDrawer.tsx`:
   - `fixed inset-0 z-40` overlay (półprzezroczysty czarny)
   - `fixed top-0 left-0 h-full w-64 z-50 bg-zinc-900` wysuwany panel
   - animacja translateX przez Tailwind (`translate-x-0` / `-translate-x-full`) + `transition-transform`
   - props: `open: boolean`, `onClose: () => void`, `children: ReactNode`
2. Stworzyć `MobileTopbar.tsx`:
   - `flex items-center justify-between px-4 h-14 bg-zinc-900 border-b border-zinc-800`
   - przycisk hamburgera (ikona `Menu` z lucide) po lewej, tytuł "DiscorDrive" pośrodku lub po lewej
   - props: `onMenuOpen: () => void`
3. Zmodyfikować `MainLayout.tsx`:
   - dodać `useState<boolean>` (`drawerOpen`)
   - na `md:hidden` — renderować `<MobileTopbar>` + `<MobileDrawer>` z nawigacją
   - na `hidden md:flex` — obecny sidebar (bez zmian)
   - `<main>` dostaje `pt-14 md:pt-0` (miejsce na topbar na mobile)
   - linki w drawerze wywołują `onClose` po kliknięciu

**Weryfikacja etapu:** Na widoku 375px pojawia się topbar z hamburgerem, sidebar jest ukryty. Po kliknięciu hamburgera wysuwa się drawer. Kliknięcie poza nim lub wybranie linku go zamyka. Na 1024px+ — klasyczny sidebar bez zmian.

---

### Etap 2 — Dashboard: header + dropzone

**Pliki:** `Dashboard.tsx`

**Kroki:**
1. Zamienić `flex items-center justify-between mb-6` na układ responsywny:
   - `flex flex-col gap-3 mb-6 md:flex-row md:items-center md:justify-between`
   - przycisk Upload na mobile: `w-full md:w-auto`
2. Dropzone (`border-dashed`): owinąć w `<div className="hidden md:block mb-4">` — całkowicie ukryć na mobile
3. Drag & drop handlery (`onDragEnter`, `onDragLeave`, `onDrop`) zostawić na wrapperi, ale na mobile nie przeszkadzają (touch nie triggeruje drag events)

**Weryfikacja etapu:** Na mobile header jest pionowy: breadcrumb/tytuł u góry, przycisk Upload na całą szerokość poniżej. Dropzone niewidoczny. Na desktopie bez zmian.

---

### Etap 3 — Lista plików: tabela → karty

**Pliki:** `FileTable.tsx`, `FileCard.tsx` (nowy), `FileActionMenu.tsx` (nowy)

**Kroki:**
1. Stworzyć `FileActionMenu.tsx`:
   - przycisk `MoreVertical` (lub `EllipsisVertical`) otwierający dropdown
   - lista pozycji: Play (warunkowo), Download, Share (warunkowo), Delete (z potwierdzeniem)
   - dropdown pozycjonowany relatywnie do przycisku, zamykany po kliknięciu poza (`useEffect` + `document.addEventListener`)
   - touch-friendly: pozycje min `py-3 px-4` (44px touch target)
2. Stworzyć `FileCard.tsx`:
   - karta dla pliku: ikona mimeType / nazwa / rozmiar / data / `<FileActionMenu>`
   - karta dla folderu: ikona Folder / nazwa / liczba plików — `onClick` nawiguje
   - `bg-zinc-900 rounded-xl border border-zinc-800 p-4`
3. Zmodyfikować `FileTable.tsx`:
   - dodać hook/detekcję przez Tailwind: użyć warunkowego renderowania opartego na CSS breakpointach
   - strategia: renderować oba widoki z ukryciem przez CSS (`hidden md:block` / `md:hidden`), albo użyć `useMediaQuery` hooka
   - **rekomendowane podejście:** dwa renderowania z Tailwind:
     ```tsx
     {/* Mobile */}
     <div className="space-y-2 md:hidden"> ... karty ... </div>
     {/* Desktop */}
     <div className="hidden md:block"> ... tabela ... </div>
     ```
   - wyszukiwarka i paginacja wspólne dla obu widoków (bez zmian)

**Weryfikacja etapu:** Na 375px — karty z menu akcji. Na 1024px+ — tabela z ikonkami. Wszystkie akcje działają w obu widokach.

---

### Etap 4 — Modale i upload UX

**Pliki:** `ShareModal.tsx`, `VideoPlayer.tsx`, `UploadProgress.tsx`

#### 4a. ShareModal — bottom sheet na mobile

**Kroki:**
1. Zmienić strukturę wrappera:
   - Desktop (`md+`): obecny wycentrowany modal (`items-center justify-center`)
   - Mobile: bottom sheet — `items-end` na kontenerze, `w-full rounded-t-2xl`
2. Dodać `pb-safe` / `pb-6` na mobile (bezpieczny obszar na iPhone)
3. Zwiększyć touch targety inputów: `py-3` zamiast `py-2`
4. Przycisk zamknięcia: `p-2` minimum (48×48px area)

#### 4b. VideoPlayer — fullscreen na mobile

**Kroki:**
1. Wrapper video kontenera:
   - Desktop: obecny `max-w-5xl mx-4`
   - Mobile: `w-full h-screen` lub `w-full` bez `max-w` (pełna szerokość viewportu)
2. Usunąć ograniczenie `mx-4` na mobile (`md:mx-4`)
3. Aspect ratio: `aspect-video` zostaje, ale na mobile samo `w-full` + `aspect-video` wypełni ekran odpowiednio
4. Header z tytułem i przyciskiem zamknięcia: powiększyć przycisk zamknięcia do min 44px

#### 4c. UploadProgress — collapsible na mobile

**Kroki:**
1. Dodać `useState<boolean>` `collapsed` (domyślnie `false`, ale na mobile można rozważyć `true`)
2. Dodać nagłówek z licznikiem uploadów i przyciskiem toggle (chevron)
3. Na mobile: renderować tylko nagłówek gdy zwinięty
4. Nagłówek: `flex items-center justify-between px-3 py-2`
5. Ikona chevron rotuje (`rotate-180`) gdy rozwinięty

**Weryfikacja etapu 4:** ShareModal na mobile wysuwa się z dołu. VideoPlayer zajmuje pełną szerokość. UploadProgress ma przycisk zwijania, który ukrywa szczegóły uploadów.

---

### Etap 5 — Breadcrumb mobilny

**Pliki:** `FolderBreadcrumb.tsx`

**Kroki:**
1. Dodać wariant mobile: gdy `folderId !== null` — pokazać przycisk `← Back` linkujący do `/`
2. Desktop: obecny układ `Files / ...`
3. Implementacja przez Tailwind — dwa elementy z odpowiednimi `hidden md:flex` / `md:hidden`

```tsx
{/* Mobile: Back button */}
<div className="flex items-center gap-2 md:hidden">
  {folderId ? (
    <Link to="/" className="flex items-center gap-1 text-zinc-400 hover:text-white">
      <ChevronLeft size={16} />
      <span>Files</span>
    </Link>
  ) : (
    <span className="text-white text-sm">Files</span>
  )}
</div>
{/* Desktop: breadcrumb */}
<div className="hidden md:flex items-center gap-2 text-sm">
  {/* obecna implementacja */}
</div>
```

**Weryfikacja etapu:** Na mobile w folderze widoczny przycisk Back. Na desktopie — breadcrumb jak dotąd.

---

### Etap 6 — Polish pozostałych ekranów

**Pliki:** `Settings.tsx`, `Login.tsx`, `Register.tsx`

**Kroki:**

**Settings:**
- `p-6` → `p-4 md:p-6`
- `max-w-2xl` zostaje (sensowne)
- Przycisk Log out: `w-full md:w-auto` + `py-3 md:py-2` (większy touch target)
- Sekcja Account/Storage: padding kart `p-4 md:p-6`

**Login / Register:**
- Wrapper formularza: `mx-4 md:mx-auto` lub responsywny `max-w-sm w-full`
- Pola inputów: `py-3` zamiast `py-2`
- Przyciski submit: `py-3` zamiast `py-2`
- Upewnić się, że formularz nie jest przyciśnięty do krawędzi ekranu

**Weryfikacja etapu:** Strony auth i Settings są komfortowe na 375px — czytelne, z wygodnym spacingiem i dużymi touch targetami.

---

## 3. Ryzyka i pułapki

### Ryzyko 1 — Tailwind breakpointy vs JS media query
**Problem:** Użycie dwóch renderowań (desktop + mobile) przez klasy `hidden md:block` to najprostsze podejście, ale renderuje oba drzewa DOM. Przy `FileTable` z dużą listą może to zwiększyć czas renderowania.  
**Mitygacja:** Podejście z CSS jest wystarczające dla tej skali projektu. Alternatywnie — custom hook `useIsMobile()` z `window.matchMedia('(max-width: 767px)')` + `useEffect`/`useState` jeśli wydajność będzie problemem.

### Ryzyko 2 — Drawer a stacking context
**Problem:** `z-index` drawera/overlay może kolidować z modalami (`ShareModal`, `VideoPlayer` używają `z-50`).  
**Mitygacja:** Drawer powinien mieć `z-40` (overlay) i `z-50` (panel) — to samo co modale. Modale są otwierane tylko gdy drawer jest zamknięty, więc w praktyce nie powinno być konfliktu. Warto przypisać drawer `z-40/z-50`, ShareModal `z-50`, VideoPlayer `z-50`.

### Ryzyko 3 — `safe-area-inset` na iPhone
**Problem:** Na iPhone z notchem/Dynamic Island dolna część bottom sheet może nakrywać pasek gestów.  
**Mitygacja:** Dodać `pb-[env(safe-area-inset-bottom)]` lub fallback `pb-6` na ShareModal i potencjalnie UploadProgress. Tailwind nie ma tego out-of-box, ale można użyć inline style lub customowego pluginu.

### Ryzyko 4 — FileActionMenu pozycjonowanie
**Problem:** Dropdown przy karcie na samym dole listy może wychodzić poza viewport.  
**Mitygacja:** Zastosować `bottom-full` zamiast `top-full` dla ostatnich kart lub użyć prostego bottom sheet z listą akcji zamiast dropdownu pozycjonowanego absolutnie.

### Ryzyko 5 — `datetime-local` input na iOS
**Problem:** Input `type="datetime-local"` w ShareModal ma niespójny wygląd na Safari/iOS.  
**Mitygacja:** W ramach tego tasku wystarczy upewnić się, że input jest czytelny i hittable. Pełny redesign nie jest wymagany przez koncepcję.

### Ryzyko 6 — TypeScript typecheck
**Problem:** Projekt nie ma testów jednostkowych — weryfikacja przez `npm run typecheck`.  
**Mitygacja:** Po każdym etapie uruchamiać typecheck. Nowe komponenty (FileCard, FileActionMenu, MobileDrawer) muszą mieć poprawne typy props od razu.

---

## 4. Propozycja testów / weryfikacji

### Weryfikacja automatyczna (po każdym etapie)
```bash
npm run typecheck
```
Brak błędów TypeScript = minimum konieczne.

### Weryfikacja manualna — checklist

**Nawigacja (Etap 1):**
- [ ] Na 375px sidebar jest ukryty, widoczny topbar z hamburgerem
- [ ] Hamburger otwiera drawer z animacją
- [ ] Kliknięcie overlay zamyka drawer
- [ ] Wybranie linku zamyka drawer i nawiguje
- [ ] Na 1024px+ sidebar widoczny, topbar ukryty

**Dashboard (Etap 2):**
- [ ] Na mobile: przycisk Upload na całą szerokość, pod breadcrumbem
- [ ] Dropzone ukryty na mobile
- [ ] Na desktopie: wszystko bez zmian

**Lista plików (Etap 3):**
- [ ] Na mobile: karty zamiast tabeli
- [ ] Przycisk „więcej" otwiera menu akcji
- [ ] Każda akcja działa (download, share, delete, play)
- [ ] Folder karta nawiguje do folderu
- [ ] Wyszukiwarka i paginacja działają w widoku kart
- [ ] Na desktopie: tabela bez zmian

**ShareModal (Etap 4a):**
- [ ] Na mobile wysuwa się z dołu ekranu
- [ ] Pola formularza czytelne i wygodne
- [ ] Przycisk zamknięcia odpowiednio duży
- [ ] Na desktopie: modal wycentrowany jak dotąd

**VideoPlayer (Etap 4b):**
- [ ] Na mobile zajmuje pełną szerokość ekranu
- [ ] Wideo się odtwarza
- [ ] Przycisk zamknięcia dostępny

**UploadProgress (Etap 4c):**
- [ ] Widoczny nagłówek z licznikiem
- [ ] Przycisk zwinięcia działa
- [ ] Zwinięty panel nie zajmuje dużo miejsca

**Breadcrumb (Etap 5):**
- [ ] Na mobile w folderze: przycisk Back
- [ ] Na mobile w root: napis "Files"
- [ ] Na desktopie: breadcrumb jak dotąd

**Auth / Settings (Etap 6):**
- [ ] Login/Register: formularz nie przylega do krawędzi, przyciski duże
- [ ] Settings: przycisk Log out wygodny

### Narzędzia do weryfikacji
- Chrome DevTools → Device Toolbar → iPhone SE (375×667) i iPhone 14 (390×844)
- Firefox Responsive Design Mode
- Opcjonalnie: fizyczne urządzenie Android/iOS

---

## 5. Definicja ukończenia

TASK-004 jest ukończony gdy:

1. **Nawigacja:** Na mobile dostępna przez topbar + hamburger + drawer. Sidebar na desktopie bez zmian.
2. **Dashboard:** Header pionowy na mobile, dropzone ukryty na mobile, Upload button na pełną szerokość.
3. **Lista plików:** Na mobile renderowane karty z menu akcji. Na desktopie tabela bez zmian.
4. **ShareModal:** Bottom sheet na mobile.
5. **VideoPlayer:** Pełnoekranowy na mobile.
6. **UploadProgress:** Collapsible na mobile.
7. **Breadcrumb:** Back + kontekst folderu na mobile.
8. **Auth/Settings:** Lekki mobile polish (spacing, touch targety).
9. **TypeScript:** `npm run typecheck` przechodzi bez błędów.
10. **Desktop UX:** Żaden z desktopowych widoków nie jest pogorszony.

---

## 6. Podsumowanie etapów i szacunkowa kolejność

```
Etap 1 — Layout i nawigacja          [FUNDAMENT — zacząć tutaj]
  ├─ MobileTopbar.tsx (nowy)
  ├─ MobileDrawer.tsx (nowy)
  └─ MainLayout.tsx (modyfikacja)

Etap 2 — Dashboard header + dropzone
  └─ Dashboard.tsx (modyfikacja)

Etap 3 — Lista plików: karty + menu akcji
  ├─ FileCard.tsx (nowy)
  ├─ FileActionMenu.tsx (nowy)
  └─ FileTable.tsx (modyfikacja)

Etap 4 — Modale i upload UX
  ├─ ShareModal.tsx (modyfikacja)
  ├─ VideoPlayer.tsx (modyfikacja)
  └─ UploadProgress.tsx (modyfikacja)

Etap 5 — Breadcrumb
  └─ FolderBreadcrumb.tsx (modyfikacja)

Etap 6 — Polish pozostałych ekranów
  ├─ Settings.tsx (modyfikacja)
  ├─ Login.tsx (modyfikacja)
  └─ Register.tsx (modyfikacja)
```

Etapy 1-3 to core używalności na mobile. Etapy 4-6 to dopracowanie UX — mogą iść równolegle lub po sobie. Każdy etap można commitować osobno i weryfikować niezależnie.
