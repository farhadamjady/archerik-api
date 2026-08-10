import { decryptSecret, encryptSecret } from '../src/common/secret-box';
import {
  decryptSecret as decryptSso,
  encryptSecret as encryptSso,
} from '../src/auth/sso/sso-crypto';

/**
 * Pure unit tests — no app, no DB. They live under the e2e runner because that is the only
 * ts-jest-configured jest project in the repo (`npm test` has no transform for TS).
 *
 * The golden vector is the point of this file. A plain round-trip test would still pass if the
 * wire format changed on both sides at once; only a ciphertext captured from the PREVIOUS
 * implementation proves that sso_connections rows already in the database still decrypt after
 * secret-box.ts was generalised out of sso-crypto.ts.
 */

// Produced by the pre-refactor sso-crypto.ts under GOLDEN_KEY. Do not regenerate.
const GOLDEN_KEY = 'srkQP7ibix5sRrT6NclnKlow0bWpLNm0RelBxlZdl6E=';
const GOLDEN_PLAINTEXT = 'golden-vector-client-secret-v1';
const GOLDEN_CIPHERTEXT =
  'AW1qda3PHOk1bptt3J3TMZnC7fWGOV3ABYc9oJd4DHJrtH41Pg8qjQkS7/7ywIyWGgpXcXu+iXhRBik=';

const ENV_VAR = 'TEST_SECRET_KEY';
const OTHER_ENV_VAR = 'TEST_SECRET_KEY_OTHER';
// A second, unrelated 32-byte key — used to prove the env var actually scopes decryption.
const OTHER_KEY = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaQ==';

describe('secret-box', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env[ENV_VAR] = GOLDEN_KEY;
    process.env[OTHER_ENV_VAR] = OTHER_KEY;
    process.env.SSO_ENCRYPTION_KEY = GOLDEN_KEY;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('decrypts a ciphertext written by the pre-refactor implementation', () => {
    expect(decryptSecret(Buffer.from(GOLDEN_CIPHERTEXT, 'base64'), ENV_VAR)).toBe(GOLDEN_PLAINTEXT);
  });

  it('decrypts the golden vector through the SSO wrapper too', () => {
    // The wrapper is what sso-client-registry.service.ts actually calls.
    expect(decryptSso(Buffer.from(GOLDEN_CIPHERTEXT, 'base64'))).toBe(GOLDEN_PLAINTEXT);
    expect(decryptSso(encryptSso(GOLDEN_PLAINTEXT))).toBe(GOLDEN_PLAINTEXT);
  });

  it('round-trips and emits the versioned wire format', () => {
    const packed = encryptSecret('hunter2', ENV_VAR);
    expect(packed.readUInt8(0)).toBe(1); // version byte
    expect(packed.length).toBeGreaterThan(1 + 12 + 16); // version + iv + authTag + ciphertext
    expect(decryptSecret(packed, ENV_VAR)).toBe('hunter2');
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encryptSecret('same-input', ENV_VAR);
    const b = encryptSecret('same-input', ENV_VAR);
    expect(a.equals(b)).toBe(false);
    expect(decryptSecret(a, ENV_VAR)).toBe(decryptSecret(b, ENV_VAR));
  });

  it('rejects a ciphertext decrypted with a different env var key', () => {
    const packed = encryptSecret('cross-key', ENV_VAR);
    expect(() => decryptSecret(packed, OTHER_ENV_VAR)).toThrow();
  });

  it('rejects a tampered auth tag', () => {
    const packed = encryptSecret('tamper-me', ENV_VAR);
    packed[packed.length - 1] ^= 0xff; // flip a ciphertext bit
    expect(() => decryptSecret(packed, ENV_VAR)).toThrow();
  });

  it('fails closed when the key is missing or the wrong length', () => {
    delete process.env[ENV_VAR];
    expect(() => encryptSecret('x', ENV_VAR)).toThrow(/is not set/);

    process.env[ENV_VAR] = Buffer.from('too-short').toString('base64');
    expect(() => encryptSecret('x', ENV_VAR)).toThrow(/must decode to 32 bytes/);
  });

  it('rejects an unknown format version', () => {
    const packed = encryptSecret('versioned', ENV_VAR);
    packed.writeUInt8(9, 0);
    expect(() => decryptSecret(packed, ENV_VAR)).toThrow(/Unsupported secret format version: 9/);
  });
});
