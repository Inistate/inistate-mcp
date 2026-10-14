# AGENTS.md

## Branches

- `main` is the **development** branch. Feature and fix work lands here.
- `production` is the **publishing** branch. Only release merges go here.
- Deployment is done by hand; there is no CI deploy. (The untracked `Jenkinsfile` is not in use.)
- Never commit feature work straight to `production`.

## Releasing

- A release is a `v*` tag (e.g. `v1.1.5`) on a commit that is on `production`. Pushing the tag runs `.github/workflows/publish.yml`, which publishes to npm and the MCP registry.
- Run `npm run release` from `main` (see `scripts/release.mjs`). It consumes pending changesets, bumps `package.json` and `server.json`, merges `main` into `production`, tags and pushes.
- Add a changeset (`npm run changeset`) for any change that should be released.
- The tag, `package.json` and `server.json` versions must agree; the workflow fails otherwise.
