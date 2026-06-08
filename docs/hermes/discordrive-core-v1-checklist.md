# DiscordDrive Core v1 Checklist

## Scope in / out
- [x] Scope IN obejmuje tylko secure-files/storage core, nie gallery product UX.
- [x] Scope OUT explicite wycina gallery UI, AI tagging/search UX, albumy i smart albumy.
- [x] DiscordDrive Core v1 ma być gotowy jako dependency/service layer dla innych projektów.

## Security invariants
- [x] `File` nie przechowuje plaintext `filename` ani `mimeType` po stronie serwera.
- [x] `wrappedFEK` pozostaje głównym wrapped object key zgodnie z secure-files v2.
- [x] Backend nie staje się chunk-order oracle.
- [x] Decrypted manifest pozostaje źródłem prawdy dla kolejności chunków i membership blobów.

## Core flows
- [x] Register/login działa z crypto bootstrapem zgodnym z ARK + domain keys.
- [x] Init upload nie przyjmuje plaintext metadata jako części core API.
- [x] Manifest commit jest readiness gate do przejścia pliku w `READY`.
- [x] Owner może pobrać blob przez `blobId` pochodzący z odszyfrowanego manifestu.

## Transport invariants
- [x] `BlobStorageKind` wspiera `DISCORD`.
- [x] `BlobTransport` przechowuje Discord transport coordinates dla blobów.
- [x] `GET /blob/:blobId` akceptuje blobId przedstawione przez klienta po odszyfrowaniu manifestu.
- [x] `LOCAL` może pozostać jako tryb dev/test, ale nie jako finalny jedyny substrate.

## Share invariants
- [x] Share flow pozostaje file-only (`shareType: file`).
- [x] Publiczny share contract nie polega na `displayName = file.id`.
- [x] Publiczny share contract nie wymaga inferowanego `mimeType` jako części core dependency API.
- [x] Capability mismatch / revoked / expired share nie daje dostępu.

## Verification commands
- [x] `npm run typecheck`
- [x] `npm test`
- [x] `npm run test:integration`

## Explicitly not required for Core v1
- [x] Gallery UX/product layer nie jest wymagana do uznania Core v1 za domknięty.
- [x] AI tagging/search UX nie jest wymagana do uznania Core v1 za domknięty.
- [x] Phone-gallery backup experience nie jest wymagana do uznania Core v1 za domknięty.
