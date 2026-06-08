# [TASK-011] Plan techniczny — batch metadata commit dla uploadu DiscordDrive

## Cel
Usunąć główny bottleneck uploadu w DiscordDrive: per-chunk zapis metadata do PostgreSQL (`db.blobTransport.upsert(...)`) wykonywany w `handleBlobUpload()` dla każdego bloba/chunka osobno.

Docelowo:
- upload chunka zapisuje tylko blob na storage,
- metadata wszystkich blobów z sesji uploadu są zbierane poza DB,
- jeden końcowy commit zapisuje metadata batchowo do `BlobTransport`.

## Ustalenia wejściowe
- Live upload path: `apps/frontend/src/pages/Dashboard.tsx` → `../lib/upload.js` (`uploadFile(...)`).
- Storage backend na produkcji: `LOCAL` (brak `BLOB_STORAGE_KIND` w `.env`).
- Local blob storage benchmark: ~1000–2000 MB/s, więc nie jest bottleneckiem.
- Backend telemetry pokazuje skoki `dbMs` nawet do ~200–400+ ms na chunk przy sustained uploadzie.
- Tabela `BlobTransport` jest mała (<1 MB), bez istotnego bloatu — problemem nie jest rozmiar tabeli ani indeksów.

## Obecny przepływ
### Frontend
Plik: `apps/frontend/src/lib/upload.ts` / aktywnie także `apps/frontend/src/lib/upload.js`
1. `initUpload(...)`
2. dla każdego chunka:
   - encrypt
   - `uploadBlobToApi(blobId, ciphertext)`
   - manifest lokalnie dostaje `index`, `blobId`, `ciphertextSizeBytes`
3. upload manifestu
4. `commitManifest(fileId, manifestBlobId, totalCiphertextBytes, chunkCount)`

### Backend
#### `apps/api/src/handlers/blob.ts`
`handleBlobUpload()`:
1. auth
2. `req.arrayBuffer()`
3. hash (`sha256Ciphertext`)
4. write blob (`LOCAL` / `DISCORD`)
5. **`db.blobTransport.upsert(...)` per blob**
6. response z `blobId`, `ciphertextSizeBytes`, `ciphertextHash`

#### `apps/api/src/resolvers/files.ts`
`commitManifest()`:
1. sprawdza `File`
2. sprawdza, czy `manifestBlobId` istnieje w `BlobTransport`
3. update `File` → `READY`

## Docelowy przepływ
### Per chunk
`PUT /api/blob/:blobId`
- zapisuje blob na storage,
- liczy hash,
- zwraca komplet metadata potrzebnych do późniejszego batch insert,
- **nie zapisuje `BlobTransport` do DB**.

### Na końcu uploadu
`commitManifest(...)`
- dostaje komplet metadata wszystkich blobów z upload session,
- zapisuje je batchowo do `BlobTransport`,
- update `File`,
- emituje event `file:uploaded`.

## Zmiany do wdrożenia

### 1. Backend — `apps/api/src/handlers/blob.ts`
#### Zakres
Usunąć per-chunk DB write z `handleBlobUpload()`.

#### Konkretna zmiana
Usunąć blok:
- `dbStartMs`
- `db.blobTransport.upsert(...)`
- `dbMs`

Zostawić:
- telemetry requestu,
- read body,
- hash,
- storage write,
- response JSON.

#### Nowy response payload
Rozszerzyć odpowiedź o pełne metadata potrzebne do późniejszego batch commit:
- `blobId`
- `ciphertextSizeBytes`
- `ciphertextHash`
- `storageKind`
- `storagePath`
- `discordMessageId?`
- `discordChannelId?`
- `webhookId?`

#### Telemetry
- `dbMs` zniknie z per-chunk path.
- zamiast tego można dodać `dbMs` tylko w końcowym `commitManifest()` jako batch timing.

---

### 2. Frontend API client — `apps/frontend/src/lib/api.ts`
#### Zakres
Rozszerzyć `BlobUploadResponse` o pełne metadata blob storage.

#### Nowe pola
- `storageKind: "LOCAL" | "DISCORD"`
- `storagePath: string`
- `discordMessageId?: string`
- `discordChannelId?: string`
- `webhookId?: string`

#### Cel
Frontend ma przechować wszystko, co potem backend potrzebuje do batch insertu bez ponownego odpytywania storage layer.

---

### 3. Frontend upload pipeline — `apps/frontend/src/lib/upload.ts` i aktywny `apps/frontend/src/lib/upload.js`
#### Zakres
Zbierać metadata wszystkich uploadowanych blobów i przekazać je do finalnego commitu.

#### Nowy typ pomocniczy
Dodać lokalny typ np. `UploadedBlobRecord`:
- `blobId`
- `ciphertextSizeBytes`
- `ciphertextHash?`
- `storageKind`
- `storagePath`
- `discordMessageId?`
- `discordChannelId?`
- `webhookId?`

#### Zmiany w flow
##### Chunk upload
Po `await uploadBlobToApi(...)`:
- dopisać wynik do tablicy `uploadedChunkBlobs[]`

##### Manifest upload
Po uploadzie manifestu:
- zapisać wynik jako `uploadedManifestBlob`

##### Commit
Zamiast starego:
- `commitManifest(fileId, manifestBlobId, totalCiphertextBytes, chunkCount)`

przekazać:
- `fileId`
- `manifestBlobId`
- `totalCiphertextBytes`
- `chunkCount`
- `blobs` = `uploadedChunkBlobs + uploadedManifestBlob`

#### Ważne
Trzeba zsynchronizować zarówno `.ts`, jak i aktywnie używany `.js`, albo przełączyć importy runtime tak, żeby build na pewno używał jednego źródła prawdy.

---

