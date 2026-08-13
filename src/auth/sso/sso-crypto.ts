import { decryptSecret as decrypt, encryptSecret as encrypt } from '../../common/secret-box';

/**
 * SSO client-secret encryption, keyed by SSO_ENCRYPTION_KEY.
 *
 * The implementation lives in common/secret-box.ts — shared with the LLM provider-key store, which
 * has the same requirement (a secret presented back to a third party, so hashing won't do) but its
 * own env var, so one leaked key doesn't unlock both. The wire format is unchanged, so rows written
 * before this was generalised still decrypt.
 */
const ENV_VAR = 'SSO_ENCRYPTION_KEY';

/** Encrypts an OIDC client secret for storage in SsoConnection.clientSecretEnc. */
export function encryptSecret(plaintext: string): Buffer {
  return encrypt(plaintext, ENV_VAR);
}

/** Decrypts a SsoConnection.clientSecretEnc value back to the plaintext client secret. */
export function decryptSecret(packed: Buffer): string {
  return decrypt(packed, ENV_VAR);
}
