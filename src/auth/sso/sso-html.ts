/**
 * Full-page browser navigation target (not fetch): writes the session token to
 * sessionStorage['cartograph.token'] then redirects to APP_URL, so the UI needs no changes to pick
 * up an SSO-issued session — same response shape the old sso() stub returned.
 */
export function ssoRedirectHtml(token: string): string {
  const appUrl = process.env.APP_URL ?? 'http://localhost:5173';
  const payload = JSON.stringify(token);
  const target = JSON.stringify(appUrl);
  return `<!doctype html><meta charset="utf-8"><title>Signing in…</title><script>
try { sessionStorage.setItem('cartograph.token', ${payload}); } catch (e) {}
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
