# @ddv4/plugin-gallery

Server-side support for the DiscorDrive mobile gallery app. The plugin adds
sync plumbing on top of the core file store — every value it persists is
encrypted client-side (zero-knowledge).

## Enabling

```
DDV_PLUGINS=@ddv4/plugin-gallery
```

## GraphQL surface

All operations require an authenticated user (JWT / device session token).

### Encrypted state store

Small client-encrypted blobs with optimistic locking, keyed per user:

- `galleryState(key)` → `{ key, valueB64, version, updatedAt }`
- `galleryStates(prefix)` → key/version/size listing (no values)
- `setGalleryState(key, valueB64, expectedVersion)` —
  `expectedVersion` omitted = last-write-wins; `0` = create-only;
  `N` = succeed only if stored version is still `N` (else version conflict)
- `deleteGalleryState(key)`

Value limit: 4 MiB. Large payloads (thumbnail packs, search index snapshots)
go through the regular blob transport; store only their pointers here.

Suggested key conventions (clients own the schema of the encrypted values):

| key                      | content (encrypted)                                |
|--------------------------|----------------------------------------------------|
| `bucket-map`             | Android bucket ↔ folderId mapping manifest         |
| `thumb-packs`            | thumbnail-pack index (packBlobId → member offsets) |
| `search-index`           | pointer + metadata of the FTS index snapshot blob  |
| `device:<id>:state`      | per-device sync cursor / settings                  |

### Incremental sync

- `galleryDelta(since)` → `{ files, folders, cursor }` — all File/Folder rows
  of the user whose `updatedAt > since` (trash/restore included via
  `deletedAt`/`updatedAt`), capped at 1000 rows per kind; pass `cursor` back
  as the next `since`. Hard-purged rows stop appearing — reconcile those with
  a periodic full listing.
