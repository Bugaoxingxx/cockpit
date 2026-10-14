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
    const chunks = [];
    for (let i = 0; i < items.length; i += size)
        chunks.push(items.slice(i, i + size));
    return chunks;
}

export function parseLabelSelector(selector) {
    const eq = selector.indexOf("=");
    if (eq === -1)
        return { key: selector, value: null };
    return { key: selector.slice(0, eq), value: selector.slice(eq + 1) };
}

export function labelsMatch(containerLabels, selectors) {
    if (!selectors?.length)
        return true;
    const labels = containerLabels || {};
    for (const sel of selectors) {
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
    if (!prefixes?.length)
        return true;
    return prefixes.some(prefix => name.startsWith(prefix));
}

/**
 * Decide whether a container belongs in the company app list.
 * When both prefix and label rules are configured, either match is enough.
 * When neither is configured, nothing is listed (configure manifest config).
 */
export function containerMatchesFilter(container, filter) {
    const namePrefixes = filter?.namePrefixes || [];
    const labelSelectors = filter?.labelSelectors || [];
    const hasPrefixRule = namePrefixes.length > 0;
    const hasLabelRule = labelSelectors.length > 0;

    if (!hasPrefixRule && !hasLabelRule)
        return false;

    if (hasPrefixRule && nameMatches(container.name, namePrefixes))
        return true;
    if (hasLabelRule && labelsMatch(container.labels, labelSelectors))
        return true;
    return false;
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
        if (name && !byId[name])
            byId["name:" + name] = entry;
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

export const DEFAULT_LABEL_SELECTORS = ["cockpit.app-health=true"];
export const INSPECT_BATCH_SIZE = 50;
export const LIST_REFRESH_MS = 8000;
