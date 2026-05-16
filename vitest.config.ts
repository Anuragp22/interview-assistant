import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Native tsconfig path-alias resolution (`@/*` -> `./*`).
    // Vite 6+ supports this without the vite-tsconfig-paths plugin.
    tsconfigPaths: true,
  },
  test: {
    // Node environment — these tests cover server-side helpers (server
    // actions, zod schemas, auth-resolution logic). No DOM needed.
    environment: "node",
    include: ["tests/**/*.test.ts", "lib/**/*.test.ts"],
    globals: false,
  },
});
