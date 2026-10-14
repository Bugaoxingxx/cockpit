# App Health

Cockpit package that lists Docker containers matching configurable name or
label filters, with status, optional CPU/memory, and restart count. Aimed at
company Docker app health monitoring on this Cockpit fork.

## Requirements

- Cockpit (this tree, or a system install of Cockpit ≥ 266)
- **Docker CLI** available to the logged-in Cockpit user (`docker` on `$PATH`,
  e.g. `/usr/bin/docker`, `/usr/local/bin/docker`, or `/snap/bin/docker`)
- Permission to talk to the Docker daemon (user in the `docker` group, or root /
  Cockpit administrative access as appropriate for your site)

The package appears in the menu when Docker is installed at one of the paths
checked in `manifest.json` `conditions` (same multi-path pattern as
`pkg/sosreport`).

## Container filter (company apps)

The list is **not** every container on the host. Matching uses `manifest.json`
`config` (overridable via `/etc/cockpit/app-health.override.json`):

| Key | Purpose |
| --- | --- |
| `name-prefixes` | Array of strings; container name must start with one of them |
| `label-selectors` | Array of `key=value` or `key` strings; container labels must match at least one |

Default shipped config:

```json
"label-selectors": ["cockpit.app-health=true"]
```

Tag company apps when creating them, for example:

```bash
docker run --name payroll-api --label cockpit.app-health=true …
```

Or set name prefixes for your naming convention:

```json
{
  "config": {
    "name-prefixes": ["company-", "app-"],
    "label-selectors": []
  }
}
```

A container is listed when it matches **any** configured name prefix **or** any
configured label selector. If both arrays are empty, nothing is listed until
you configure filters.

## What is implemented

| Feature | Status |
| --- | --- |
| Menu entry **Application Health** (English msgid; translated in `.po`) | Done |
| List containers via `docker ps -a --format` | Done |
| Filter by manifest `name-prefixes` / `label-selectors` | Done |
| Name, image, status, ports | Done |
| Restart count via batched `docker inspect` (50 IDs per call) | Done |
| CPU / memory via `docker stats --no-stream`, joined by container ID | Done |
| Manual refresh + auto-refresh every 8s on the list | Done |
| Container detail view | **Stub** (placeholder page) |
| Start / stop / restart actions | **Not implemented** |
| Live streaming stats | **Not implemented** |

## Tests

Unit tests for filter/stats helpers live in `pkg/app-health/test-app-health-lib.js`
and run with the repo QUnit harness (`./build.js` then open `qunit/` in a
browser, or the full Cockpit `make check` flow). There is no browser integration
test for this package yet.

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
2. `docker inspect --format '{{json .}}' …` — restart counts and labels (batched)
3. `docker stats --no-stream --format '{{json .}}'` — one-shot CPU / memory for running containers

If any command fails (Docker missing, permission denied, daemon down), the page
shows an error alert with the stderr message.

## Layout note

This lives under `pkg/app-health` so it builds with the main Cockpit `build.js`
pipeline (same friction as `pkg/sosreport`, `pkg/metrics`, …). A separate
[starter-kit](https://github.com/cockpit-project/starter-kit) repo is the usual
pattern for *out-of-tree* plugins; here the monorepo path is intentional.
