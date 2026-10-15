/*
 * Copyright (C) 2026 Chaoqian Li
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

export const DEFAULT_LABEL_SELECTORS = ["cockpit.app-health=true"];
export const INSPECT_BATCH_SIZE = 50;
export const STATS_BATCH_SIZE = 50;
export const LIST_REFRESH_MS = 8000;

/** Parse NDJSON (one JSON object per line) from docker --format '{{json .}}'. */
export function parseJsonLines(text) {
    const out = [];
    for (const line of (text || "").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            out.push(JSON.parse(trimmed));
        } catch (e) {
            console.warn("app-health: skip bad JSON line", trimmed, e);
        }
    }
    return out;
}

export function normalizeName(name) {
    if (!name)
        return "";
    return name.startsWith("/") ? name.slice(1) : name;
}

export function normalizeContainerId(id) {
    if (!id)
        return "";
    return id.length > 12 ? id.slice(0, 12) : id;
}

/** Split an array into chunks of at most `size` elements. */
export function chunkArray(items, size) {
    if (!size || size < 1)
        return items.length ? [items] : [];
    const chunks = [];
    for (let i = 0; i < items.length; i += size)
        chunks.push(items.slice(i, i + size));
    return chunks;
}

export function isValidLabelKey(key) {
    return typeof key === "string" && key.length > 0 && !/\s/.test(key);
}

/**
 * Parse a label selector into trimmed `{ key, value }`.
 * When `=` is absent, `value` is `null` (presence match).
 */
export function parseLabelSelector(selector) {
    if (typeof selector !== "string")
        return { key: "", value: null };
    const trimmed = selector.trim();
    if (!trimmed)
        return { key: "", value: null };
    const eq = trimmed.indexOf("=");
    if (eq === -1)
        return { key: trimmed, value: null };
    return {
        key: trimmed.slice(0, eq).trim(),
        value: trimmed.slice(eq + 1).trim(),
    };
}

/**
 * Return trimmed, non-empty name prefixes from filter config.
 * Warns on and skips non-string or empty/whitespace-only entries.
 */
export function activeNamePrefixes(filter) {
    const raw = filter?.namePrefixes;
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw)) {
        console.warn("app-health: ignoring invalid namePrefixes (expected array)", raw);
        return [];
    }
    const out = [];
    for (const p of raw) {
        if (typeof p !== "string") {
            console.warn("app-health: ignoring non-string name prefix", p);
            continue;
        }
        const trimmed = p.trim();
        if (!trimmed) {
            console.warn("app-health: ignoring empty name prefix", p);
            continue;
        }
        out.push(trimmed);
    }
    return out;
}

/**
 * Return trimmed, validated label selectors from filter config.
 * Warns on and skips non-string, empty, or malformed selectors (e.g. `=val` or whitespace in key).
 */
export function activeLabelSelectors(filter) {
    const raw = filter?.labelSelectors;
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw)) {
        console.warn("app-health: ignoring invalid labelSelectors (expected array)", raw);
        return [];
    }
    const out = [];
    for (const s of raw) {
        if (typeof s !== "string") {
            console.warn("app-health: ignoring non-string label selector", s);
            continue;
        }
        const trimmed = s.trim();
        if (!trimmed) {
            console.warn("app-health: ignoring empty label selector", s);
            continue;
        }
        const { key, value } = parseLabelSelector(trimmed);
        if (!isValidLabelKey(key)) {
            console.warn("app-health: ignoring invalid label selector", s);
            continue;
        }
        out.push(value === null || value === "" ? key : `${key}=${value}`);
    }
    return out;
}

export function filterNeedsLabels(filter) {
    return activeLabelSelectors(filter).length > 0;
}

/** Map manifest label selector to `docker ps --filter` value, or `null` if invalid. */
export function labelSelectorToDockerFilter(selector) {
    const { key, value } = parseLabelSelector(selector);
    if (!isValidLabelKey(key)) {
        console.warn("app-health: ignoring invalid label selector", selector);
        return null;
    }
    if (value === null || value === "")
        return `label=${key}`;
    return `label=${key}=${value}`;
}

