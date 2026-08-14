/**
 * The sessionStorage key the browser session is handed off under. This is a contract with
 * archerik-ui, which reads the same key (`TOKEN_KEY` in its `src/api.ts`) to pick up an SSO-issued
 * session. Changing it on one side alone silently breaks SSO login: the redirect succeeds and the
 * UI still shows the sign-in screen.
 */
export const SSO_TOKEN_STORAGE_KEY = 'archerik.token';

/**
 * Full-page browser navigation target (not fetch): writes the session token to
 * sessionStorage[SSO_TOKEN_STORAGE_KEY] then redirects to APP_URL, so the UI picks up an
 * SSO-issued session through the same path as a password login.
 */
export function ssoRedirectHtml(token: string): string {
  const appUrl = process.env.APP_URL ?? 'http://localhost:5173';
  const payload = JSON.stringify(token);
  const target = JSON.stringify(appUrl);
  return `<!doctype html><meta charset="utf-8"><title>Signing in…</title><script>
try { sessionStorage.setItem('${SSO_TOKEN_STORAGE_KEY}', ${payload}); } catch (e) {}
location.replace(${target});
</script>Signing you in…`;
}

/** Any callback failure lands here — never a silent logged-in-anyway path. */
export function ssoErrorHtml(): string {
  const appUrl = process.env.APP_URL ?? 'http://localhost:5173';
  const target = JSON.stringify(`${appUrl}?sso_error=1`);
  return `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><script>
location.replace(${target});
</script>Sign-in failed — redirecting…`;
}
