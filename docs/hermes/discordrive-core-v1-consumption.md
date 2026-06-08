# DiscordDrive Core v1 Consumption Contract

## Purpose
DiscordDrive Core v1 is a reusable secure-files/storage core for other projects. It is not the gallery product layer. Other projects should treat it as a zero-knowledge ciphertext storage and share service with Discord-backed blob transport, not as a source of plaintext file metadata or end-user gallery UX.

## What Core v1 is
DiscordDrive Core v1 provides:
- account bootstrap with encrypted user crypto material
- secure file upload lifecycle for ciphertext objects
- blob storage/fetch using `LOCAL` (dev/test) or `DISCORD` (target substrate)
- file-only sharing based on capability tokens and wrapped object keys
- API contracts that return crypto/material references needed by a trusted client

## What Core v1 is not
DiscordDrive Core v1 does not provide:
- gallery product UX
- plaintext filename/mimeType as a trusted server-side contract
- AI tagging/search UX
- album or folder sharing
- client-side decryption logic
- a promise that Discord/server knows decrypted metadata semantics

## Security model expectations
Consumers must assume:
- backend and Discord are untrusted ciphertext transport/storage layers
- decrypted manifest is the client-side source of truth for blob membership and ordering
- blob identifiers are consumed after client-side manifest decryption
- wrapped keys returned by the API must be handled only by the trusted client/application layer
- display metadata belongs to encrypted metadata/manifest flow, not to the core share contract

## Recommended consumption mode
For Core v1, the recommended integration mode is **API-first / service-first**.

That means other projects should:
- treat DiscordDrive as a backend service with a stable HTTP/GraphQL contract
- keep product-specific UX, metadata interpretation, previews, and gallery semantics in their own app layer
- avoid importing internal repository modules as if they were a stable SDK

## Why API-first is preferred
API-first keeps the dependency boundary clean:
- DiscordDrive can evolve internally without coupling consumers to monorepo internals
- zero-knowledge and ciphertext/storage semantics stay centralized in one service boundary
- consumers only depend on documented request/response contracts
- gallery/product concerns do not leak back into storage core APIs

## Integration responsibilities
A consuming project is responsible for:
- user-facing file naming and media semantics
- client-side key handling and decryption orchestration
- manifest parsing after decryption
- preview/render decisions based on decrypted metadata
- product-specific share UI and share state UX

DiscordDrive Core v1 is responsible for:
- auth/bootstrap persistence
- ciphertext blob persistence and retrieval
- transport abstraction over `LOCAL|DISCORD`
- file/share persistence and access control checks
- returning wrapped key material and blob references required by a trusted client

## Stable contract surface for consumers
Current consumer-facing core surface should be understood as:
- auth/register/login returning encrypted bootstrap material
- init upload / commit manifest lifecycle for secure files
- blob metadata and blob content access by `blobId`
- file share creation
- share access by `shareId + capabilityToken`

## Share access contract
Consumers should rely on share access returning only core fields:
- `shareId`
- `wrappedAKShare`
- `wrappedObjectKeys[]`
  - `fileId`
  - `primaryManifestBlobId`
  - `previewBlobId`
  - `wrappedFEK`
  - `wrappedFEKPreview`
- `allowContent`
- `allowMetadata`
- `allowPreview`

Consumers should **not** rely on DiscordDrive Core v1 to provide:
- `displayName`
- inferred `mimeType`
- `previewKind`
- `shareState`
- other UX-derived presentation fields

## Transport expectations
Consumers should assume:
- `DISCORD` is the target production substrate
- `LOCAL` may exist for dev/test environments
- transport coordinates are implementation/runtime details of the core service and not a signal to reimplement storage logic in the consumer

## Versioning expectation
Core v1 should be treated as stable at the boundary described in this document, but not as a promise that every internal monorepo package is public API. If another project needs deeper integration, prefer adding an explicit API contract or a dedicated facade instead of importing internal modules ad hoc.

## Out of scope for declaring Core v1 done
The following are explicitly not required for Core v1 consumption readiness:
- gallery UI
- AI search/tagging UX
- phone-backup product flows
- folder shares
- server-side plaintext media metadata contract

## Practical recommendation
If another project wants to build on DiscordDrive today, the correct architecture is:
1. use DiscordDrive as secure storage/share backend
2. keep decrypted metadata interpretation in the consuming app
3. layer gallery, search, preview, or backup product logic outside DiscordDrive Core v1
4. request new explicit API fields only when they are truly core and not product heuristics
