import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const schemaPath = resolve(__dirname, '../../prisma/schema.prisma');

describe('secure files prisma schema shape', () => {
  const schema = readFileSync(schemaPath, 'utf8');

  it('contains the new secure files models', () => {
    expect(schema).toContain('model UserCrypto');
    expect(schema).toContain('model DomainKey');
    expect(schema).toContain('model File');
    expect(schema).toContain('model BlobTransport');
    expect(schema).toContain('model Folder');
    expect(schema).toContain('model Share');
    expect(schema).toContain('model GrantedAccess');
    expect(schema).toContain('model ShareWrappedObjectKey');
  });

  it('contains secure File fields and removes plaintext-heavy legacy fields', () => {
    expect(schema).toContain('primaryManifestBlobId');
    expect(schema).toContain('wrappedFEK');
    expect(schema).toContain('status                FileStatus');

    expect(schema).not.toContain('name         String');
    expect(schema).not.toContain('mimeType     String');
    expect(schema).not.toContain('encryptedFEK String');
  });

  it('models blob transport for local and discord storage', () => {
    expect(schema).toContain('enum BlobStorageKind');
    expect(schema).toContain('LOCAL');
    expect(schema).toContain('DISCORD');
    expect(schema).toContain('storageKind');
    expect(schema).toContain('storagePath');
    expect(schema).toContain('ciphertextSizeBytes');
    expect(schema).toContain('ciphertextHash');
    expect(schema).toContain('healthStatus');
    expect(schema).toContain('healthCheckedAt');
    expect(schema).toContain('discordMessageId');
    expect(schema).toContain('discordChannelId');
    expect(schema).toContain('webhookId');
  });

  it('removes legacy ShareLink model', () => {
    expect(schema).not.toContain('model ShareLink');
    expect(schema).not.toContain('wrappedFEK   String');
    expect(schema).not.toContain('token        String');
  });
});
