/*
 * Copyright (C) 2026 Chaoqian Li
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

export const DEFAULT_LABEL_SELECTORS = ["cockpit.app-health=true"];
export const INSPECT_BATCH_SIZE = 50;
export const STATS_BATCH_SIZE = 50;
export const MAX_CONCURRENT_SPAWNS = 4;
export const DEFAULT_SPAWN_TIMEOUT_MS = 15000;
export const DEFAULT_REFRESH_TIMEOUT_MS = 30000;
export const LIST_REFRESH_MS = 8000;

const LIMITED_SPAWN_SYMBOL = Symbol.for("cockpit.app-health.limitedSpawn");
const SPAWN_SIGNAL_SYMBOL = Symbol.for("cockpit.app-health.spawnSignal");

function _(msgid) {
    const gettext = globalThis.cockpit?.gettext;
    return typeof gettext === "function" ? gettext(msgid) : msgid;
}

function formatMsg(template, ...args) {
    const fmt = globalThis.cockpit?.format;
    if (typeof fmt === "function")
        return fmt(template, ...args);
    return String(template).replace(/\$(\d+)/g, (match, idx) => {
        const i = Number(idx);
        return i < args.length ? String(args[i]) : match;
    });
}

export function createAbortError(message = "Refresh aborted") {
    const err = new Error(message);
    err.name = "AbortError";
    err.code = "ABORT_ERR";
    return err;
}

export function isAbortError(err) {
    return Boolean(err && (err.name === "AbortError" || err.code === "ABORT_ERR" || err.code === 20));
}

function throwIfAborted(signal) {
    if (!signal?.aborted)
        return;
    const reason = signal.reason;
    if (reason instanceof Error && reason.code === "ABORT_ERR")
        throw reason;
    const msg = reason instanceof Error
        ? reason.message
        : (typeof reason === "string" && reason ? reason : undefined);
    throw createAbortError(msg);
}

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

/**
 * Create a concurrency limiter (semaphore) that runs at most `limit` async functions at once.
 * Supports an optional `AbortSignal` so queued tasks are immediately dequeued and rejected on abort.
 */
export function createConcurrencyLimiter(limit = MAX_CONCURRENT_SPAWNS) {
    const max = Math.max(1, Number(limit) || MAX_CONCURRENT_SPAWNS);
    let active = 0;
    const queue = [];

    const next = () => {
        while (active < max && queue.length > 0) {
            const entry = queue.shift();
            if (entry.cleanupAbort)
                entry.cleanupAbort();
            if (entry.signal?.aborted) {
                try {
                    throwIfAborted(entry.signal);
                } catch (err) {
                    entry.reject(err);
                }
                continue;
            }
            active += 1;
            Promise.resolve()
                    .then(entry.fn)
                    .then(entry.resolve, entry.reject)
                    .finally(() => {
                        active -= 1;
                        next();
                    });
        }
    };

    return (fn, signal) => new Promise((resolve, reject) => {
        if (signal?.aborted) {
            try {
                throwIfAborted(signal);
            } catch (err) {
                reject(err);
            }
            return;
        }
        const entry = { fn, resolve, reject, signal, cleanupAbort: null };
        if (signal && typeof signal.addEventListener === "function") {
            const onAbort = () => {
                const idx = queue.indexOf(entry);
                if (idx !== -1)
                    queue.splice(idx, 1);
                entry.cleanupAbort = null;
                try {
                    throwIfAborted(signal);
                } catch (err) {
                    reject(err);
                }
            };
            signal.addEventListener("abort", onAbort, { once: true });
            entry.cleanupAbort = () => signal.removeEventListener("abort", onAbort);
        }
        queue.push(entry);
        next();
    });
}

/** Module-level shared spawn concurrency limiter across all refresh rounds. */
export const globalSpawnLimiter = createConcurrencyLimiter(MAX_CONCURRENT_SPAWNS);

function resolveSpawnLimiter(options = {}) {
    if (typeof options.limiter === "function")
        return options.limiter;
    if (options.concurrency !== undefined && Number(options.concurrency) !== MAX_CONCURRENT_SPAWNS)
        return createConcurrencyLimiter(options.concurrency);
    return globalSpawnLimiter;
}

