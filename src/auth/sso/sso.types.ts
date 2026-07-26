/** The ID token claims this app reads. `openid-client` has already validated iss/aud/exp/signature. */
export interface SsoIdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

/** Response body for POST /auth/sso/start — same shape whether or not the domain has SSO, so a
 *  domain-probing attacker can't distinguish "no SSO" from "SSO disabled" by response shape. */
export type SsoStartResponse = { sso: true; redirectUrl: string } | { sso: false };
