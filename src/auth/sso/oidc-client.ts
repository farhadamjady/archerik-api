// `openid-client` ships ESM-only (package.json "type": "module"), but this project compiles to
// CommonJS (tsconfig "module": "commonjs"). A plain `import()` here isn't enough on its own: with
// `module: "commonjs"` the TS compiler downlevels dynamic `import()` expressions into
// `require(...)` calls (verified by inspecting the emitted JS), and `require()` of an ESM-only
// package throws ERR_REQUIRE_ESM. Routing the call through `new Function(...)` hides it from that
// static rewrite, so it stays a genuine native `import()` at runtime — the one thing Node's CJS
// loader has always been able to do with an ESM target, independent of Node version.
//
// The trailing unique marker is load-bearing, not decoration. V8 caches `new Function`
// compilations by source text, and the cached function stays bound to the realm that compiled it
// first. That is invisible in production (one realm, compiled once) but breaks under Jest, which
// gives every test file its own realm and tears it down when the file ends: the second suite to
// evaluate this module got back the FIRST suite's compiled function, whose `import()` resolves
// against an environment that no longer exists, and every SSO test died with "Test environment has
// been torn down". Making the source unique per compilation forces a fresh compile in the current
// realm. It only reproduced when sso.e2e-spec did not run first, so a warm Jest cache (which
// reorders previously-failing suites to the front) hid it locally while CI failed every time.
const dynamicImport = new Function(
  'specifier',
  `return import(specifier); // realm:${Math.random().toString(36).slice(2)}`,
) as (specifier: string) => Promise<unknown>;

type OidcClientModule = typeof import('openid-client');

let modulePromise: Promise<OidcClientModule> | undefined;

export function loadOidcClient(): Promise<OidcClientModule> {
  modulePromise ??= dynamicImport('openid-client') as Promise<OidcClientModule>;
  return modulePromise;
}
