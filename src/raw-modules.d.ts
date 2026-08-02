// Vite's `?raw` suffix imports a file's contents as a string. Used by
// source-level invariant tests (see src/__tests__/connector-route-removed.test.ts)
// that must assert a route was DELETED rather than merely disabled — something a
// behavioural test cannot distinguish. Declared here because this is a Workers
// project typed against @cloudflare/workers-types with no @types/node, so
// reading source via node:fs would not typecheck.
declare module '*?raw' {
  const content: string;
  export default content;
}