function toLimitedSpawn(spawn, options = {}) {
    const signal = options.signal;
    if (spawn && spawn[LIMITED_SPAWN_SYMBOL]) {
        if (!signal || spawn[SPAWN_SIGNAL_SYMBOL] === signal)
            return spawn;
        return withSpawnTimeout(spawn, 0, { signal });
    }
    const limiter = resolveSpawnLimiter(options);
    const abortableSpawn = signal && spawn?.[SPAWN_SIGNAL_SYMBOL] !== signal
        ? withSpawnTimeout(spawn, 0, { signal })
        : spawn;
    const wrapped = (args, spawnOpts) => limiter(() => {
        throwIfAborted(signal);
        return abortableSpawn(args, spawnOpts);
    }, signal);
    wrapped[LIMITED_SPAWN_SYMBOL] = true;
    if (signal)
        wrapped[SPAWN_SIGNAL_SYMBOL] = signal;
    return wrapped;
}

/**
 * Map `items` with at most `concurrency` workers active in parallel.
 * Stops scheduling further items immediately when `options.signal` is aborted.
 */
export async function mapWithConcurrency(items, concurrency, mapper, options = {}) {
    const signal = options?.signal;
    throwIfAborted(signal);
    const list = Array.from(items || []);
    if (list.length === 0)
        return [];
    const limit = Math.max(1, Math.min(Number(concurrency) || MAX_CONCURRENT_SPAWNS, list.length));
    const results = new Array(list.length);
    let nextIndex = 0;

    const worker = async () => {
        while (nextIndex < list.length) {
            throwIfAborted(signal);
            const idx = nextIndex++;
            results[idx] = await mapper(list[idx], idx);
        }
    };

    await Promise.all(Array.from({ length: limit }, () => worker()));
    return results;
}

export function defaultSpawnTimeoutMessage(subcmd, timeoutMs) {
    return formatMsg(_("$0 timed out after $1ms"), subcmd, timeoutMs);
}

export function defaultRefreshTimeoutMessage(timeoutMs) {
    return formatMsg(_("Refresh timed out after $0ms"), timeoutMs);
}

/**
 * Wrap a `spawn(args, options)` function with a timeout and optional `AbortSignal` so hung or
 * superseded `docker` CLI processes are terminated (`proc.close("terminated")`) and rejected
 * instead of blocking or leaking in the background.
 */
export function withSpawnTimeout(spawn, timeoutMs = DEFAULT_SPAWN_TIMEOUT_MS, options = {}) {
    const signal = options?.signal;
    const formatTimeoutError = options?.formatTimeoutError || defaultSpawnTimeoutMessage;
    const hasTimeout = Boolean(timeoutMs && timeoutMs > 0);
    if (!hasTimeout && (!signal || spawn?.[SPAWN_SIGNAL_SYMBOL] === signal))
        return spawn;

    const wrapped = (args, spawnOptions) => new Promise((resolve, reject) => {
        if (signal?.aborted) {
            try {
                throwIfAborted(signal);
            } catch (err) {
                reject(err);
            }
            return;
        }

        let settled = false;
        let proc;
        let timer = null;
        let cleanupAbort = null;

        const terminateProc = () => {
            try {
                proc?.close?.("terminated");
            } catch (e) {
                // ignore close errors on timed-out or aborted process
            }
        };

        const cleanup = () => {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            if (cleanupAbort) {
                cleanupAbort();
                cleanupAbort = null;
            }
        };

        if (signal && typeof signal.addEventListener === "function") {
            const onAbort = () => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                terminateProc();
                try {
                    throwIfAborted(signal);
                } catch (err) {
                    reject(err);
                }
            };
            signal.addEventListener("abort", onAbort, { once: true });
            cleanupAbort = () => signal.removeEventListener("abort", onAbort);
        }

        if (hasTimeout) {
            timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                terminateProc();
                const subcmd = Array.isArray(args) && args[0] ? `docker ${args[0]}` : "docker command";
                const err = new Error(formatTimeoutError(subcmd, timeoutMs));
                err.code = "SPAWN_TIMEOUT";
                err.command = subcmd;
                err.timeoutMs = timeoutMs;
                reject(err);
            }, timeoutMs);
        }

        try {
            proc = spawn(args, spawnOptions);
        } catch (err) {
            settled = true;
            cleanup();
            reject(err);
            return;
        }

        Promise.resolve(proc).then(
            val => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                resolve(val);
            },
            err => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                reject(err);
            }
        );
    });
    if (spawn?.[LIMITED_SPAWN_SYMBOL])
        wrapped[LIMITED_SPAWN_SYMBOL] = true;
    if (signal)
        wrapped[SPAWN_SIGNAL_SYMBOL] = signal;
    return wrapped;
}

