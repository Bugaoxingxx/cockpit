/*
 * Copyright (C) 2026 Chaoqian Li
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import {
    activeNamePrefixes,
    chunkArray,
    containerMatchesFilter,
    containersVisibleWithoutInspect,
    labelSelectorToDockerFilter,
    lookupStats,
    mergeContainersById,
    nameMatches,
    normalizeContainerId,
    normalizeName,
    parseJsonLines,
    statsByContainerId,
} from "./app-health-lib.js";
import QUnit from "qunit-tests";

QUnit.test("parseJsonLines", assert => {
    const rows = parseJsonLines('{"ID":"abc"}\n\n{"ID":"def"}\n');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].ID, "abc");
});

QUnit.test("normalizeName", assert => {
    assert.strictEqual(normalizeName("/myapp"), "myapp");
    assert.strictEqual(normalizeName("myapp"), "myapp");
});

QUnit.test("chunkArray", assert => {
    assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunkArray([1, 2], 10), [[1, 2]]);
    assert.deepEqual(chunkArray([], 50), []);
});

QUnit.test("empty name prefix does not match every container", assert => {
    assert.notOk(nameMatches("payroll-api", [""]));
    assert.notOk(nameMatches("payroll-api", ["", "   "]));
    assert.strictEqual(activeNamePrefixes({ namePrefixes: ["", "ok-"] }).length, 1);
    assert.notOk(containerMatchesFilter(
        { name: "payroll-api", labels: {} },
        { namePrefixes: [""], labelSelectors: [] }
    ));
});

QUnit.test("containerMatchesFilter", assert => {
    const c = { name: "payroll-api", labels: { "cockpit.app-health": "true" } };
    assert.ok(containerMatchesFilter(c, {
        namePrefixes: ["payroll-"],
        labelSelectors: [],
    }));
    assert.ok(containerMatchesFilter(c, {
        namePrefixes: [],
        labelSelectors: ["cockpit.app-health=true"],
    }));
    assert.ok(containerMatchesFilter(
        { name: "other", labels: {}, labelFilterMatched: true },
        { namePrefixes: ["payroll-"], labelSelectors: ["cockpit.app-health=true"] }
    ));
    assert.notOk(containerMatchesFilter(c, {
        namePrefixes: ["other-"],
        labelSelectors: ["other=true"],
    }));
    assert.notOk(containerMatchesFilter(c, {
        namePrefixes: [],
        labelSelectors: [],
    }));
});

QUnit.test("labelSelectorToDockerFilter", assert => {
    assert.strictEqual(labelSelectorToDockerFilter("cockpit.app-health=true"), "label=cockpit.app-health=true");
    assert.strictEqual(labelSelectorToDockerFilter("com.company.app"), "label=com.company.app");
});

QUnit.test("mergeContainersById keeps labelFilterMatched", assert => {
    const merged = mergeContainersById(
        [{ id: "abc", name: "a", labelFilterMatched: false }],
        [{ id: "abc", name: "a", labelFilterMatched: true }]
    );
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].labelFilterMatched, true);
});

QUnit.test("statsByContainerId name fallback key", assert => {
    const map = statsByContainerId([
        { Name: "/fallback-only", CPUPerc: "3.00%" },
    ]);
    assert.strictEqual(map["name:fallback-only"].cpu, "3.00%");
    assert.strictEqual(
        lookupStats(map, { id: "", name: "fallback-only" }).cpu,
        "3.00%"
    );
});

QUnit.test("statsByContainerId prefers ID over name", assert => {
    const map = statsByContainerId([
        { ID: "abc123456789", Name: "/shared", CPUPerc: "1.00%" },
        { ID: "def987654321", Name: "/shared", CPUPerc: "2.00%" },
    ]);
    assert.strictEqual(map.abc123456789.cpu, "1.00%");
    assert.strictEqual(map.def987654321.cpu, "2.00%");
    assert.strictEqual(
        lookupStats(map, { id: "def987654321", name: "shared" }).cpu,
        "2.00%"
    );
});

QUnit.test("containersVisibleWithoutInspect", assert => {
    const candidates = [
        { id: "1", name: "app-one", labelFilterMatched: false },
        { id: "2", name: "other", labelFilterMatched: true },
    ];
    const visible = containersVisibleWithoutInspect(candidates, {
        namePrefixes: ["app-"],
        labelSelectors: ["cockpit.app-health=true"],
    });
    assert.deepEqual(visible.map(c => c.id), ["1", "2"]);
});

QUnit.test("normalizeContainerId", assert => {
    assert.strictEqual(normalizeContainerId("abcdef1234567890"), "abcdef123456");
});