/**
 * Check whether `containerLabels` matches at least one configured selector.
 * Returns `false` when `selectors` is empty, null/undefined, or contains no valid selectors
 * (an empty selector list matches nothing, not everything).
 * Selectors and their keys/values are trimmed before comparison.
 */
export function labelsMatch(containerLabels, selectors) {
    const active = activeLabelSelectors({ labelSelectors: selectors });
    if (!active.length)
        return false;
    const labels = containerLabels || {};
    for (const sel of active) {
        const { key, value } = parseLabelSelector(sel);
        const lv = labels[key];
        if (lv === undefined)
            continue;
        if (value === null || value === "" || lv === value)
            return true;
    }
    return false;
}

/**
 * Check whether `name` starts with at least one configured prefix.
 * Returns `false` when `prefixes` is empty, null/undefined, or contains no valid prefixes
 * (an empty prefix list matches nothing, not everything).
 * Prefixes are trimmed before comparison.
 */
export function nameMatches(name, prefixes) {
    if (typeof name !== "string" || !name)
        return false;
    const active = activeNamePrefixes({ namePrefixes: prefixes });
    if (!active.length)
        return false;
    return active.some(prefix => name.startsWith(prefix));
}

/**
 * Decide whether a container belongs in the company app list.
 * When both prefix and label rules are configured, either match is enough.
 * When neither is configured, nothing is listed (configure manifest config).
 */
export function containerMatchesFilter(container, filter) {
    const namePrefixes = activeNamePrefixes(filter);
    const labelSelectors = activeLabelSelectors(filter);
    const hasPrefixRule = namePrefixes.length > 0;
    const hasLabelRule = labelSelectors.length > 0;

    if (!hasPrefixRule && !hasLabelRule)
        return false;

    if (container.labelFilterMatched && hasLabelRule)
        return true;

    if (hasPrefixRule && nameMatches(container.name, namePrefixes))
        return true;
    if (hasLabelRule && labelsMatch(container.labels, labelSelectors))
        return true;
    return false;
}

/** Merge container lists by ID (label-filter match flags are preserved). */
export function mergeContainersById(existing, incoming) {
    const byId = new Map(existing.map(c => [c.id, c]));
    for (const c of incoming) {
        if (!c.id)
            continue;
        const prev = byId.get(c.id);
        if (!prev) {
            byId.set(c.id, c);
            continue;
        }
        if (c.labelFilterMatched)
            prev.labelFilterMatched = true;
    }
    return [...byId.values()];
}

export function psRowToContainer(row) {
    const id = row.ID || row.Id || "";
    const name = normalizeName(
        (row.Names || row.Name || "").split(",")[0] || id.slice(0, 12)
    );
    return {
        id,
        name,
        image: row.Image || "",
        status: row.Status || "",
        state: row.State || "",
        ports: row.Ports || "",
        created: row.CreatedAt || row.RunningFor || "",
        labels: {},
        labelFilterMatched: false,
        restartCount: null,
        cpu: null,
        memory: null,
    };
}

export function applyInspectMetadata(containers, inspected) {
    const byId = {};
    for (const info of inspected) {
        const fullId = info.Id || "";
        const id = normalizeContainerId(fullId);
        const name = normalizeName(info.Name || "");
        const restartCount = info.RestartCount ?? info.State?.RestartCount ?? 0;
        const labels = info.Config?.Labels || {};
        const meta = { name, restartCount, fullId, state: info.State?.Status, labels };
        byId[id] = meta;
        if (fullId)
            byId[fullId] = meta;
    }
    for (const c of containers) {
        const meta = byId[c.id] || byId[normalizeContainerId(c.id)];
        if (!meta)
            continue;
        c.restartCount = meta.restartCount;
        c.labels = meta.labels;
        if (meta.state)
            c.state = meta.state;
        if (meta.name)
            c.name = meta.name;
    }
}

export function isContainerRunning(container) {
    const s = (container.state || container.status || "").toLowerCase();
    return s.startsWith("up") || s === "running";
}

/** Index docker stats rows by short container ID, with name as fallback. */
export function statsByContainerId(statsRows) {
    const byId = {};
    for (const s of statsRows) {
        const entry = {
            cpu: s.CPUPerc || s.CPUPercentage || null,
            memory: s.MemUsage || s.MemoryUsage || null,
        };
        const id = normalizeContainerId(s.ID || s.ContainerID || "");
        if (id)
            byId[id] = entry;
        const name = normalizeName(s.Name || s.Container || "");
        const nameKey = "name:" + name;
        if (name && !byId[nameKey])
            byId[nameKey] = entry;
    }
    return byId;
}

