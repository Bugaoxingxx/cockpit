/*
 * Copyright (C) 2026 Chaoqian Li
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import {
    activeLabelSelectors,
    activeNamePrefixes,
    chunkArray,
    containerMatchesFilter,
    createRefreshController,
    dockerInspectAll,
    dockerStatsForIds,
    gatherCandidates,
    isNoSuchContainerError,
    labelsMatch,
    labelSelectorToDockerFilter,
    loadContainers,
    lookupStats,
    mergeContainersById,
    nameMatches,
    normalizeContainerId,
    normalizeName,
    parseJsonLines,
    statsByContainerId,
} from "./app-health-lib.js";
import QUnit from "qunit-tests";

function withCapturedWarnings(fn) {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    let isAsync = false;
    try {
        const out = fn();
        if (out && typeof out.then === "function") {
            isAsync = true;
            return {
                result: out.finally(() => {
                    console.warn = origWarn;
                }),
                warnings,
            };
        }
        return { result: out, warnings };
    } finally {
        if (!isAsync)
            console.warn = origWarn;
    }
}

QUnit.test("parseJsonLines", assert => {
    const rows = parseJsonLines('{"ID":"abc"}\n\n{"ID":"def"}\n');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].ID, "abc");
});

QUnit.test("normalizeName and normalizeContainerId", assert => {
    assert.strictEqual(normalizeName("/myapp"), "myapp");
    assert.strictEqual(normalizeName("myapp"), "myapp");
    assert.strictEqual(normalizeContainerId("abcdef1234567890"), "abcdef123456");
});

QUnit.test("chunkArray", assert => {
    assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunkArray([1, 2], 10), [[1, 2]]);
    assert.deepEqual(chunkArray([], 50), []);
});

QUnit.test("nameMatches and activeNamePrefixes trim and warn on invalid entries", assert => {
    const { result, warnings } = withCapturedWarnings(() =>
        activeNamePrefixes({ namePrefixes: ["  payroll-  ", "", "   ", 42] })
    );
    assert.deepEqual(result, ["payroll-"]);
    assert.strictEqual(warnings.length, 3);

    assert.notOk(nameMatches("payroll-api", []));
    assert.notOk(nameMatches("payroll-api", null));
    assert.notOk(nameMatches("payroll-api", undefined));
    withCapturedWarnings(() => {
        assert.notOk(nameMatches("payroll-api", ["", "   "]));
        assert.ok(nameMatches("payroll-api", ["  payroll-  "]));
    });
});

QUnit.test("labelsMatch and activeLabelSelectors trim, validate, and handle empty lists", assert => {
    assert.notOk(labelsMatch({ "cockpit.app-health": "true" }, []));
    assert.notOk(labelsMatch({ "cockpit.app-health": "true" }, null));
    assert.notOk(labelsMatch({ "cockpit.app-health": "true" }, undefined));

    const { result, warnings } = withCapturedWarnings(() =>
        activeLabelSelectors({
            labelSelectors: [
                "  cockpit.app-health = true  ",
                "  com.company.app  ",
                "",
                "   ",
                "=missing-key",
                "bad key=true",
                123,
            ],
        })
    );
    assert.deepEqual(result, ["cockpit.app-health=true", "com.company.app"]);
    assert.strictEqual(warnings.length, 5);

    assert.ok(labelsMatch(
        { "cockpit.app-health": "true" },
        ["  cockpit.app-health = true  "]
    ));
    assert.ok(labelsMatch(
        { "com.company.app": "anything" },
        ["  com.company.app  "]
    ));
    assert.ok(labelsMatch(
        { "com.company.app": "anything" },
        ["  com.company.app =  "]
    ));
    assert.notOk(labelsMatch(
        { "cockpit.app-health": "false" },
        ["cockpit.app-health=true"]
    ));
    assert.notOk(labelsMatch(null, ["cockpit.app-health=true"]));
});

QUnit.test("containerMatchesFilter", assert => {
    const c = { name: "payroll-api", labels: { "cockpit.app-health": "true" } };
    assert.ok(containerMatchesFilter(c, {
        namePrefixes: ["  payroll-  "],
        labelSelectors: [],
    }));
    assert.ok(containerMatchesFilter(c, {
        namePrefixes: [],
        labelSelectors: ["  cockpit.app-health = true  "],
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

QUnit.test("labelSelectorToDockerFilter trims and rejects invalid selectors", assert => {
    assert.strictEqual(
        labelSelectorToDockerFilter("  cockpit.app-health = true  "),
        "label=cockpit.app-health=true"
    );
    assert.strictEqual(
        labelSelectorToDockerFilter("  com.company.app  "),
        "label=com.company.app"
    );
    withCapturedWarnings(() => {
        assert.strictEqual(labelSelectorToDockerFilter("=bad"), null);
        assert.strictEqual(labelSelectorToDockerFilter("bad key=1"), null);
        assert.strictEqual(labelSelectorToDockerFilter("   "), null);
    });
});

QUnit.test("mergeContainersById keeps labelFilterMatched", assert => {
    const merged = mergeContainersById(
        [{ id: "abc", name: "a", labelFilterMatched: false }],
        [{ id: "abc", name: "a", labelFilterMatched: true }]
    );
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].labelFilterMatched, true);
});

QUnit.test("statsByContainerId name fallback and ID preference", assert => {
    const fallbackMap = statsByContainerId([
        { Name: "/fallback-only", CPUPerc: "3.00%" },
    ]);
    assert.strictEqual(fallbackMap["name:fallback-only"].cpu, "3.00%");
    assert.strictEqual(
        lookupStats(fallbackMap, { id: "", name: "fallback-only" }).cpu,
        "3.00%"
    );

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

QUnit.test("gatherCandidates runs multiple selectors concurrently and deduplicates", async assert => {
    let activeCalls = 0;
    let maxConcurrent = 0;
    const calls = [];

    const spawn = async args => {
        calls.push(args);
        activeCalls += 1;
        maxConcurrent = Math.max(maxConcurrent, activeCalls);
        await new Promise(resolve => setTimeout(resolve, 10));
        activeCalls -= 1;
        if (args.includes("label=a=1"))
            return '{"ID":"id1","Names":"c1","Status":"Up"}\n';
        if (args.includes("label=b=2"))
            return '{"ID":"id2","Names":"c2","Status":"Up"}\n';
        return '{"ID":"id3","Names":"app-3","Status":"Up"}\n';
    };

    const candidates = await gatherCandidates({
        namePrefixes: [" app- "],
        labelSelectors: [" a=1 ", "b=2", "a=1"],
    }, spawn);

    assert.strictEqual(calls.length, 3, "deduplicated duplicate selector a=1");
    assert.ok(maxConcurrent >= 2, "spawn calls ran concurrently");
    assert.deepEqual(candidates.map(c => c.id), ["id1", "id2", "id3"]);
});

QUnit.test("dockerStatsForIds retries per ID when batch fails and ignores vanished containers", async assert => {
    const spawn = async args => {
        const ids = args.slice(4);
        if (ids.length > 1)
            throw new Error("Error response from daemon: No such container: id2");
        if (ids[0] === "id1")
            return '{"ID":"id1","Name":"/app1","CPUPerc":"12.5%","MemUsage":"50MiB / 1GiB"}\n';
        if (ids[0] === "id2")
            throw new Error("Error response from daemon: No such container: id2");
        throw new Error("unexpected id");
    };

    const rows = await dockerStatsForIds(["id1", "id2"], spawn);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].ID, "id1");
    assert.strictEqual(rows.errors.length, 0, "vanished container does not record warning error");
});

QUnit.test("dockerStatsForIds runs >100 container batches concurrently", async assert => {
    const ids = Array.from({ length: 120 }, (_, i) => `cid${String(i).padStart(9, "0")}`);
    let inFlight = 0;
    let maxInFlight = 0;

    const spawn = async args => {
        const batch = args.slice(4);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 10));
        inFlight -= 1;
        return batch.map(id => JSON.stringify({ ID: id, CPUPerc: "1.0%", MemUsage: "10MiB" })).join("\n");
    };

    const rows = await dockerStatsForIds(ids, spawn);
    assert.strictEqual(rows.length, 120);
    assert.strictEqual(maxInFlight, 3, "all 3 batches of 50 ran concurrently");
});

QUnit.test("loadContainers keeps surviving stats on partial batch failure and handles inspect failure", async assert => {
    const filter = { namePrefixes: [], labelSelectors: ["cockpit.app-health=true"] };

    const spawnPartialStats = async args => {
        if (args[0] === "ps") {
            return [
                JSON.stringify({ ID: "aaa111222333", Names: "web-1", Status: "Up 2 hours" }),
                JSON.stringify({ ID: "bbb444555666", Names: "web-2", Status: "Up 2 hours" }),
            ].join("\n");
        }
        if (args[0] === "inspect") {
            return [
                JSON.stringify({ Id: "aaa111222333", Name: "/web-1", RestartCount: 2, Config: { Labels: { "cockpit.app-health": "true" } }, State: { Status: "running" } }),
                JSON.stringify({ Id: "bbb444555666", Name: "/web-2", RestartCount: 0, Config: { Labels: { "cockpit.app-health": "true" } }, State: { Status: "running" } }),
            ].join("\n");
        }
        if (args[0] === "stats") {
            const ids = args.slice(4);
            if (ids.length > 1)
                throw new Error("batch stats failed");
            if (ids[0] === "aaa111222333")
                return JSON.stringify({ ID: "aaa111222333", Name: "/web-1", CPUPerc: "5.5%", MemUsage: "32MiB / 1GiB" });
            throw new Error("stats daemon timeout for bbb444555666");
        }
        throw new Error("unexpected command");
    };

    const res1 = await loadContainers(filter, spawnPartialStats);
    assert.strictEqual(res1.containers.length, 2);
    assert.strictEqual(res1.containers[0].name, "web-1");
    assert.strictEqual(res1.containers[0].cpu, "5.5%");
    assert.strictEqual(res1.containers[0].restartCount, 2);
    assert.strictEqual(res1.containers[1].name, "web-2");
    assert.strictEqual(res1.containers[1].cpu, null);
    assert.ok(res1.warning.includes("stats daemon timeout"), "surfaces non-vanished stats error while preserving web-1 stats");

    const spawnInspectFail = async args => {
        if (args[0] === "ps")
            return JSON.stringify({ ID: "aaa111222333", Names: "web-1", Status: "Up 2 hours" });
        if (args[0] === "inspect")
            throw new Error("inspect permission denied");
        if (args[0] === "stats")
            return JSON.stringify({ ID: "aaa111222333", Name: "/web-1", CPUPerc: "4.0%", MemUsage: "20MiB / 1GiB" });
        throw new Error("unexpected command");
    };

    const res2 = await withCapturedWarnings(() => loadContainers(filter, spawnInspectFail)).result;
    assert.strictEqual(res2.containers.length, 1, "candidates matched by ps filter remain visible when inspect fails");
    assert.strictEqual(res2.containers[0].cpu, "4.0%");
    assert.ok(res2.warning.includes("inspect permission denied"));
});

QUnit.test("createRefreshController enforces single in-flight round and tracks warning timestamp + consecutive failures", async assert => {
    let loadCalls = 0;
    let resolveFirst;
    const firstGate = new Promise(resolve => { resolveFirst = resolve });
    let mode = "slow-first";
    let fakeClock = new Date(2026, 9, 15, 10, 5, 8);

    const controller = createRefreshController({
        now: () => fakeClock,
        load: async () => {
            loadCalls += 1;
            if (mode === "slow-first") {
                await firstGate;
                return { containers: [{ id: "1", name: "app-1" }], warning: null };
            }
            if (mode === "bg-fail-1")
                throw new Error("daemon temporary error");
            if (mode === "bg-fail-2")
                return { containers: [{ id: "1", name: "app-1" }], warning: "partial stats failure" };
            return { containers: [{ id: "1", name: "app-1" }], warning: null };
        },
    });

    // Start background refresh #1 (stays in flight)
    const p1 = controller.refresh({ background: true });
    assert.strictEqual(controller.getState().inFlightCount, 1);

    // Manual refresh while background refresh #1 is in flight must NOT start a second round
    const startedManual = await controller.refresh({ background: false });
    assert.strictEqual(startedManual, false, "manual refresh skipped while round is in flight");
    assert.strictEqual(loadCalls, 1, "only one load call executed");
    assert.strictEqual(controller.getState().inFlightCount, 1, "inFlightCount remains 1");

    // Another background tick while #1 is still in flight is also skipped
    const startedBg = await controller.refresh({ background: true });
    assert.strictEqual(startedBg, false);
    assert.strictEqual(loadCalls, 1);

    // Finish refresh #1
    resolveFirst();
    await p1;
    assert.strictEqual(controller.getState().inFlightCount, 0);
    assert.strictEqual(controller.getState().containers.length, 1);
    assert.strictEqual(controller.getState().consecutiveFailures, 0);

    // Consecutive background failures include timestamp and incrementing count
    mode = "bg-fail-1";
    fakeClock = new Date(2026, 9, 15, 10, 5, 16);
    await controller.refresh({ background: true });
    assert.strictEqual(controller.getState().consecutiveFailures, 1);
    assert.strictEqual(controller.getState().lastWarningAt, "10:05:16");
    assert.strictEqual(
        controller.getState().warning,
        "[10:05:16, consecutive failures: 1] daemon temporary error"
    );
    assert.strictEqual(controller.getState().containers.length, 1, "preserves previous container list on background failure");

    mode = "bg-fail-2";
    fakeClock = new Date(2026, 9, 15, 10, 5, 24);
    await controller.refresh({ background: true });
    assert.strictEqual(controller.getState().consecutiveFailures, 2);
    assert.strictEqual(controller.getState().lastWarningAt, "10:05:24");
    assert.strictEqual(
        controller.getState().warning,
        "[10:05:24, consecutive failures: 2] partial stats failure"
    );

    // Subsequent clean refresh resets warning and consecutiveFailures
    mode = "ok";
    await controller.refresh({ background: true });
    assert.strictEqual(controller.getState().consecutiveFailures, 0);
    assert.strictEqual(controller.getState().lastWarningAt, null);
    assert.strictEqual(controller.getState().warning, null);
});

QUnit.test("dockerInspectAll and loadContainers ignore containers vanishing with No such object before inspect", async assert => {
    assert.ok(isNoSuchContainerError(new Error("Error: No such object: dead123")));
    assert.ok(isNoSuchContainerError(new Error("Error response from daemon: No such container: dead123")));

    const statsCalls = [];
    const spawn = async args => {
        if (args[0] === "ps") {
            return [
                JSON.stringify({ ID: "aaa111222333", Names: "web-1", Status: "Up 2 hours" }),
                JSON.stringify({ ID: "dead44455566", Names: "web-vanished", Status: "Up 1 minute" }),
            ].join("\n");
        }
        if (args[0] === "inspect") {
            const ids = args.slice(3);
            if (ids.length > 1)
                throw new Error("Error: No such object: dead44455566");
            if (ids[0] === "aaa111222333")
                return JSON.stringify({ Id: "aaa111222333", Name: "/web-1", RestartCount: 1, Config: { Labels: { "cockpit.app-health": "true" } }, State: { Status: "running" } });
            throw new Error("Error: No such object: dead44455566");
        }
        if (args[0] === "stats") {
            statsCalls.push(args.slice(4));
            return JSON.stringify({ ID: "aaa111222333", Name: "/web-1", CPUPerc: "2.5%", MemUsage: "16MiB / 1GiB" });
        }
        throw new Error("unexpected command");
    };

    const inspected = await dockerInspectAll(["aaa111222333", "dead44455566"], spawn);
    assert.strictEqual(inspected.length, 1);
    assert.strictEqual(inspected.errors.length, 0);
    assert.ok(inspected.vanishedIds.has("dead44455566"));

    const res = await loadContainers(
        { namePrefixes: [], labelSelectors: ["cockpit.app-health=true"] },
        spawn
    );
    assert.strictEqual(res.warning, null, "no warning flashed when container vanishes with No such object");
    assert.strictEqual(res.containers.length, 1, "vanished container is excluded from result");
    assert.strictEqual(res.containers[0].name, "web-1");
    assert.deepEqual(statsCalls, [["aaa111222333"]], "docker stats is not called for container that already vanished during inspect");
});

QUnit.test("loadContainers validates filter once per call and createRefreshController emits once on completion", async assert => {
    const spawn = async args => {
        if (args[0] === "ps") {
            return [
                JSON.stringify({ ID: "id1", Names: "app-1", Status: "Up" }),
                JSON.stringify({ ID: "id2", Names: "app-2", Status: "Up" }),
                JSON.stringify({ ID: "id3", Names: "app-3", Status: "Up" }),
            ].join("\n");
        }
        if (args[0] === "inspect") {
            return [
                JSON.stringify({ Id: "id1", Name: "/app-1", RestartCount: 0, Config: { Labels: {} }, State: { Status: "running" } }),
                JSON.stringify({ Id: "id2", Name: "/app-2", RestartCount: 0, Config: { Labels: {} }, State: { Status: "running" } }),
                JSON.stringify({ Id: "id3", Name: "/app-3", RestartCount: 0, Config: { Labels: {} }, State: { Status: "running" } }),
            ].join("\n");
        }
        if (args[0] === "stats")
            return "";
        throw new Error("unexpected");
    };

    const captured = withCapturedWarnings(() =>
        loadContainers({
            namePrefixes: ["app-", ""],
            labelSelectors: ["=invalid"],
        }, spawn)
    );
    const res = await captured.result;
    assert.strictEqual(res.containers.length, 3);
    assert.strictEqual(captured.warnings.length, 2, "warns once per invalid filter entry rather than once per candidate");

    const emittedStates = [];
    const controller = createRefreshController({
        load: async () => ({ containers: [{ id: "1", name: "app-1" }], warning: null }),
        onStateChange: s => emittedStates.push(s),
    });
    await controller.refresh({ background: false });
    assert.strictEqual(emittedStates.length, 2, "emits once on start and once on completion");
    assert.strictEqual(emittedStates[0].inFlightCount, 1);
    assert.strictEqual(emittedStates[0].loading, true);
    assert.strictEqual(emittedStates[1].inFlightCount, 0);
    assert.strictEqual(emittedStates[1].loading, false);
    assert.strictEqual(emittedStates[1].containers.length, 1);
});

