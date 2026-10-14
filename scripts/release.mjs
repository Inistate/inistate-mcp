// Cut a release: consume pending changesets, bump + sync server.json, commit on main,
// merge into production, tag, and push. The tag push triggers .github/workflows/publish.yml
// (npm + MCP registry). Deployment is done by hand afterwards.
//
//   npm run release              full release
//   npm run release -- --no-push do everything locally, push nothing
import { execSync } from "node:child_process";
import fs from "node:fs";

const noPush = process.argv.includes("--no-push");

const run = (cmd) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};
const out = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
const fail = (msg) => {
  console.error(`\nrelease aborted: ${msg}`);
  process.exit(1);
};

if (out("git rev-parse --abbrev-ref HEAD") !== "main") fail("run this from the main branch");
if (out("git status --porcelain --untracked-files=no")) fail("tracked files have uncommitted changes");

run("git fetch origin");
if (out("git rev-parse main") !== out("git rev-parse origin/main")) {
  fail("main is not in sync with origin/main (pull or push first)");
}

const pending = fs.readdirSync(".changeset").filter((f) => f.endsWith(".md") && f !== "README.md");
if (pending.length === 0) fail("no pending changeset; run `npm run changeset` first");

run("npm test");
run("npm run build");

run("npx changeset version");
run("node scripts/sync-server-json.js");
run("npm install --package-lock-only");

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const tag = `v${version}`;
if (out(`git tag -l ${tag}`)) fail(`tag ${tag} already exists`);

run("git add -A .changeset CHANGELOG.md package.json package-lock.json server.json");
run(`git commit -m "Release ${tag}"`);

run("git checkout production");
try {
  run("git pull --ff-only origin production");
  run("git merge main --no-edit");
  run(`git tag ${tag}`);
  if (noPush) {
    console.log(`\n--no-push: stopping. To finish: git push origin main production ${tag}`);
  } else {
    run(`git push origin main production ${tag}`);
    console.log(`\nReleased ${tag}. Watch the Publish run in GitHub Actions, then deploy by hand.`);
  }
} finally {
  run("git checkout main");
}