export function lookupStats(byId, container) {
    const id = normalizeContainerId(container.id);
    if (id && byId[id])
        return byId[id];
    const byName = byId["name:" + container.name];
    return byName || null;
}

export function isNoSuchContainerError(err) {
    const msg = err?.message || String(err || "");
    return /no such (?:container|object)/i.test(msg);
}

/**
 * Inspect candidate container IDs in concurrent batches of `INSPECT_BATCH_SIZE`.
 * If a multi-ID batch fails (e.g. a container vanished mid-refresh), retries each ID
 * individually so surviving containers still receive inspect metadata.
 * Containers that disappeared (`No such object` / `No such container`) are recorded
 * on `inspected.vanishedIds` without raising warnings.
 */
export async function dockerInspectAll(ids, spawn) {
    const cleanIds = [...new Set((ids || []).filter(Boolean))];
    const batches = chunkArray(cleanIds, INSPECT_BATCH_SIZE);
    const batchResults = await Promise.all(batches.map(async batch => {
        try {
            const inspectOut = await spawn([
                "inspect",
                "--format", "{{json .}}",
                ...batch,
            ]);
            return { rows: parseJsonLines(inspectOut), errors: [], vanishedIds: [] };
        } catch (err) {
            if (batch.length <= 1) {
                if (isNoSuchContainerError(err))
                    return { rows: [], errors: [], vanishedIds: [...batch] };
                return { rows: [], errors: [err], vanishedIds: [] };
            }
            const rows = [];
            const errors = [];
            const vanishedIds = [];
            await Promise.all(batch.map(async id => {
                try {
                    const out = await spawn([
                        "inspect",
                        "--format", "{{json .}}",
                        id,
                    ]);
                    rows.push(...parseJsonLines(out));
                } catch (retryErr) {
                    if (isNoSuchContainerError(retryErr))
                        vanishedIds.push(id);
                    else
                        errors.push(retryErr);
                }
            }));
            return { rows, errors, vanishedIds };
        }
    }));

    const inspected = [];
    const errors = [];
    const vanishedIds = new Set();
    for (const res of batchResults) {
        inspected.push(...res.rows);
        errors.push(...res.errors);
        for (const id of res.vanishedIds) {
            vanishedIds.add(id);
            vanishedIds.add(normalizeContainerId(id));
        }
    }
    if (inspected.length === 0 && errors.length > 0)
        throw errors[0];
    inspected.errors = errors;
    inspected.vanishedIds = vanishedIds;
    return inspected;
}

/**
 * Read one-shot `docker stats --no-stream` for `ids` in concurrent batches of `STATS_BATCH_SIZE`.
 * When a batch fails (e.g. one container was removed during a rolling update), retries each ID
 * in that batch individually so other containers in the batch still get CPU/memory stats.
 * Containers that disappeared (`No such container`) are ignored without raising warnings.
 */
export async function dockerStatsForIds(ids, spawn) {
    const cleanIds = [...new Set((ids || []).filter(Boolean))];
    const batches = chunkArray(cleanIds, STATS_BATCH_SIZE);
    const batchResults = await Promise.all(batches.map(async batch => {
        try {
            const statsOut = await spawn([
                "stats", "--no-stream", "--format", "{{json .}}",
                ...batch,
            ]);
            return { rows: parseJsonLines(statsOut), errors: [], vanishedIds: [] };
        } catch (err) {
            if (batch.length <= 1) {
                if (isNoSuchContainerError(err))
                    return { rows: [], errors: [], vanishedIds: [...batch] };
                return { rows: [], errors: [err], vanishedIds: [] };
            }
            const rows = [];
            const errors = [];
            const vanishedIds = [];
            await Promise.all(batch.map(async id => {
                try {
                    const singleOut = await spawn([
                        "stats", "--no-stream", "--format", "{{json .}}",
                        id,
                    ]);
                    rows.push(...parseJsonLines(singleOut));
                } catch (retryErr) {
                    if (isNoSuchContainerError(retryErr))
                        vanishedIds.push(id);
                    else
                        errors.push(retryErr);
                }
            }));
            return { rows, errors, vanishedIds };
        }
    }));

    const rows = [];
    const errors = [];
    const vanishedIds = new Set();
    for (const res of batchResults) {
        rows.push(...res.rows);
        errors.push(...res.errors);
        for (const id of res.vanishedIds) {
            vanishedIds.add(id);
            vanishedIds.add(normalizeContainerId(id));
        }
    }
    if (rows.length === 0 && errors.length > 0)
        throw errors[0];
    rows.errors = errors;
    rows.vanishedIds = vanishedIds;
    return rows;
}