export function summarizeErrors(errors) {
    const msgs = [];
    const seen = new Set();
    for (const err of errors || []) {
        const msg = (err?.message || String(err || "")).trim();
        if (msg && !seen.has(msg)) {
            seen.add(msg);
            msgs.push(msg);
        }
    }
    return msgs.join("; ");
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
export function activeNamePrefixes(filter, callbacks = {}) {
    const raw = filter?.namePrefixes ?? filter?.["name-prefixes"];
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw)) {
        console.warn("app-health: ignoring invalid namePrefixes (expected array)", raw);
        callbacks.onInvalidType?.(raw);
        return [];
    }
    const out = [];
    for (const p of raw) {
        if (typeof p !== "string") {
            console.warn("app-health: ignoring non-string name prefix", p);
            callbacks.onInvalidEntry?.(p);
            continue;
        }
        const trimmed = p.trim();
        if (!trimmed) {
            console.warn("app-health: ignoring empty name prefix", p);
            callbacks.onInvalidEntry?.(p);
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
export function activeLabelSelectors(filter, callbacks = {}) {
    const raw = filter?.labelSelectors ?? filter?.["label-selectors"];
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw)) {
        console.warn("app-health: ignoring invalid labelSelectors (expected array)", raw);
        callbacks.onInvalidType?.(raw);
        return [];
    }
    const out = [];
    for (const s of raw) {
        if (typeof s !== "string") {
            console.warn("app-health: ignoring non-string label selector", s);
            callbacks.onInvalidEntry?.(s);
            continue;
        }
        const trimmed = s.trim();
        if (!trimmed) {
            console.warn("app-health: ignoring empty label selector", s);
            callbacks.onInvalidEntry?.(s);
            continue;
        }
        const { key, value } = parseLabelSelector(trimmed);
        if (!isValidLabelKey(key)) {
            console.warn("app-health: ignoring invalid label selector", s);
            callbacks.onInvalidEntry?.(s);
            continue;
        }
        out.push(value === null || value === "" ? key : `${key}=${value}`);
    }
    return out;
}

const DEFAULT_CONFIG_MESSAGES = {
    invalidNamePrefixesType: () => _("name-prefixes must be an array of non-empty strings"),
    invalidNamePrefixEntry: entry => formatMsg(_("ignored invalid name-prefixes entry: $0"), entry),
    invalidLabelSelectorsType: fallback => formatMsg(
        _("label-selectors must be an array; falling back to default ($0)"),
        fallback
    ),
    invalidLabelSelectorEntry: entry => formatMsg(_("ignored invalid label-selectors entry: $0"), entry),
    noActiveFilterRules: () =>
        _("no effective filter rules are active (both name-prefixes and label-selectors are empty); no containers will match"),
};

/**
 * Validate raw manifest `config` (`name-prefixes` / `label-selectors`) by reusing
 * `activeNamePrefixes` and `activeLabelSelectors`, returning normalized filter arrays
 * along with user-visible `configIssues` / `configWarning`.
 * When `label-selectors` is not an array (e.g. misconfigured as a string or number),
 * falls back to `defaultLabelSelectors` instead of silently showing an empty list.
 * When both effective `namePrefixes` and `labelSelectors` end up empty, records a notice
 * so the user knows why no containers can match.
 */
