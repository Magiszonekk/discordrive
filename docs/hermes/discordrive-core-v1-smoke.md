# DiscordDrive Core v1 Smoke Scenario

## Purpose
Jeden jawny scenariusz end-to-end potwierdzający, że DiscordDrive działa jako secure-files/storage Core v1 dependency w uzgodnionym scope.

## Required flow
1. `register`
2. `login`
3. `initUpload`
4. `blob upload`
5. `commitManifest`
6. `owner fetch blob` po `blobId` pochodzącym z manifestu
7. `createShare`
8. `accessShare` przez `shareId + capabilityToken`

## What the smoke must prove
- auth contract zwraca crypto bootstrap zgodny z ARK + domain keys
- init upload nie wymaga plaintext metadata
- blob transport potrafi zapisać ciphertext i zwrócić go ownerowi przez `blobId`
- manifest commit przełącza plik do `READY`
- share contract zwraca tylko core crypto/access fields
- cały flow spina się przez publiczny kontrakt API/handlerów, a nie przez przypadkowy stan bazy

## Minimal test shape
- register/login przez GraphQL Yoga schema
- initUpload/commitManifest/createShare/accessShare przez GraphQL Yoga schema
- blob upload/content przez blob handlers
- jeden owner user
- jeden ciphertext blob użyty jako manifest-provided `blobId`
- capability token przekazany przez share flow

## Pass condition
Scenariusz jest zielony tylko wtedy, gdy wszystkie 8 kroków przechodzą w jednym teście bez ręcznego patchowania stanu poza niezbędnym przygotowaniem fixture testowych.
