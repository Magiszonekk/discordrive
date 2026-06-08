# Secure Files v2 Implementation Checklist

## Crypto envelope
- [ ] User crypto stores `wrappedARKByPassword`, `wrappedARKByRecovery`, `argon2Params`
- [ ] Files domain key is wrapped by ARK
- [ ] Files use one `wrappedFEK` root key
- [ ] Content and metadata keys are HKDF-derived from root FEK
- [ ] Capability-token share flow implemented with `linkSecret -> K_wrap/K_auth -> capabilityToken`
- [ ] Constant-time compare used for capability token checks

## Prisma schema
- [ ] Legacy plaintext file/share fields removed
- [ ] `File.status` exists with uploading/ready/failed
- [ ] `File.primaryManifestBlobId` is nullable
- [ ] `BlobTransportRecord` equivalent exists keyed by `blobId`
- [ ] Share model is file-only in v1

## API boundary
- [ ] Init upload does not accept plaintext filename/mimeType
- [ ] Manifest commit transitions file to ready
- [ ] Client fetches blobs by presenting decrypted `blobId`
- [ ] Backend does not expose file chunk enumeration as source of truth

## Upload lifecycle
- [ ] New upload starts in `uploading`
- [ ] Ready file always has manifest blob id
- [ ] Failed file is not downloadable/shareable

## Share flow
- [ ] `shareType: 'file'`
- [ ] No folder-share path in v1
- [ ] `wrappedAKShare` stored server-side
- [ ] Share release denied for wrong capability token

## Tests
- [ ] Prisma schema shape tests
- [ ] Crypto tests for ARK/domain/root FEK + HKDF subkeys
- [ ] API tests for secure upload lifecycle
- [ ] Integration tests for blob fetch by `blobId`
- [ ] Integration tests for capability-token share flow