### 4. Shared API types — `packages/types/src/api.ts`
#### Zakres
Dodać DTO dla batch commit blob metadata.

#### Proponowane typy
- `UploadedBlobTransportInput`
- rozszerzony `CommitManifestRequest`

#### Minimalny shape
`UploadedBlobTransportInput`:
- `blobId: string`
- `storageKind: "LOCAL" | "DISCORD"`
- `storagePath: string`
- `ciphertextSizeBytes: string`
- `ciphertextHash?: string`
- `discordMessageId?: string`
- `discordChannelId?: string`
- `webhookId?: string`

---

### 5. GraphQL schema — `apps/api/src/schema.ts`
#### Zakres
Rozszerzyć kontrakt `commitManifest`.

#### Dodać input GraphQL
`UploadedBlobTransportInput` z polami odpowiadającymi typowi z `packages/types/src/api.ts`.

#### Zmienić mutation
`commitManifest(...)` powinno przyjmować dodatkowe pole:
- `blobs: [UploadedBlobTransportInput!]!`

#### Cel
Cała sesja uploadu kończy się jednym commit requestem z pełnym metadata payloadem.

---

### 6. Backend resolver — `apps/api/src/resolvers/files.ts`
#### Zakres
Przenieść zapis `BlobTransport` z chunk upload path do `commitManifest()`.

#### Nowy przebieg `commitManifest()`
1. Sprawdź `File` i `status === UPLOADING`.
2. Sprawdź, że `manifestBlobId` występuje w przekazanym `blobs[]`.
3. Batch insert wszystkich blob metadata do `BlobTransport`.
4. Update `File`:
   - `primaryManifestBlobId`
   - `totalCiphertextBytes`
   - `chunkCount`
   - `status = READY`
5. Emit `pluginRegistry.emitAsync("file:uploaded", ...)`.

#### Rekomendowany mechanizm DB
Pierwszy wariant:
- `db.blobTransport.createMany({ data: blobs, skipDuplicates: true? })`

Jeśli `skipDuplicates` nie pasuje do oczekiwanej semantyki, to alternatywnie:
- transakcja + walidacja unikalności,
- albo później idempotent commit.

#### Istotna decyzja
W pierwszym wdrożeniu commit może być traktowany jako jednokrotny i niekoniecznie w pełni retry-safe, jeśli to upraszcza rollout. Idempotencję można dołożyć jako osobny krok po stabilizacji throughputu.

---

## Kolejność implementacji
1. Rozszerzyć response `handleBlobUpload()`.
2. Rozszerzyć `BlobUploadResponse` w FE.
3. Zmodyfikować `upload.ts` / `upload.js`, aby zbierały `UploadedBlobRecord[]`.
4. Dodać nowe typy w `packages/types/src/api.ts`.
5. Rozszerzyć GraphQL `commitManifest` o `blobs[]`.
6. Zaimplementować batch insert w `resolvers/files.ts`.
7. Usunąć per-chunk `upsert` z `handleBlobUpload()`.
8. Zaktualizować telemetry.
9. Przebudować frontend i zrestartować usługę.
10. Powtórzyć benchmark uploadu i porównać telemetry.

## Testy do dodania / zaktualizowania
### Backend unit/integration
1. `handleBlobUpload`:
   - nie tworzy rekordu `BlobTransport` od razu,
   - zwraca pełny metadata payload.
2. `commitManifest`:
   - batchowo zapisuje blob metadata,
   - ustawia `File.status = READY`,
   - failuje, gdy `manifestBlobId` nie ma w `blobs[]`,
   - failuje bez częściowego uszkodzenia stanu, gdy insert metadata nie przejdzie.
3. Opcjonalnie:
   - test idempotencji / duplicate commit (jeśli wdrażane od razu).

### Frontend
1. Test, że upload flow zbiera metadata z `uploadBlobToApi()`.
2. Test, że końcowy commit wysyła `blobs[]`.

## Ryzyka i pułapki
### 1. Orphaned blobs
Jeśli upload padnie przed `commitManifest`, to blob zostanie na storage bez rekordu DB.

#### Mitigacja
- Na pierwszy rollout zaakceptować orphan risk.
- Dodać później cleanup job dla blobów starszych niż np. 24h bez rekordu `BlobTransport`.

### 2. Idempotencja końcowego commitu
Jeśli klient retry’uje `commitManifest`, mogą pojawić się duplikaty lub konflikt unikalności po `blobId`.

#### Mitigacja
- pierwszy rollout: jednorazowy commit,
- potem dodać `skipDuplicates` lub jawny idempotency model.

### 3. Rozjazd `.ts` vs `.js`
W projekcie aktywne runtime importy idą po `.js`, a część logiki edytowana była w `.ts`.

#### Mitigacja
- podczas implementacji zawsze synchronizować oba pliki,
- albo uporządkować build/import strategy jako osobny cleanup.

## Kryteria ukończenia
Task uznajemy za ukończony, gdy:
1. per-chunk upload path nie zapisuje `BlobTransport` do DB,
2. `commitManifest` robi jeden batch metadata write,
3. upload działa end-to-end na produkcji,
4. telemetry pokazuje zniknięcie per-chunk `dbMs` z pathu upload chunków,
5. obserwowany throughput w UI rośnie względem obecnych ~9 MB/s,
6. testy regresyjne dla nowego kontraktu przechodzą.

## Rekomendowany pierwszy rollout
Najpierw wdrożyć tylko:
- LOCAL storage path,
- batch metadata commit,
- minimalne testy,
- benchmark powtórzony na tym samym typie pliku i z włączonym telemetry.

Dopiero po potwierdzeniu zysku:
- cleanup orphan blobs,
- idempotent retry,
- ewentualnie dalsze optymalizacje concurrency / streaming path.
