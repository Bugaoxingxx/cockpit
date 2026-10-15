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
you configure filters. Invalid filter entries, non-array values, or an empty
effective rule set are surfaced as an inline notice banner in the UI (and a
non-array `label-selectors` value falls back to the default
`cockpit.app-health=true`).

## What is implemented

| Feature | Status |
| --- | --- |
| Menu entry **Application Health** + search keywords (English msgids in `manifest.json`; translated in `.po`) | Done |
| List containers via `docker ps -a --format` | Done |
| Filter by manifest `name-prefixes` / `label-selectors` (with UI notice on invalid/empty config) | Done |
| Name, image, status, ports | Done |
| Restart count via batched `docker inspect` on **candidates only** (50 IDs/call, shared global concurrency cap of 4, vanished-ID extraction batch retry + binary divide-and-conquer fallback when a container disappears mid-refresh) | Done |
| CPU / memory via batched `docker stats` on **filtered running** IDs (shared global concurrency cap of 4, vanished-ID extraction batch retry + binary divide-and-conquer fallback, bounded by a dedicated stage timeout so slow stats degrade to a warning without failing the round) | Done |
| Manual refresh + auto-refresh every 8s (manual preemption over background, `AbortSignal` cancellation on per-command/per-stage/per-round timeouts, timezone-aware timestamps + failure count on both warnings and errors) | Done |
| Container detail view | **Stub** (placeholder page) |
| Start / stop / restart actions | **Not implemented** |
| Live streaming stats | **Not implemented** |

## Tests & i18n

Unit tests for filter matching, config validation, shared global concurrency,
per-command/per-stage/per-round timeout cancellation (`AbortSignal`), fast-fail vs
vanished-ID batch retry / divide-and-conquer fallback on vanished containers, and refresh preemption/warning metadata
live in `pkg/app-health/test-app-health-lib.js` and run with the repo QUnit
harness (`./build.js` then open `qunit/` in a browser, or the full Cockpit
`make check` flow). There is no browser integration test for this package yet.

Menu `label` and `keywords` in `manifest.json` use English msgids (`docker`,
`container`, `app`, `health`, `monitor`) with `zh_CN` translations in
`po/zh_CN.po` (so Chinese keyword search works in the `zh_CN` locale while
English locales search by English keywords). Translations in `po/*.po` are
filtered per package by `pkg/lib/cockpit-po-plugin.js` using
`#: pkg/app-health/…` source references. In a full autotools checkout, refresh
template references via `make po/cockpit.pot` (`xgettext`, `html2po`, and
`manifest2po` in `po/Makefile.am`) and merge into `po/*.po` with `msgmerge`.

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

1. `docker ps -a` (optionally with `--filter label=…`) — candidate inventory only
2. `docker inspect --format '{{json .}}' …` — restart counts / labels for candidates (batched)
3. `docker stats --no-stream --format '{{json .}}' <ids…>` — CPU / memory for filtered running containers (batched)

If any command fails (Docker missing, permission denied, daemon down), the page
shows an error alert with the stderr message.

## Layout note

This lives under `pkg/app-health` so it builds with the main Cockpit `build.js`
pipeline (same friction as `pkg/sosreport`, `pkg/metrics`, …). A separate
[starter-kit](https://github.com/cockpit-project/starter-kit) repo is the usual
pattern for *out-of-tree* plugins; here the monorepo path is intentional.