export function resolveFilterConfig(
    rawConfig = {},
    defaultLabelSelectors = DEFAULT_LABEL_SELECTORS,
    messages = {}
) {
    const fmt = { ...DEFAULT_CONFIG_MESSAGES, ...messages };
    const cfg = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    const rawSelectors = cfg["label-selectors"] ?? cfg.labelSelectors;
    const configIssues = [];

    const namePrefixes = activeNamePrefixes(cfg, {
        onInvalidType: () => configIssues.push(fmt.invalidNamePrefixesType()),
        onInvalidEntry: p => configIssues.push(fmt.invalidNamePrefixEntry(JSON.stringify(p))),
    });

    let labelSelectors = [];
    if (rawSelectors === undefined || rawSelectors === null) {
        labelSelectors = activeLabelSelectors({ labelSelectors: defaultLabelSelectors });
    } else {
        let invalidSelectorType = false;
        labelSelectors = activeLabelSelectors(cfg, {
            onInvalidType: () => { invalidSelectorType = true },
            onInvalidEntry: s => configIssues.push(fmt.invalidLabelSelectorEntry(JSON.stringify(s))),
        });
        if (invalidSelectorType) {
            labelSelectors = activeLabelSelectors({ labelSelectors: defaultLabelSelectors });
            configIssues.push(fmt.invalidLabelSelectorsType(labelSelectors.join(", ")));
        }
    }

    if (namePrefixes.length === 0 && labelSelectors.length === 0) {
        console.warn("app-health: no effective filter rules are active");
        configIssues.push(fmt.noActiveFilterRules());
    }

    return {
        namePrefixes,
        labelSelectors,
        configIssues,
        configWarning: configIssues.length > 0 ? configIssues.join("; ") : null,
    };
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
 * When `container.inspected` is true, `container.labels` from `docker inspect` is authoritative
 * for label matching; `container.labelFilterMatched` is only used as a fallback when inspect
 * metadata is unavailable (`!container.inspected`).
 */
export function containerMatchesFilter(container, filter) {
    const namePrefixes = activeNamePrefixes(filter);
    const labelSelectors = activeLabelSelectors(filter);
    const hasPrefixRule = namePrefixes.length > 0;
    const hasLabelRule = labelSelectors.length > 0;

    if (!hasPrefixRule && !hasLabelRule)
        return false;

    if (hasPrefixRule && nameMatches(container.name, namePrefixes))
        return true;
    if (hasLabelRule && labelsMatch(container.labels, labelSelectors))
        return true;
    if (!container.inspected && container.labelFilterMatched && hasLabelRule)
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
        inspected: false,
        labelFilterMatched: false,
        restartCount: null,
        cpu: null,
        memory: null,
    };
}

