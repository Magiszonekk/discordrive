# DiscordDrive — notatka architektoniczna: redundancja storage / replikacja blobów

## Cel
Zwiększyć ochronę danych przez redundancję między wieloma node’ami DiscordDrive, bez skupiania się na klasycznych poziomach RAID, tylko na replikacji blobów/chunków.

## Założenia wysokiego poziomu
- Priorytet: **ochrona danych**, nie maksymalizacja throughputu.
- Wsparcie dla **więcej niż 2 node’ów**.
- Preferowany model: **centralny control plane + wiele storage node’ów**.
- Upload UX powinien pozostać szybki: zapis do primary, a replikacja na pozostałe nody ma iść **asynchronicznie**.
- Read path powinien wspierać **fallback do zdrowej repliki**, jeśli preferowana replika/node padnie.
- System powinien umieć przejść w stan degraded i później wykonać repair/self-heal.

## Rekomendowana architektura MVP
### 1. Nie RAID, tylko replication policy
Zamiast klasycznych poziomów RAID używać:
- `replicationFactor = 2/3/4/...`
- `writeConcern = 1/2/all`
- `readPolicy = preferred-primary-with-fallback`
- `repair = enabled`

### 2. Centralna metadata
Jeden główny backend/DB DiscordDrive jako control plane odpowiada za:
- auth
- metadata plików
- metadata blobów
- registry node’ów
- placement policy
- replication jobs
- health/repair

### 3. Wiele storage node’ów
Każdy node ma wewnętrzne API storage i może:
- przyjąć blob
- oddać blob
- usunąć blob
- odpowiedzieć healthcheckiem

## Model danych do rozważenia
### `StorageNode`
Opis dostępnych node’ów storage:
- `nodeId`
- `name`
- `baseUrl`
- `enabled`
- `status` (`ONLINE`, `DEGRADED`, `OFFLINE`, `DISABLED`)
- `priority`
- `weight`
- `tags`
- `lastHealthCheckAt`
- `lastHealthError`

### `BlobObject`
Logiczna encja bloba:
- `blobId`
- `ownerUserId`
- `ciphertextSizeBytes`
- `ciphertextHash`
- `replicationFactor`
- `writeConcern`
- `replicationState` (`PENDING`, `PARTIAL`, `HEALTHY`, `DEGRADED`, `FAILED`)
- `createdAt`

### `BlobReplica`
Jedna replika bloba na jednym node’zie:
- `blobId`
- `nodeId`
- `status` (`PENDING`, `READY`, `MISSING`, `CORRUPT`, `REPAIRING`, `FAILED`)
- `storageKind`
- `storagePath`
- `discordMessageId`
- `discordChannelId`
- `webhookId`
- `ciphertextSizeBytes`
- `ciphertextHash`
- `lastVerifiedAt`
- `lastError`
- `createdAt`
- `updatedAt`

### `BlobReplicationJob`
Asynchroniczne joby replikacji/naprawy:
- `jobId`
- `blobId`
- `targetNodeId`
- `sourceNodeId`
- `type` (`REPLICATE`, `VERIFY`, `REPAIR`, `DELETE_REPLICA`)
- `status` (`PENDING`, `RUNNING`, `DONE`, `FAILED`, `RETRY_SCHEDULED`)
- `attemptCount`
- `nextAttemptAt`
- `lastError`

## Proponowany flow uploadu
1. Client uploaduje blob/chunk do control plane jak dziś.
2. Control plane wybiera primary node oraz docelowe nody do osiągnięcia `replicationFactor`.
3. Blob zapisuje się na primary.
4. Metadata zapisuje:
   - primary replica = `READY`
   - pozostałe repliki = `PENDING`
5. Tworzone są `BlobReplicationJob(REPLICATE)` dla pozostałych node’ów.
6. Upload dla usera kończy się po `writeConcern` (na MVP rekomendowane `1`).

## Proponowany flow odczytu
1. Request po `blobId` szuka zdrowych `BlobReplica`.
2. Próba odczytu z preferowanej repliki.
3. Jeśli fail → fallback do kolejnej zdrowej repliki.
4. Jeśli fallback działa, poprzednia replika może zostać oznaczona jako podejrzana / unhealthy.

## Health / repair
- Health worker okresowo sprawdza node’y i repliki.
- Jeśli liczba zdrowych replik spadnie poniżej `replicationFactor`, repair worker tworzy nową replikę na healthy node.
- System powinien wspierać stany degraded i self-heal.

## Rekomendowane ustawienia startowe
- `replicationFactor = 3`
- `writeConcern = 1`
- `readPolicy = preferred-primary-with-fallback`
- `repair = enabled`

## Co wydaje się najrozsądniejszym pierwszym etapem
### Faza 1
- nowe modele DB pod replikację
- registry node’ów
- primary write + pending replicas metadata

### Faza 2
- replication worker
- async replication do wielu node’ów

### Faza 3
- read fallback

### Faza 4
- health checks + repair

### Faza 5
- admin/API/UI do zarządzania node’ami i degraded blobs

## Plugin vs core
Wniosek architektoniczny:
- **redundancja storage powinna wejść do core**, bo dotyka storage modelu, upload lifecycle i read path.
- Plugin/addon może później zapewnić:
  - panel klastra
  - telemetry
  - advanced ops
  - raporty health

## Czego na razie nie rekomendować
- czysty RAID 0 / striping jako pierwszy etap
- erasure coding / parity jako MVP
- federację wielu niezależnych DB jako pierwszy krok

## Następny potencjalny krok
Jeśli temat wróci do implementacji, przygotować osobny task/plan dla:
- zmian Prisma schema
- storage node registry
- internal node-to-node API
- replication worker
- read fallback
- health/repair
