/**
 * Tiny .env loader for the eval runner.
 *
 * Next.js loads .env.local automatically inside `next dev` / `next build`,
 * but `tsx eval/run.ts` is a standalone Node process and needs its own
 * env-loading path. Rather than pulling in `dotenv` for a 15-line job we
 * parse the file ourselves — KEY=VALUE per line, ignore comments and
 * blanks, do not overwrite already-set variables.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function loadEnv(cwd: string = process.cwd()): void {
  for (const filename of [".env.local", ".env"]) {
    const path = join(cwd, filename);
    if (!existsSync(path)) continue;

    const contents = readFileSync(path, "utf8");
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;

      const eq = line.indexOf("=");
      if (eq === -1) continue;

      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();

      // Strip surrounding single/double quotes if balanced.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}
