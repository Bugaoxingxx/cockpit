/*
 * Copyright (C) 2026 Chaoqian Li
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import {
    chunkArray,
    containerMatchesFilter,
    lookupStats,
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
    assert.notOk(containerMatchesFilter(c, {
        namePrefixes: ["other-"],
        labelSelectors: ["other=true"],
    }));
    assert.notOk(containerMatchesFilter(c, {
        namePrefixes: [],
        labelSelectors: [],
    }));
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

QUnit.test("normalizeContainerId", assert => {
    assert.strictEqual(normalizeContainerId("abcdef1234567890"), "abcdef123456");
});
