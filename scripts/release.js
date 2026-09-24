/**
 * Release, in an order that cannot advertise something that does not exist.
 *
 * The npm scripts this replaces could each half-release:
 *
 *   - `release:mcp` published to the MCP registry without ever publishing to npm. server.json names
 *     an npm package AND version, so the registry then told every client to install a version that
 *     404s. That is not hypothetical: at the time this was written the registry advertised 1.1.1,
 *     npm's latest was 1.1.3, and the repository sat at an unpublished 1.1.4.
 *   - None of them committed or tagged the version bump, so `changeset version` left the repository
 *     dirty and a second run bumped again.
 *   - `release` began with `npm i`, which can rewrite the lockfile in the middle of a release.
 *
 * The ordering here is the guarantee: npm first, because the registry entry points AT npm, and the
 * registry step refuses to run until it can see that exact version on npm.
 *
 * Usage:  node scripts/release.js [--dry-run] [--skip-registry]
 */

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const skipRegistry = args.has("--skip-registry");

let step = 0;
const say = (message) => console.log(`\n[${++step}] ${message}`);
const fail = (message) => {
  console.error(`\nRelease stopped: ${message}`);
  process.exit(1);
};

/** Run a command, streaming its output. In a dry run, print it instead. */
const run = (command, { always = false } = {}) => {
  if (dryRun && !always) {
    console.log(`   (dry run) ${command}`);
    return;
  }
  execSync(command, { stdio: "inherit" });
};

const capture = (command) => execSync(command, { encoding: "utf8" }).trim();
const readPackage = () => JSON.parse(fs.readFileSync("package.json", "utf8"));

// ---------------------------------------------------------------- pre-flight

say("Checking the working tree is clean");
// A release publishes what is committed. Releasing from a dirty tree means the tag does not describe
// what went out, and the version bump below would be mixed in with unrelated edits.
const dirty = capture("git status --porcelain");
if (dirty) {
  fail(`the working tree has uncommitted changes:\n${dirty}\n\nCommit or stash them first.`);
}

say("Checking there is something to release");
const pending = fs
  .readdirSync(".changeset")
  .filter((f) => f.endsWith(".md") && f !== "README.md");
if (pending.length === 0) {
  fail("no changesets in .changeset/. Run `npm run changeset` to describe the change first.");
}
console.log(`   ${pending.length} changeset(s): ${pending.join(", ")}`);

say("Installing exactly the lockfile");
run("npm ci");

say("Building");
run("npm run build");

say("Testing");
run("npm test");

// ---------------------------------------------------------------- version

say("Applying the changesets and syncing server.json");
run("npm run version");

const pkg = readPackage();
const version = pkg.version;
const tag = `v${version}`;
console.log(`   version is now ${version}`);

// server.json is what the registry serves, and sync-server-json.js has just rewritten it from
// package.json. Check rather than assume: a mismatch here is how the registry ends up pointing at
// the wrong package version.
const server = JSON.parse(fs.readFileSync("server.json", "utf8"));
const advertised = server.packages?.[0];
if (server.version !== version || (advertised && advertised.version !== version)) {
  fail(
    `server.json is out of step with package.json (server ${server.version}, package ${advertised?.version}, expected ${version}).`,
  );
}

say(`Committing and tagging ${tag}`);
run(`git add -A`);
run(`git commit -m "Release ${version}"`);
run(`git tag ${tag}`);

// ---------------------------------------------------------------- publish

say(`Publishing ${pkg.name}@${version} to npm`);
// First irreversible step. Everything above can be undone with a reset; this cannot.
run("npm publish");

if (skipRegistry) {
  console.log("\n   --skip-registry: stopping before the MCP registry.");
} else {
  say("Confirming npm actually has that version before telling the registry about it");
  if (dryRun) {
    console.log("   (dry run) npm view ...");
  } else {
    let onNpm = "";
    try {
      // The registry entry points at npm, so this is the check that makes the whole ordering real.
      onNpm = execFileSync("npm", ["view", `${pkg.name}@${version}`, "version"], {
        encoding: "utf8",
      }).trim();
    } catch {
      onNpm = "";
    }
    if (onNpm !== version) {
      fail(
        `npm does not report ${pkg.name}@${version} yet (got "${onNpm || "nothing"}").\n` +
          "Refusing to publish a registry entry that points at a version nobody can install.\n" +
          "npm's read-through cache can lag a few seconds — check `npm view` and, once it is there, " +
          "run: npx mcp-publisher validate && npx mcp-publisher login github && npx mcp-publisher publish",
      );
    }
    console.log(`   npm reports ${onNpm}`);
  }

  say("Publishing to the MCP registry");
  run("npx mcp-publisher validate");
  // Interactive device flow: it prints a code to paste into GitHub.
  run("npx mcp-publisher login github");
  run("npx mcp-publisher publish");
}

say("Pushing the release commit and tag");
run("git push --follow-tags");

console.log(`\nReleased ${pkg.name}@${version}.`);
if (dryRun) {
  console.log("(dry run — nothing above actually happened except the checks.)");
}