export function applyInspectMetadata(containers, inspected) {
    const rows = Array.isArray(inspected) ? inspected : (inspected?.rows || []);
    const byId = {};
    for (const info of rows) {
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
        c.inspected = true;
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
    const rows = Array.isArray(statsRows) ? statsRows : (statsRows?.rows || []);
    const byId = {};
    for (const s of rows) {
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
 * Inspect candidate container IDs in batches of `INSPECT_BATCH_SIZE` with bounded concurrency.
 * Only when a multi-ID batch fails with a "No such container/object" error (a container vanished
 * mid-refresh) does it retry each ID in that batch individually; timeouts or daemon errors fail
 * the batch immediately without amplifying requests.
 * Returns `{ rows, errors, vanishedIds }`.
 */
export async function dockerInspectAll(ids, spawn, options = {}) {
    const concurrency = options.concurrency || MAX_CONCURRENT_SPAWNS;
    const signal = options.signal;
    throwIfAborted(signal);
    const limitedSpawn = toLimitedSpawn(spawn, { concurrency, limiter: options.limiter, signal });

    const cleanIds = [...new Set((ids || []).filter(Boolean))];
    const batches = chunkArray(cleanIds, INSPECT_BATCH_SIZE);
    let batchFailedFast = false;
    const batchResults = await mapWithConcurrency(batches, concurrency, async batch => {
        throwIfAborted(signal);
        if (batchFailedFast)
            return { rows: [], errors: [], vanishedIds: [] };
        try {
            const inspectOut = await limitedSpawn([
                "inspect",
                "--format", "{{json .}}",
                ...batch,
            ]);
            return { rows: parseJsonLines(inspectOut), errors: [], vanishedIds: [] };
        } catch (err) {
            if (signal?.aborted || isAbortError(err))
                throw err;
            if (!isNoSuchContainerError(err)) {
                batchFailedFast = true;
                return { rows: [], errors: [err], vanishedIds: [] };
            }
            if (batch.length <= 1)
                return { rows: [], errors: [], vanishedIds: [...batch] };

            const rows = [];
            const errors = [];
            const vanishedIds = [];
            await mapWithConcurrency(batch, concurrency, async id => {
                throwIfAborted(signal);
                try {
                    const out = await limitedSpawn([
                        "inspect",
                        "--format", "{{json .}}",
                        id,
                    ]);
                    rows.push(...parseJsonLines(out));
                } catch (retryErr) {
                    if (signal?.aborted || isAbortError(retryErr))
                        throw retryErr;
                    if (isNoSuchContainerError(retryErr))
                        vanishedIds.push(id);
                    else
                        errors.push(retryErr);
                }
            }, { signal });
            return { rows, errors, vanishedIds };
        }
    }, { signal });

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
        throw new Error(summarizeErrors(errors));
    return { rows, errors, vanishedIds };
}

/**
 * Read one-shot `docker stats --no-stream` for `ids` in batches of `STATS_BATCH_SIZE`
 * with bounded concurrency.
 * Only when a multi-ID batch fails with a "No such container/object" error (one container was
 * removed during a rolling update) does it retry each ID in that batch individually; timeouts or
 * daemon errors fail the batch immediately without amplifying requests.
 * Returns `{ rows, errors, vanishedIds }`.
 */
export async function dockerStatsForIds(ids, spawn, options = {}) {
    const concurrency = options.concurrency || MAX_CONCURRENT_SPAWNS;
    const signal = options.signal;
    throwIfAborted(signal);
    const limitedSpawn = toLimitedSpawn(spawn, { concurrency, limiter: options.limiter, signal });

    const cleanIds = [...new Set((ids || []).filter(Boolean))];
    const batches = chunkArray(cleanIds, STATS_BATCH_SIZE);
    let batchFailedFast = false;
    const batchResults = await mapWithConcurrency(batches, concurrency, async batch => {
        throwIfAborted(signal);
        if (batchFailedFast)
            return { rows: [], errors: [], vanishedIds: [] };
        try {
            const statsOut = await limitedSpawn([
                "stats", "--no-stream", "--format", "{{json .}}",
                ...batch,
            ]);
            return { rows: parseJsonLines(statsOut), errors: [], vanishedIds: [] };
        } catch (err) {
            if (signal?.aborted || isAbortError(err))
                throw err;
            if (!isNoSuchContainerError(err)) {
                batchFailedFast = true;
                return { rows: [], errors: [err], vanishedIds: [] };
            }
            if (batch.length <= 1)
                return { rows: [], errors: [], vanishedIds: [...batch] };

            const rows = [];
            const errors = [];
            const vanishedIds = [];
            await mapWithConcurrency(batch, concurrency, async id => {
                throwIfAborted(signal);
                try {
                    const singleOut = await limitedSpawn([
                        "stats", "--no-stream", "--format", "{{json .}}",
                        id,
                    ]);
                    rows.push(...parseJsonLines(singleOut));
                } catch (retryErr) {
                    if (signal?.aborted || isAbortError(retryErr))
                        throw retryErr;
                    if (isNoSuchContainerError(retryErr))
                        vanishedIds.push(id);
                    else
                        errors.push(retryErr);
                }
            }, { signal });
            return { rows, errors, vanishedIds };
        }
    }, { signal });

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
        throw new Error(summarizeErrors(errors));
    return { rows, errors, vanishedIds };
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
 * `docker ps --filter` with bounded concurrency across unique selectors, name rules filter
 * the ps list in memory, union when both.
 */
export async function gatherCandidates(filter, spawn, options = {}) {
    const concurrency = options.concurrency || MAX_CONCURRENT_SPAWNS;
    const signal = options.signal;
    throwIfAborted(signal);
    const limitedSpawn = toLimitedSpawn(spawn, { concurrency, limiter: options.limiter, signal });

    const namePrefixes = activeNamePrefixes(filter);
    const labelSelectors = [...new Set(activeLabelSelectors(filter))];

    if (namePrefixes.length === 0 && labelSelectors.length === 0)
        return [];

    const tasks = labelSelectors.map(sel => () => fetchPsWithLabelSelector(sel, limitedSpawn));
    if (namePrefixes.length > 0) {
        tasks.push(() =>
            fetchAllPsContainers(limitedSpawn).then(all =>
                all.filter(c => nameMatches(c.name, namePrefixes))
            )
        );
    }

    const lists = await mapWithConcurrency(tasks, concurrency, task => task(), { signal });
    let candidates = [];
    for (const list of lists)
        candidates = mergeContainersById(candidates, list);

    return candidates;
}

export function defaultInspectWarning(msg) {
    return formatMsg(
        _("Could not inspect containers (restart counts and labels may be incomplete): $0"),
        msg
    );
}

export function defaultStatsWarning(msg) {
    return formatMsg(
        _("Could not read container stats (CPU/memory unavailable): $0"),
        msg
    );
}

/**
 * Load container list + restart counts + one-shot stats for filtered apps only.
 * `options` may be a `spawn(args)` function or
 * `{ spawn, concurrency, limiter, timeoutMs, signal, formatSpawnTimeout, formatInspectWarning, formatStatsWarning }`.
 */
export async function loadContainers(filter, options = {}) {
    const opts = typeof options === "function" ? { spawn: options } : (options || {});
    const rawSpawn = opts.spawn;
    const concurrency = opts.concurrency || MAX_CONCURRENT_SPAWNS;
    const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_SPAWN_TIMEOUT_MS : opts.timeoutMs;
    const signal = opts.signal;
    const formatInspectWarning = opts.formatInspectWarning || defaultInspectWarning;
    const formatStatsWarning = opts.formatStatsWarning || defaultStatsWarning;
    const formatSpawnTimeout = opts.formatSpawnTimeout || defaultSpawnTimeoutMessage;

    if (typeof rawSpawn !== "function")
        throw new Error("loadContainers requires a spawn function");

    throwIfAborted(signal);

    const timedSpawn = withSpawnTimeout(rawSpawn, timeoutMs, {
        signal,
        formatTimeoutError: formatSpawnTimeout,
    });
    const spawn = toLimitedSpawn(timedSpawn, {
        concurrency: opts.concurrency,
        limiter: opts.limiter,
        signal,
    });

    const normalizedFilter = {
        namePrefixes: activeNamePrefixes(filter),
        labelSelectors: activeLabelSelectors(filter),
    };

    let warning = null;
    const candidates = await gatherCandidates(normalizedFilter, spawn, { concurrency, signal });

    throwIfAborted(signal);

    if (candidates.length === 0)
        return { containers: [], warning: null };

    let vanishedIds = new Set();
    const inspectIds = candidates.map(c => c.id).filter(Boolean);
    if (inspectIds.length > 0) {
        try {
            const inspectResult = await dockerInspectAll(inspectIds, spawn, { concurrency, signal });
            applyInspectMetadata(candidates, inspectResult.rows);
            if (inspectResult.vanishedIds)
                vanishedIds = inspectResult.vanishedIds;
            if (inspectResult.errors?.length > 0) {
                warning = formatInspectWarning(summarizeErrors(inspectResult.errors));
            }
        } catch (e) {
            if (signal?.aborted || isAbortError(e))
                throw e;
            warning = formatInspectWarning(e?.message || String(e));
            console.warn("app-health: docker inspect failed", e);
        }
    }

    throwIfAborted(signal);

    const survivingCandidates = vanishedIds.size > 0
        ? candidates.filter(c => !vanishedIds.has(c.id) && !vanishedIds.has(normalizeContainerId(c.id)))
        : candidates;
    const filtered = survivingCandidates.filter(c => containerMatchesFilter(c, normalizedFilter));

    const runningIds = filtered.filter(isContainerRunning).map(c => c.id).filter(Boolean);
    if (runningIds.length > 0) {
        try {
            const statsResult = await dockerStatsForIds(runningIds, spawn, { concurrency, signal });
            const byId = statsByContainerId(statsResult.rows);
            for (const c of filtered) {
                const st = lookupStats(byId, c);
                if (st) {
                    c.cpu = st.cpu;
                    c.memory = st.memory;
                }
            }
            if (statsResult.errors?.length > 0) {
                const statsWarning = formatStatsWarning(summarizeErrors(statsResult.errors));
                warning = warning ? `${warning} ${statsWarning}` : statsWarning;
            }
        } catch (e) {
            if (signal?.aborted || isAbortError(e))
                throw e;
            const statsWarning = formatStatsWarning(e?.message || String(e));
            warning = warning ? `${warning} ${statsWarning}` : statsWarning;
            console.warn("app-health: docker stats failed", e);
        }
    }

    throwIfAborted(signal);

    filtered.sort((a, b) => a.name.localeCompare(b.name));
    return { containers: filtered, warning };
}

export function formatWarningTimestamp(now = new Date()) {
    if (typeof now === "string")
        return now;
    const d = now instanceof Date ? now : new Date(now);
    const yyyy = String(d.getFullYear()).padStart(4, "0");
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const offsetMinutes = -d.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absOffset = Math.abs(offsetMinutes);
    const tzHours = String(Math.floor(absOffset / 60)).padStart(2, "0");
    const tzMinutes = String(absOffset % 60).padStart(2, "0");
    return `${yyyy}-${mo}-${dd} ${hh}:${mm}:${ss} ${sign}${tzHours}:${tzMinutes}`;
}

export function formatWarningWithMeta(message, timestamp, consecutiveFailures = 0) {
    if (consecutiveFailures > 0)
        return formatMsg(_("[$0, consecutive failures: $1] $2"), timestamp, consecutiveFailures, message);
    return formatMsg(_("[$0] $1"), timestamp, message);
}

function runWithTimeout(fn, timeoutMs, { abortController, formatTimeoutError = defaultRefreshTimeoutMessage } = {}) {
    const signal = abortController?.signal;
    if (!timeoutMs || timeoutMs <= 0)
        return Promise.resolve().then(() => fn({ signal }));
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            const err = new Error(formatTimeoutError(timeoutMs));
            err.code = "REFRESH_TIMEOUT";
            err.timeoutMs = timeoutMs;
            try {
                abortController?.abort(createAbortError(err.message));
            } catch (e) {
                // ignore abort errors
            }
            reject(err);
        }, timeoutMs);

        Promise.resolve()
                .then(() => fn({ signal }))
                .then(
                    val => {
                        if (settled)
                            return;
                        settled = true;
                        clearTimeout(timer);
                        resolve(val);
                    },
                    err => {
                        if (settled)
                            return;
                        settled = true;
                        clearTimeout(timer);
                        reject(err);
                    }
                );
    });
}

