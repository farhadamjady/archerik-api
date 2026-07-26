import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
// Leading byte so a future key-rotation scheme can change the format without a flag day.
const FORMAT_VERSION = 1;

/**
 * Client secrets must be sent back to the IdP's token endpoint on every callback, so — unlike
 * ApiKey.keyHash/Session.tokenHash — they can't be hash-only; they must be recoverable. No dev
 * default: a baked-in default key would let anyone decrypt every tenant's client secret, so this
 * fails closed if SSO_ENCRYPTION_KEY is missing or the wrong length.
 */
function loadKey(): Buffer {
  const raw = process.env.SSO_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('SSO_ENCRYPTION_KEY is not set — cannot encrypt/decrypt SSO client secrets');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `SSO_ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes (got ${key.length}) — generate with \`openssl rand -base64 32\``,
    );
  }
  return key;
}

/** Encrypts an OIDC client secret for storage in SsoConnection.clientSecretEnc. */
export function encryptSecret(plaintext: string): Buffer {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, authTag, ciphertext]);
}

/** Decrypts a SsoConnection.clientSecretEnc value back to the plaintext client secret. */
export function decryptSecret(packed: Buffer): string {
  const key = loadKey();
  const version = packed.readUInt8(0);
  if (version !== FORMAT_VERSION) {
    throw new Error(`Unsupported SSO secret format version: ${version}`);
  }
  const iv = packed.subarray(1, 1 + IV_LENGTH);
  const authTag = packed.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(1 + IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