export async function fetchAllPsContainers(spawn) {
    const psOut = await spawn([
        "ps", "-a",
        "--format", "{{json .}}",
    ]);
    return parseJsonLines(psOut).map(psRowToContainer);
}

export async function fetchPsWithLabelSelector(selector, spawn) {
    const dockerFilter = labelSelectorToDockerFilter(selector);
    if (!dockerFilter)
        return [];
    const psOut = await spawn([
        "ps", "-a",
        "--filter", dockerFilter,
        "--format", "{{json .}}",
    ]);
    return parseJsonLines(psOut).map(row => {
        const c = psRowToContainer(row);
        c.labelFilterMatched = true;
        return c;
    });
}

/**
 * Build candidate containers without inspecting the whole host: label rules use
 * `docker ps --filter` concurrently across unique selectors, name rules filter
 * the ps list in memory, union when both.
 */
export async function gatherCandidates(filter, spawn) {
    const namePrefixes = activeNamePrefixes(filter);
    const labelSelectors = [...new Set(activeLabelSelectors(filter))];

    if (namePrefixes.length === 0 && labelSelectors.length === 0)
        return [];

    const tasks = labelSelectors.map(sel => fetchPsWithLabelSelector(sel, spawn));
    if (namePrefixes.length > 0) {
        tasks.push(
            fetchAllPsContainers(spawn).then(all =>
                all.filter(c => nameMatches(c.name, namePrefixes))
            )
        );
    }

    const lists = await Promise.all(tasks);
    let candidates = [];
    for (const list of lists)
        candidates = mergeContainersById(candidates, list);

    return candidates;
}

function defaultInspectWarning(msg) {
    return `Could not inspect containers (restart counts and labels may be incomplete): ${msg}`;
}

function defaultStatsWarning(msg) {
    return `Could not read container stats (CPU/memory unavailable): ${msg}`;
}

/**
 * Load container list + restart counts + one-shot stats for filtered apps only.
 * `options` may be a `spawn(args)` function or `{ spawn, formatInspectWarning, formatStatsWarning }`.
 */
export async function loadContainers(filter, options = {}) {
    const opts = typeof options === "function" ? { spawn: options } : (options || {});
    const spawn = opts.spawn;
    const formatInspectWarning = opts.formatInspectWarning || defaultInspectWarning;
    const formatStatsWarning = opts.formatStatsWarning || defaultStatsWarning;

    if (typeof spawn !== "function")
        throw new Error("loadContainers requires a spawn function");

    const normalizedFilter = {
        namePrefixes: activeNamePrefixes(filter),
        labelSelectors: activeLabelSelectors(filter),
    };

    let warning = null;
    const candidates = await gatherCandidates(normalizedFilter, spawn);

    if (candidates.length === 0)
        return { containers: [], warning: null };

    let vanishedIds = new Set();
    const inspectIds = candidates.map(c => c.id).filter(Boolean);
    if (inspectIds.length > 0) {
        try {
            const inspected = await dockerInspectAll(inspectIds, spawn);
            applyInspectMetadata(candidates, inspected);
            if (inspected.vanishedIds)
                vanishedIds = inspected.vanishedIds;
            if (inspected.errors?.length > 0) {
                const err = inspected.errors[0];
                warning = formatInspectWarning(err?.message || String(err));
            }
        } catch (e) {
            warning = formatInspectWarning(e?.message || String(e));
            console.warn("app-health: docker inspect failed", e);
        }
    }

    const survivingCandidates = vanishedIds.size > 0
        ? candidates.filter(c => !vanishedIds.has(c.id) && !vanishedIds.has(normalizeContainerId(c.id)))
        : candidates;
    const filtered = survivingCandidates.filter(c => containerMatchesFilter(c, normalizedFilter));

    const runningIds = filtered.filter(isContainerRunning).map(c => c.id).filter(Boolean);
    if (runningIds.length > 0) {
        try {
            const statsRows = await dockerStatsForIds(runningIds, spawn);
            const byId = statsByContainerId(statsRows);
            for (const c of filtered) {
                const st = lookupStats(byId, c);
                if (st) {
                    c.cpu = st.cpu;
                    c.memory = st.memory;
                }
            }
            if (statsRows.errors?.length > 0) {
                const err = statsRows.errors[0];
                const statsWarning = formatStatsWarning(err?.message || String(err));
                warning = warning ? `${warning} ${statsWarning}` : statsWarning;
            }
        } catch (e) {
            const statsWarning = formatStatsWarning(e?.message || String(e));
            warning = warning ? `${warning} ${statsWarning}` : statsWarning;
            console.warn("app-health: docker stats failed", e);
        }
    }

    filtered.sort((a, b) => a.name.localeCompare(b.name));
    return { containers: filtered, warning };
}

