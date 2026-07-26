// `openid-client` ships ESM-only (package.json "type": "module"), but this project compiles to
// CommonJS (tsconfig "module": "commonjs"). A plain `import()` here isn't enough on its own: with
// `module: "commonjs"` the TS compiler downlevels dynamic `import()` expressions into
// `require(...)` calls (verified by inspecting the emitted JS), and `require()` of an ESM-only
// package throws ERR_REQUIRE_ESM. Routing the call through `new Function(...)` hides it from that
// static rewrite, so it stays a genuine native `import()` at runtime — the one thing Node's CJS
// loader has always been able to do with an ESM target, independent of Node version.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

type OidcClientModule = typeof import('openid-client');

let modulePromise: Promise<OidcClientModule> | undefined;

export function loadOidcClient(): Promise<OidcClientModule> {
  modulePromise ??= dynamicImport('openid-client') as Promise<OidcClientModule>;
  return modulePromise;
}
