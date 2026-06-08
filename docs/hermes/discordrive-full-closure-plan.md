# DiscordDrive Full Closure Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Domknąć DiscordDrive nie tylko jako praktycznie gotowy Core v1 dependency, ale jako projekt, który można uczciwie nazwać w pełni domkniętym w obrębie uzgodnionego scope storage/security core.

**Architecture:** Obecny storage/share/blob core jest już w dużej mierze gotowy i przeszedł verification gate. Pozostały obszar ryzyka skupia się wokół auth/bootstrap oraz braku jednego jawnego, pełnego scenariusza end-to-end dla całego secure-files Core v1. Plan poniżej ma zamknąć właśnie te resztki: formalną walidację register/login crypto bootstrap, pełny smoke flow, oraz końcowe doprecyzowanie dokumentacyjne definition of done.

**Tech Stack:** TypeScript monorepo, GraphQL Yoga, Prisma/PostgreSQL, Vitest, Web Crypto API, Argon2id, Discord blob transport.

---

## Kiedy uznać projekt za naprawdę domknięty

DiscordDrive można nazwać **w pełni domkniętym w obecnym scope**, gdy spełnione są jednocześnie wszystkie warunki:
- obecny verification gate pozostaje zielony:
  - `npm run typecheck`
  - `npm test`
  - `npm run test:integration`
- register/login z crypto bootstrapem są sprawdzone dedykowanym testem lub zestawem testów
- [x] istnieje jeden pełny smoke/integration scenario przechodzący przez cały lifecycle Core v1
- checklista Core v1 nie ma już punktów „prawdopodobnie spełnionych, ale niezweryfikowanych”
- dokumentacja jasno rozdziela: co jest gotowym core contract, a co pozostaje poza zakresem

---

## Phase 1 — Domknięcie auth/bootstrap gate

### Task 1.1: Zinwentaryzować aktualny auth/bootstrap contract

**Objective:** Ustalić dokładnie, co register/login już gwarantują i czego brakuje wobec checklisty.

**Files:**
- Read: `apps/api/src/resolvers/auth.ts`
- Read: `apps/api/src/schema.ts`
- Read: `packages/types/src/api.ts`
- Read: istniejące testy auth w `apps/api/src/__tests__/`

**Step 1: Read current implementation**

Sprawdź:
- jakie pola zwraca register/login,
- czy ARK/recovery/argon2 params są spójne z oczekiwanym bootstrapem,
- czy istnieją już testy register/login i czego dokładnie dowodzą.

**Step 2: Write short gap note**

Wypisz w 3–6 punktach:
- co już jest pokryte,
- czego brakuje do odhaczenia „Register/login działa z crypto bootstrapem zgodnym z ARK + domain keys”.

**Step 3: No code changes yet**

To krok analityczny.

---

### Task 1.2: Dodać failing test auth/bootstrap contract

**Objective:** Zmusić repo do udowodnienia, że register/login rzeczywiście domykają crypto bootstrap, a nie tylko przechodzą przypadkiem.

**Files:**
- Modify/Create: `apps/api/src/__tests__/integration/auth-bootstrap.integration.test.ts`
- Possibly read: `apps/api/src/resolvers/auth.ts`
- Possibly read: `apps/api/src/schema.ts`

**Step 1: Write failing test**

Test ma sprawdzać przynajmniej:
- register zapisuje `wrappedARKByPassword`
- register zapisuje `wrappedARKByRecovery`
- register zapisuje komplet `argon2Params`
- login zwraca ten sam bootstrap material w kontrakcie użytkownika
- shape odpowiedzi jest zgodny z consumer contract, nie z przypadkowym stanem DB

**Step 2: Run test to verify failure**

Run:
```bash
npm run test --workspace=@ddv4/api -- auth-bootstrap
```
Expected: FAIL lub częściowy FAIL.

**Step 3: Implement minimal fixes**

Jeżeli test failuje, popraw tylko to, co jest potrzebne do przejścia testu:
- resolver,
- mapping DTO,
- schema.

**Step 4: Re-run targeted test**

Expected: PASS.

**Step 5: Re-run broader API tests**

Run:
```bash
npm run test --workspace=@ddv4/api
```
Expected: PASS.

---

### Task 1.3: Odhaczyć checklistę auth/bootstrap dopiero po zielonym teście

**Objective:** Domknąć jedyny świadomie pozostawiony checkbox dopiero po dowodzie testowym.

**Files:**
- Modify: `docs/hermes/discordrive-core-v1-checklist.md`
- Modify: `~/Documents/Obsidian Vault/project-notes/active/DiscordDrive.md`

**Step 1: Update checklist**

Odhacz:
- `Register/login działa z crypto bootstrapem zgodnym z ARK + domain keys`

**Step 2: Update project note**

Dopisz, jaki test to udowodnił i jaki był wynik.

---

## Phase 2 — Jeden pełny scenariusz end-to-end Core v1

### Task 2.1: Spisać docelowy smoke scenario

