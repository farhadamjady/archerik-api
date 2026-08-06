import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
// Leading byte so a future key-rotation scheme can change the format without a flag day.
const FORMAT_VERSION = 1;

/**
 * Authenticated symmetric encryption for secrets that must be *recoverable*, not just comparable.
 *
 * Most credentials in this codebase are hash-only (ApiKey.keyHash, Session.tokenHash): they are
 * bearer tokens presented BY a client, so the backend only ever needs to compare them. The secrets
 * here are the opposite — they are presented BACK to a third party on every use (an OIDC client
 * secret to the IdP's token endpoint, an LLM provider key to Anthropic/OpenAI), so they have to be
 * decryptable.
 *
 * Each caller names its own env var, so one leaked key does not unlock every category of secret.
 * There is deliberately no dev default: a baked-in fallback key would let anyone decrypt every
 * tenant's secrets, so this fails closed when the var is missing or the wrong length.
 *
 * Wire format is `[version:1][iv:12][authTag:16][ciphertext:...]`, unchanged since the SSO-only
 * implementation this was generalised from — existing sso_connections rows decrypt as-is, which
 * test/secret-box.e2e-spec.ts pins with a golden vector.
 */
function loadKey(envVar: string): Buffer {
  const raw = process.env[envVar];
  if (!raw) {
    throw new Error(`${envVar} is not set — cannot encrypt/decrypt secrets`);
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `${envVar} must decode to ${KEY_LENGTH} bytes (got ${key.length}) — generate with \`openssl rand -base64 32\``,
    );
  }
  return key;
}

/** Encrypts a secret for storage in a Bytes column, keyed by the named env var. */
export function encryptSecret(plaintext: string, envVar: string): Buffer {
  const key = loadKey(envVar);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, authTag, ciphertext]);
}

/** Decrypts a value produced by {@link encryptSecret} with the same env var. */
export function decryptSecret(packed: Buffer, envVar: string): string {
  const key = loadKey(envVar);
  const version = packed.readUInt8(0);
  if (version !== FORMAT_VERSION) {
    throw new Error(`Unsupported secret format version: ${version}`);
  }
  const iv = packed.subarray(1, 1 + IV_LENGTH);
  const authTag = packed.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(1 + IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