export function formatWarningTimestamp(now = new Date()) {
    if (typeof now === "string")
        return now;
    const d = now instanceof Date ? now : new Date(now);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
}

export function formatWarningWithMeta(message, timestamp, consecutiveFailures) {
    return `[${timestamp}, consecutive failures: ${consecutiveFailures}] ${message}`;
}

/**
 * Coordinate manual and background refreshes so that:
 * - In-flight refreshes are tracked with an integer counter (`inFlightCount`).
 * - Both manual and background calls obey "at most one refresh round in flight at a time".
 * - Warnings include a timestamp and consecutive failure count, resetting on clean success.
 */
export function createRefreshController({
    load,
    onStateChange,
    now = () => new Date(),
    formatWarningMeta = formatWarningWithMeta,
}) {
    let inFlightCount = 0;
    let generation = 0;
    let consecutiveFailures = 0;
    let lastWarningAt = null;
    let state = {
        containers: null,
        error: null,
        warning: null,
        loading: true,
        inFlightCount: 0,
        consecutiveFailures: 0,
        lastWarningAt: null,
    };

    const emit = patch => {
        state = { ...state, ...patch, inFlightCount, consecutiveFailures, lastWarningAt };
        if (onStateChange)
            onStateChange(state);
        return state;
    };

    async function refresh(options = {}) {
        const background = options.background === true;
        if (inFlightCount > 0)
            return false;

        inFlightCount += 1;
        const gen = ++generation;

        if (!background) {
            emit({ loading: true, error: null, warning: null });
        } else {
            emit({});
        }

        let completionPatch = {};
        try {
            const result = await load();
            if (gen === generation) {
                if (result.warning) {
                    consecutiveFailures += 1;
                    lastWarningAt = formatWarningTimestamp(now());
                    const formatted = formatWarningMeta(result.warning, lastWarningAt, consecutiveFailures);
                    completionPatch = {
                        containers: result.containers,
                        error: null,
                        warning: formatted,
                    };
                } else {
                    consecutiveFailures = 0;
                    lastWarningAt = null;
                    completionPatch = {
                        containers: result.containers,
                        error: null,
                        warning: null,
                    };
                }
            }
        } catch (e) {
            if (gen === generation) {
                const message = e?.message || String(e);
                consecutiveFailures += 1;
                lastWarningAt = formatWarningTimestamp(now());

                if (background) {
                    const formatted = formatWarningMeta(message, lastWarningAt, consecutiveFailures);
                    completionPatch = { warning: formatted };
                } else {
                    completionPatch = {
                        containers: [],
                        error: message,
                        warning: null,
                    };
                }
            }
        } finally {
            inFlightCount = Math.max(0, inFlightCount - 1);
            const nextLoading = (!background && gen === generation)
                ? false
                : (inFlightCount === 0 ? false : state.loading);
            emit({
                ...completionPatch,
                loading: nextLoading,
            });
        }
        return true;
    }

    return {
        refresh,
        getState: () => state,
    };
}

