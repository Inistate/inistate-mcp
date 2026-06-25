import { defineConfig } from "vitest/config";

// Two suites (server.test.ts, tools.schema.test.ts) spawn `node build/index.js`
// and assert against the live tool schemas. `vitest run` does not compile, so
// without this a stale build/ silently tests old code — a real trap that hid a
// validate_design schema "failure" that was actually just an outdated artifact.
// Compile once before the suite so the spawned server always matches src/.
export default defineConfig({
  test: {
    globalSetup: "./vitest.global-setup.ts",
  },
});
