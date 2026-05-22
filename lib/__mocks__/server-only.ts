// no-op stub for the `server-only` Next.js guard.
//
// `server-only` is bundled inside Next.js itself and resolved by its custom
// webpack/module resolver. Vitest runs in plain Node (outside Next.js) so it
// cannot find the package. This stub satisfies the import with zero side-effects,
// allowing integration tests that import server-side modules to run normally.
//
// The runtime guard is purely a build-time / bundler-time mechanism — it throws
// when a server-only module is imported on the client bundle. In test environments
// there is no client bundle, so the stub is semantically correct.
export {};
