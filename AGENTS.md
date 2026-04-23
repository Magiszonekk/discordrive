# Hermes Agent Context — discordrive

## Projekt
TypeScript monorepo (ddv4) — system przechowywania plików przez Discord jako storage.

## Struktura
- `packages/stream-engine` — upload/download plików
- `packages/processing` — chunking, crypto, hashing
- `packages/discord-client` — komunikacja z Discord API
- `packages/redis` — warstwa cache
- `packages/config` — konfiguracja serwera i bazy
- `packages/types` — współdzielone typy
- `apps/` — aplikacje (API, frontend)

## Stack
- TypeScript, Node.js
- Monorepo (npm workspaces)
- Docker (infra)

## Komendy
- `npm run typecheck` — sprawdź typy (używaj gdy brak testów)
- `npm run build` — zbuduj wszystko
- `npm run dev` — uruchom dev (API + frontend)
- `npm run db:generate` — generuj schemat bazy
- `npm run infra:up` — uruchom infrastrukturę Docker

## Artefakty workflow
Wszystkie artefakty Hermesa trafiają do `docs/hermes/`.
Zawsze czytaj `docs/hermes/concept.md` i `docs/hermes/plan.md` przed pracą.

## Ważne
- Brak testów jednostkowych — używaj `npm run typecheck` jako podstawowej weryfikacji
- Przy nowych featurach proponuj testy jako część planu
- Nie modyfikuj plików w `dist/` — to output buildu
