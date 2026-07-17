import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Native tsconfig path-alias resolution (`@/*` -> `./*`).
    // Vite 6+ supports this without the vite-tsconfig-paths plugin.
    tsconfigPaths: true,
  },
  // tsconfig says `jsx: "preserve"` because Next runs its own JSX transform.
  // Vite's transformer inherits that and hands import analysis raw JSX, which
  // fails to parse for any .tsx a test imports. This does NOT make components
  // renderable — there is still no DOM, by design — it only lets a test import
  // a pure helper that happens to live beside the component that uses it.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    // Node environment — these tests cover server-side helpers (server
    // actions, zod schemas, auth-resolution logic). No DOM needed.
    environment: "node",
    include: ["tests/**/*.test.ts", "lib/**/*.test.ts"],
    globals: false,
  },
});