**Objective:** Mieć jedną precyzyjną definicję pełnego flow, który musi działać, żeby uznać Core za naprawdę zamknięty.

**Files:**
- Modify/Create: `docs/hermes/discordrive-core-v1-smoke.md` lub bezpośrednio test artifact
- Read: `docs/hermes/discordrive-core-v1-plan.md`

**Scenario must include:**
1. register
2. login
3. init upload
4. blob upload
5. commit manifest
6. owner fetch blob by manifest-provided blobId
7. create share
8. access share by capability token

**Step 1: Write the scenario checklist**

Krótki dokument lub komentarz testowy opisujący cały flow.

**Step 2: No implementation yet**

To krok porządkujący, żeby implementer niczego nie zgadywał.

---

### Task 2.2: Dodać failing smoke/integration test dla pełnego Core v1 flow

**Objective:** Udowodnić, że wszystkie warstwy Core v1 składają się w jeden spójny produkt dependency.

**Files:**
- Create/Modify: `apps/api/src/__tests__/integration/core-v1-smoke.integration.test.ts`
- Read/Reuse: istniejące testy auth, files-lifecycle, blob-upload, share-access

**Step 1: Write failing test**

Minimalny test powinien:
- korzystać z realnych resolverów/handlerów lub cienkiego publicznego kontraktu,
- nie sprawdzać UX heurystyk,
- kończyć się sukcesem dopiero, gdy cały flow przejdzie.

**Step 2: Run test to verify failure**

Run:
```bash
npm run test:integration -- --run core-v1-smoke
```
If the repo doesn’t support this exact filter, run the nearest vitest command for the created file.
Expected: FAIL.

**Step 3: Implement minimal missing glue**

Popraw tylko brakujące połączenia między już istniejącymi warstwami.

**Step 4: Re-run targeted smoke test**

Expected: PASS.

**Step 5: Re-run integration suite**

Run:
```bash
npm run test:integration
```
Expected: PASS.

---

## Phase 3 — Ostateczne domknięcie dokumentacyjne

### Task 3.1: Doprecyzować definition of done po wykonaniu auth/bootstrap i smoke flow

**Objective:** Zamknąć ambiguity między „praktycznie gotowe” a „formalnie domknięte”.

**Files:**
- Modify: `docs/hermes/discordrive-core-v1-plan.md`
- Modify: `docs/hermes/discordrive-core-v1-checklist.md`
- Modify: `docs/hermes/discordrive-core-v1-consumption.md`
- Modify: `~/Documents/Obsidian Vault/project-notes/active/DiscordDrive.md`

**Step 1: Update plan/checklist**

Usuń niejasność wokół auth/bootstrap i smoke scenario.

**Step 2: Update consumption contract**

Jeśli auth/bootstrap lub smoke test wnoszą nowe twarde gwarancje, dopisz je do dokumentu konsumpcji.

**Step 3: Update project note**

Dopisz, że formalny closure gap został zamknięty.

---

### Task 3.2: Zamknąć remaining open questions albo oznaczyć je jako non-blocking

**Objective:** Nie zostawiać w notatce pytań, które wyglądają jak blockery, jeśli już nimi nie są.

**Files:**
- Modify: `~/Documents/Obsidian Vault/project-notes/active/DiscordDrive.md`

**Step 1: Review open questions**

Dla każdego pytania zdecyduj:
- resolved,
- non-blocking,
- still blocking.

**Step 2: Rewrite section**

Zostaw tylko pytania naprawdę otwarte.

---

## Phase 4 — Final closure gate

### Task 4.1: Odpalić pełny final gate po wszystkich poprawkach

**Objective:** Uzyskać ostatni, czysty dowód, że projekt jest gotowy do nazwania „w pełni domkniętym” w obecnym scope.

**Files:**
- No code files required
- Update docs after run

**Step 1: Run final commands**

```bash
npm run typecheck
npm test
npm run test:integration
```

**Expected:** wszystkie PASS.

**Step 2: Record results**

Wpisz dokładny wynik do notatki projektu.

---

### Task 4.2: Napisać final verdict note

**Objective:** Zostawić jedno krótkie, jednoznaczne podsumowanie, czy DiscordDrive jest już w pełni domknięty jako dependency/core.

**Files:**
- Modify: `~/Documents/Obsidian Vault/project-notes/active/DiscordDrive.md`
- Optional: create `docs/hermes/discordrive-final-verdict.md`

**Step 1: Add final verdict section**

Forma powinna być krótka:
- status,
- co zostało zweryfikowane,
- co jest poza zakresem,
- czy wolno już nazywać projekt fully closed.

---

## Recommended stop condition

Jeżeli po wykonaniu tego planu:
- auth/bootstrap test jest zielony,
- pełny smoke scenario jest zielony,
- final verification jest zielone,
- dokumentacja nie zostawia blockerów,

wtedy można uczciwie zamknąć temat słowami:

**„DiscordDrive jest w pełni domknięty jako secure-files/storage Core v1 dependency w uzgodnionym scope.”**
