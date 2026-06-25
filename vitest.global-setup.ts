import { execSync } from "node:child_process";

/**
 * Compile src/ → build/ once before the test run. The schema/server suites
 * spawn `node build/index.js`; this guarantees that artifact reflects the
 * current source instead of a stale prior build.
 */
export default function setup(): void {
  execSync("npm run build", { stdio: "inherit" });
}
