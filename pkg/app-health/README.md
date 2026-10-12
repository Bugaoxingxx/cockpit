# App Health (应用健康)

Cockpit package that lists Docker containers (by `docker run --name`) with
status, optional CPU/memory, and restart count. Aimed at company Docker app
health monitoring on this Cockpit fork.

## Requirements

- Cockpit (this tree, or a system install of Cockpit ≥ 266)
- **Docker CLI** available to the logged-in Cockpit user (`docker` on `$PATH`,
  typically `/usr/bin/docker`)
- Permission to talk to the Docker daemon (user in the `docker` group, or root /
  Cockpit administrative access as appropriate for your site)

The package only appears in the menu when `/usr/bin/docker` exists
(`manifest.json` `conditions`).

## What is implemented

| Feature | Status |
| --- | --- |
| Menu entry **应用健康** | Done |
| List containers via `docker ps -a --format` | Done |
| Name, image, status, ports | Done |
| Restart count via `docker inspect` | Done |
| CPU / memory via `docker stats --no-stream` (running only) | Done |
| Refresh button | Done |
| Container detail view | **Stub** (placeholder page) |
| Start / stop / restart actions | **Not implemented** |
| Live streaming stats | **Not implemented** |

## Build (in this monorepo)

From the Cockpit repo root (after `npm` / `tools/node-modules` deps are present):

```bash
# build only this package
./build.js app-health

# or watch while developing
./build.js -w app-health
```

Output lands in `dist/app-health/`.

To develop against a running Cockpit on the same machine:

```bash
mkdir -p ~/.local/share/cockpit
# either link the whole dist tree (usual Cockpit HACKING.md workflow):
ln -sfn "$(pwd)/dist" ~/.local/share/cockpit
# or link only this package:
# ln -sfn "$(pwd)/dist/app-health" ~/.local/share/cockpit/app-health
```

Then open Cockpit in the browser and reload. Log in as a user that can run
`docker ps`.

Full tree install (with the rest of Cockpit) still goes through the normal
autotools / `make install` path; this package is registered in `files.js` like
other `pkg/*` modules.

## Commands used (bridge spawn)

The UI runs these via `cockpit.spawn` (no custom bridge):

1. `docker ps -a --format '{{json .}}'` — inventory (name, status, image, ports, id)
2. `docker inspect --format '{{json .}}' …` — restart counts (and similar metadata)
3. `docker stats --no-stream --format '{{json .}}'` — one-shot CPU / memory for running containers

If any command fails (Docker missing, permission denied, daemon down), the page
shows an error alert with the stderr message.

## Layout note

This lives under `pkg/app-health` so it builds with the main Cockpit `build.js`
pipeline (same friction as `pkg/sosreport`, `pkg/metrics`, …). A separate
[starter-kit](https://github.com/cockpit-project/starter-kit) repo is the usual
pattern for *out-of-tree* plugins; here the monorepo path is intentional.
