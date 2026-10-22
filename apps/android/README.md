# DiscorDrive Gallery (Android)

Mobile gallery that syncs phone photos/videos to a DiscorDrive server
instance — zero-knowledge E2EE cloud with a "free up space" workflow.

## Modules

| module        | type    | contents                                                                 |
|---------------|---------|--------------------------------------------------------------------------|
| `:core:crypto`| JVM     | DiscorDrive key hierarchy: Argon2id (BouncyCastle), HKDF, AES-GCM packing |
| `:core:api`   | JVM     | GraphQL + blob client: login/device sessions, gallery delta/state, resume |
| `:app`        | Android | App shell: Keystore ARK store, MainActivity stub (Phases 3–5 land here)   |

`:core:*` are pure JVM — `./gradlew :core:crypto:test :core:api:test` runs on
any machine with JDK 17. `:app` is included only when the Android SDK is
present (`ANDROID_HOME` or `local.properties`).

## Crypto compatibility

`core/crypto/src/test/resources/crypto-vectors.json` is the byte-exact
contract with the web client, generated in the discordrive repo by
`scripts/generate-crypto-vectors.mts`. Regenerate + copy it here whenever the
crypto in `@ddv4/processing` changes. `CryptoVectorsTest` must stay green —
a failure means this client would corrupt or fail to read web-client data.

Key facts mirrored from `@ddv4/processing`:
- Argon2id v1.3, 32-byte output → ARK wrap key; serverAuthProof = HKDF(info `ddv4-server-auth-v1`)
- AES-256-GCM everywhere, packed as `IV(12B) || ciphertext || tag(16B)`, no AAD
- per-file subkeys: HKDF infos `ddv4-file-content-v1` / `ddv4-file-metadata-v1`
- `filesKey == ARK` until domain keys are wired in core

## Server requirements

A DiscorDrive server with the gallery plugin enabled
— provides `galleryDelta`, `galleryState[s]`, `setGalleryState` on top of core
device sessions (`login(deviceName)` → refresh token), `uploadStatus` resume
and the preview/dedupe/trash pipeline.

## Roadmap

- **Phase 3 — sync engine**: MediaStore scan + ContentObserver, bucket→folder
  mirroring, BLAKE3 dedupe tokens, WorkManager (charger+WiFi defaults),
  foreground service for the initial backup, "free up space" after health check
- **Phase 4 — media UX**: local thumbnails (permanent cache), encrypted medium
  previews, ExoPlayer streaming via custom DataSource (8 MiB chunk = natural
  seek unit), FullHD preview transcode for >1080p videos (Media3 Transformer)
- **Phase 5 — AI & search**: ML Kit OCR (always), Gemini Nano on-device or a
  user-configured OpenAI-format endpoint (URL + key) for self-hosted models,
  SQLite FTS5 + encrypted index synced via gallery state
