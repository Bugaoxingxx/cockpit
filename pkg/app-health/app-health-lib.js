/*
 * Copyright (C) 2026 Chaoqian Li
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

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

export function activeNamePrefixes(filter) {
    return (filter?.namePrefixes || []).filter(p => typeof p === "string" && p.trim().length > 0);
}

export function activeLabelSelectors(filter) {
    return (filter?.labelSelectors || []).filter(s => typeof s === "string" && s.trim().length > 0);
}

export function filterNeedsLabels(filter) {
    return activeLabelSelectors(filter).length > 0;
}

export function parseLabelSelector(selector) {
    const eq = selector.indexOf("=");
    if (eq === -1)
        return { key: selector, value: null };
    return { key: selector.slice(0, eq), value: selector.slice(eq + 1) };
}

/** Map manifest label selector to `docker ps --filter` value. */
export function labelSelectorToDockerFilter(selector) {
    const { key, value } = parseLabelSelector(selector);
    if (!key)
        return null;
    if (value === null || value === "")
        return `label=${key}`;
    return `label=${key}=${value}`;
}

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

export function nameMatches(name, prefixes) {
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

/**
 * When inspect fails, still include containers that matched via ps name or label filter.
 */
export function containersVisibleWithoutInspect(candidates, filter) {
    const namePrefixes = activeNamePrefixes(filter);
    return candidates.filter(c =>
        c.labelFilterMatched || nameMatches(c.name, namePrefixes)
    );
}

export const DEFAULT_LABEL_SELECTORS = ["cockpit.app-health=true"];
export const INSPECT_BATCH_SIZE = 50;
export const STATS_BATCH_SIZE = 50;
export const LIST_REFRESH_MS = 8000;