/**
 * Coordinate manual and background refreshes so that:
 * - Background refreshes are skipped while the current refresh round is in flight,
 *   and do not flip `loading` to `true` (avoiding UI button flicker every 8s).
 * - Manual refreshes (`background: false`) always preempt any in-flight refresh via `generation`
 *   and abort its `AbortSignal` so superseded `docker` processes are terminated.
 * - Each refresh round is bounded by `timeoutMs` and aborts its `AbortSignal` on timeout so
 *   hung `docker` tasks do not keep queuing in the background across rounds.
 * - `consecutiveFailures` only counts failed refresh rounds (thrown errors), not partial warnings,
 *   and both manual `error` and background `warning` include timestamp + failure count.
 */
export function createRefreshController({
    load,
    onStateChange,
    now = () => new Date(),
    formatWarningMeta = formatWarningWithMeta,
    formatTimeoutError = defaultRefreshTimeoutMessage,
    timeoutMs = DEFAULT_REFRESH_TIMEOUT_MS,
}) {
    let activeRoundInFlight = false;
    let activeAbortController = null;
    let generation = 0;
    let consecutiveFailures = 0;
    let lastWarningAt = null;
    let state = {
        containers: null,
        error: null,
        warning: null,
        loading: true,
        consecutiveFailures: 0,
        lastWarningAt: null,
    };

    const emit = patch => {
        state = { ...state, ...patch, consecutiveFailures, lastWarningAt };
        if (onStateChange)
            onStateChange(state);
        return state;
    };

    async function refresh(options = {}) {
        const background = options.background === true;

        if (background && activeRoundInFlight)
            return false;

        if (activeAbortController) {
            try {
                activeAbortController.abort(createAbortError("Preempted by manual refresh"));
            } catch (e) {
                // ignore abort errors
            }
        }

        const abortController = typeof AbortController === "function" ? new AbortController() : null;
        activeAbortController = abortController;
        activeRoundInFlight = true;
        const gen = ++generation;

        if (!background)
            emit({ loading: true, error: null, warning: null });

        let completionPatch = {};
        try {
            const result = await runWithTimeout(
                ({ signal }) => load({ signal, background }),
                timeoutMs,
                { abortController, formatTimeoutError }
            );
            if (gen === generation) {
                consecutiveFailures = 0;
                if (result.warning) {
                    lastWarningAt = formatWarningTimestamp(now());
                    const formatted = formatWarningMeta(result.warning, lastWarningAt, 0);
                    completionPatch = {
                        containers: result.containers,
                        error: null,
                        warning: formatted,
                    };
                } else {
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
                const formatted = formatWarningMeta(message, lastWarningAt, consecutiveFailures);

                if (background) {
                    completionPatch = { warning: formatted };
                } else {
                    completionPatch = {
                        containers: [],
                        error: formatted,
                        warning: null,
                    };
                }
            }
        } finally {
            if (activeAbortController === abortController)
                activeAbortController = null;
            if (gen === generation) {
                activeRoundInFlight = false;
                emit({
                    ...completionPatch,
                    loading: false,
                });
            }
        }
        return true;
    }

    return {
        refresh,
        getState: () => state,
    };
}


