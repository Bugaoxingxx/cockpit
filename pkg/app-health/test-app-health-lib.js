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
    DEFAULT_LABEL_SELECTORS,
    dockerInspectAll,
    dockerStatsForIds,
    formatWarningTimestamp,
    gatherCandidates,
    isNoSuchContainerError,
    labelsMatch,
    labelSelectorToDockerFilter,
    loadContainers,
    lookupStats,
    MAX_CONCURRENT_SPAWNS,
    mergeContainersById,
    nameMatches,
    normalizeContainerId,
    normalizeName,
    parseJsonLines,
    resolveFilterConfig,
    statsByContainerId,
    summarizeErrors,
    withSpawnTimeout,
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

QUnit.test("resolveFilterConfig falls back to default when label-selectors is non-array and surfaces configWarning", assert => {
    const clean = resolveFilterConfig({});
    assert.deepEqual(clean.namePrefixes, []);
    assert.deepEqual(clean.labelSelectors, DEFAULT_LABEL_SELECTORS);
    assert.strictEqual(clean.configWarning, null);

    const { result: badType } = withCapturedWarnings(() =>
        resolveFilterConfig({
            "name-prefixes": "not-an-array",
            "label-selectors": "cockpit.app-health=true",
        })
    );
    assert.deepEqual(badType.namePrefixes, []);
    assert.deepEqual(badType.labelSelectors, DEFAULT_LABEL_SELECTORS, "non-array label-selectors falls back to default");
    assert.strictEqual(badType.configIssues.length, 2);
    assert.ok(badType.configWarning.includes("name-prefixes must be an array"));
    assert.ok(badType.configWarning.includes("label-selectors must be an array"));

    const { result: badEntries } = withCapturedWarnings(() =>
        resolveFilterConfig({
            "name-prefixes": ["app-", ""],
            "label-selectors": ["cockpit.app-health=true", "=bad"],
        })
    );
    assert.deepEqual(badEntries.namePrefixes, ["app-"]);
    assert.deepEqual(badEntries.labelSelectors, ["cockpit.app-health=true"]);
    assert.strictEqual(badEntries.configIssues.length, 2);
    assert.ok(badEntries.configWarning.includes("name-prefixes"));
    assert.ok(badEntries.configWarning.includes("label-selectors"));

    const { result: localized } = withCapturedWarnings(() =>
        resolveFilterConfig(
            { "name-prefixes": 123, "label-selectors": "bad" },
            DEFAULT_LABEL_SELECTORS,
            {
                invalidNamePrefixesType: () => "自定义前缀类型错误",
                invalidLabelSelectorsType: fb => `自定义标签回退(${fb})`,
            }
        )
    );
    assert.strictEqual(
        localized.configWarning,
        "自定义前缀类型错误; 自定义标签回退(cockpit.app-health=true)"
    );

    const { result: emptyRules } = withCapturedWarnings(() =>
        resolveFilterConfig({
            "name-prefixes": [],
            "label-selectors": [],
        })
    );
    assert.deepEqual(emptyRules.namePrefixes, []);
    assert.deepEqual(emptyRules.labelSelectors, []);
    assert.strictEqual(emptyRules.configIssues.length, 1);
    assert.ok(emptyRules.configWarning.includes("no effective filter rules are active"));

    const { result: allInvalidRules } = withCapturedWarnings(() =>
        resolveFilterConfig({
            "name-prefixes": ["   "],
            "label-selectors": ["=invalid"],
        })
    );
    assert.deepEqual(allInvalidRules.namePrefixes, []);
    assert.deepEqual(allInvalidRules.labelSelectors, []);
    assert.strictEqual(allInvalidRules.configIssues.length, 3);
    assert.ok(allInvalidRules.configWarning.includes("no effective filter rules are active"));

    const { result: localizedEmpty } = withCapturedWarnings(() =>
        resolveFilterConfig(
            { "name-prefixes": [], "label-selectors": [] },
            DEFAULT_LABEL_SELECTORS,
            { noActiveFilterRules: () => "当前没有生效的过滤规则" }
        )
    );
    assert.strictEqual(localizedEmpty.configWarning, "当前没有生效的过滤规则");
});

QUnit.test("containerMatchesFilter uses authoritative inspect labels when inspected is true", assert => {
    const c = { name: "payroll-api", labels: { "cockpit.app-health": "true" }, inspected: true };
    assert.ok(containerMatchesFilter(c, {
        namePrefixes: ["  payroll-  "],
        labelSelectors: [],
    }));
    assert.ok(containerMatchesFilter(c, {
        namePrefixes: [],
        labelSelectors: ["  cockpit.app-health = true  "],
    }));
    assert.ok(containerMatchesFilter(
        { name: "other", labels: {}, inspected: false, labelFilterMatched: true },
        { namePrefixes: ["payroll-"], labelSelectors: ["cockpit.app-health=true"] }
    ), "falls back to labelFilterMatched when inspect metadata is unavailable");
    assert.notOk(containerMatchesFilter(
        { name: "other", labels: { "cockpit.app-health": "false" }, inspected: true, labelFilterMatched: true },
        { namePrefixes: ["payroll-"], labelSelectors: ["cockpit.app-health=true"] }
    ), "excludes container when inspect succeeds and shows label no longer matches");
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

QUnit.test("gatherCandidates caps concurrency at MAX_CONCURRENT_SPAWNS and deduplicates selectors", async assert => {
    let activeCalls = 0;
    let maxConcurrent = 0;
    const calls = [];

    const spawn = async args => {
        calls.push(args);
        activeCalls += 1;
        maxConcurrent = Math.max(maxConcurrent, activeCalls);
        await new Promise(resolve => setTimeout(resolve, 10));
        activeCalls -= 1;
        const filterArg = args.find(a => a.startsWith("label="));
        if (filterArg) {
            const idx = filterArg.split("=")[1];
            return JSON.stringify({ ID: `id-${idx}`, Names: `c-${idx}`, Status: "Up" }) + "\n";
        }
        return '{"ID":"id-name","Names":"app-1","Status":"Up"}\n';
    };

    const candidates = await gatherCandidates({
        namePrefixes: [" app- "],
        labelSelectors: [" a=1 ", "b=2", "a=1", "c=3", "d=4", "e=5", "f=6"],
    }, spawn);

    assert.strictEqual(calls.length, 7, "6 unique label selectors + 1 ps for name prefix");
    assert.ok(maxConcurrent > 1, "spawn calls ran concurrently");
    assert.ok(maxConcurrent <= MAX_CONCURRENT_SPAWNS, `concurrency (${maxConcurrent}) capped at ${MAX_CONCURRENT_SPAWNS}`);
    assert.strictEqual(candidates.length, 7);
});

QUnit.test("dockerStatsForIds returns structured object, retries per ID with bounded concurrency, and ignores vanished containers", async assert => {
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

    const result = await dockerStatsForIds(["id1", "id2"], spawn);
    assert.notOk(Array.isArray(result), "returns plain object rather than array with expando properties");
    assert.strictEqual(result.rows.length, 1);
    assert.strictEqual(result.rows[0].ID, "id1");
    assert.strictEqual(result.errors.length, 0, "vanished container does not record warning error");
    assert.ok(result.vanishedIds.has("id2"));
});

QUnit.test("dockerStatsForIds and dockerInspectAll cap concurrency across batches and per-ID retries", async assert => {
    // 500 containers = 10 batches of 50
    const ids = Array.from({ length: 500 }, (_, i) => `cid${String(i).padStart(9, "0")}`);
    let inFlight = 0;
    let maxInFlight = 0;

    const spawn = async args => {
        const batch = args.slice(4);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight -= 1;
        return batch.map(id => JSON.stringify({ ID: id, CPUPerc: "1.0%", MemUsage: "10MiB" })).join("\n");
    };

    const statsRes = await dockerStatsForIds(ids, spawn);
    assert.strictEqual(statsRes.rows.length, 500);
    assert.strictEqual(maxInFlight, MAX_CONCURRENT_SPAWNS, `10 batches capped at MAX_CONCURRENT_SPAWNS (${MAX_CONCURRENT_SPAWNS})`);

    // Now test per-ID retry concurrency when multiple batches (120 IDs = 3 batches) fail simultaneously
    const retryIds = Array.from({ length: 120 }, (_, i) => `rid${String(i).padStart(9, "0")}`);
    let retryInFlight = 0;
    let maxRetryInFlight = 0;
    const spawnRetry = async args => {
        const batch = args.slice(3);
        retryInFlight += 1;
        maxRetryInFlight = Math.max(maxRetryInFlight, retryInFlight);
        await new Promise(resolve => setTimeout(resolve, 2));
        retryInFlight -= 1;
        if (batch.length > 1)
            throw new Error(`Error: No such object: ${batch[batch.length - 1]}`);
        if (batch[0] === "rid000000049" || batch[0] === "rid000000099" || batch[0] === "rid000000119")
            throw new Error(`Error: No such object: ${batch[0]}`);
        return JSON.stringify({ Id: batch[0], Name: `/${batch[0]}`, RestartCount: 0, Config: { Labels: {} }, State: { Status: "running" } });
    };

    const inspectRes = await dockerInspectAll(retryIds, spawnRetry);
    assert.strictEqual(inspectRes.rows.length, 117);
    assert.ok(inspectRes.vanishedIds.has("rid000000049"));
    assert.ok(inspectRes.vanishedIds.has("rid000000099"));
    assert.ok(inspectRes.vanishedIds.has("rid000000119"));
    assert.strictEqual(maxRetryInFlight, MAX_CONCURRENT_SPAWNS, `multi-batch per-ID retry concurrency capped at MAX_CONCURRENT_SPAWNS (${MAX_CONCURRENT_SPAWNS})`);
});

QUnit.test("loadContainers aggregates multiple errors and preserves surviving stats", async assert => {
    assert.strictEqual(
        summarizeErrors([new Error("err A"), new Error("err B"), new Error("err A")]),
        "err A; err B"
    );

    const filter = { namePrefixes: [], labelSelectors: ["cockpit.app-health=true"] };

    const spawnPartialStats = async args => {
        if (args[0] === "ps") {
            return [
                JSON.stringify({ ID: "aaa111222333", Names: "web-1", Status: "Up 2 hours" }),
                JSON.stringify({ ID: "bbb444555666", Names: "web-2", Status: "Up 2 hours" }),
                JSON.stringify({ ID: "ccc777888999", Names: "web-3", Status: "Up 2 hours" }),
            ].join("\n");
        }
        if (args[0] === "inspect") {
            return [
                JSON.stringify({ Id: "aaa111222333", Name: "/web-1", RestartCount: 2, Config: { Labels: { "cockpit.app-health": "true" } }, State: { Status: "running" } }),
                JSON.stringify({ Id: "bbb444555666", Name: "/web-2", RestartCount: 0, Config: { Labels: { "cockpit.app-health": "true" } }, State: { Status: "running" } }),
                JSON.stringify({ Id: "ccc777888999", Name: "/web-3", RestartCount: 1, Config: { Labels: { "cockpit.app-health": "true" } }, State: { Status: "running" } }),
            ].join("\n");
        }
        if (args[0] === "stats") {
            const ids = args.slice(4);
            if (ids.length > 1)
                throw new Error("batch stats failed");
            if (ids[0] === "aaa111222333")
                return JSON.stringify({ ID: "aaa111222333", Name: "/web-1", CPUPerc: "5.5%", MemUsage: "32MiB / 1GiB" });
            if (ids[0] === "bbb444555666")
                throw new Error("stats daemon timeout for bbb444555666");
            throw new Error("cgroup read error for ccc777888999");
        }
        throw new Error("unexpected command");
    };

    const res1 = await loadContainers(filter, spawnPartialStats);
    assert.strictEqual(res1.containers.length, 3);
    assert.strictEqual(res1.containers[0].name, "web-1");
    assert.strictEqual(res1.containers[0].cpu, "5.5%");
    assert.strictEqual(res1.containers[0].restartCount, 2);
    assert.strictEqual(res1.containers[1].name, "web-2");
    assert.strictEqual(res1.containers[1].cpu, null);
    assert.ok(res1.warning.includes("stats daemon timeout for bbb444555666"), "surfaces first non-vanished stats error");
    assert.ok(res1.warning.includes("cgroup read error for ccc777888999"), "surfaces second non-vanished stats error too");

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

QUnit.test("withSpawnTimeout terminates hung docker commands", async assert => {
    let closedWith = null;
    const hungSpawn = () => {
        const p = new Promise(() => {});
        p.close = reason => { closedWith = reason };
        return p;
    };

    const timedSpawn = withSpawnTimeout(hungSpawn, 20);
    await assert.rejects(
        timedSpawn(["inspect", "abc"]),
        /docker inspect timed out after 20ms/,
        "rejects when spawn exceeds timeoutMs"
    );
    assert.strictEqual(closedWith, "terminated", "calls proc.close('terminated') on timeout");
});

QUnit.test("createRefreshController preempts in-flight refreshes on manual refresh, enforces timeout, and tracks dated warnings", async assert => {
    assert.strictEqual(
        formatWarningTimestamp(new Date(2026, 9, 15, 10, 5, 8)),
        "2026-10-15 10:05:08"
    );

    let loadCalls = 0;
    let resolveBg;
    const bgGate = new Promise(resolve => { resolveBg = resolve });
    let resolveSlowManual;
    const slowManualGate = new Promise(resolve => { resolveSlowManual = resolve });
    let mode = "slow-bg";
    let fakeClock = new Date(2026, 9, 15, 10, 5, 8);
    let lastEmittedState = null;

    const controller = createRefreshController({
        now: () => fakeClock,
        onStateChange: s => { lastEmittedState = s },
        load: async () => {
            const callNum = ++loadCalls;
            if (mode === "slow-bg" && callNum === 1) {
                await bgGate;
                return { containers: [{ id: "stale", name: "stale-app" }], warning: null };
            }
            if (mode === "slow-manual") {
                await slowManualGate;
                return { containers: [{ id: "slow-manual", name: "slow-manual-app" }], warning: null };
            }
            if (mode === "manual-preempt") {
                return { containers: [{ id: "fresh", name: "fresh-app" }], warning: null };
            }
            if (mode === "bg-fail-1")
                throw new Error("daemon temporary error");
            if (mode === "bg-partial-warn")
                return { containers: [{ id: "fresh", name: "fresh-app" }], warning: "partial stats failure" };
            if (mode === "hang")
                return new Promise(() => {});
            return { containers: [{ id: "fresh", name: "fresh-app" }], warning: null };
        },
        timeoutMs: 30,
    });

    // 1. Start background refresh #1 (stays in flight)
    const pBg = controller.refresh({ background: true });
    assert.strictEqual(controller.getState().inFlightCount, 1);

    // Another background tick while #1 is in flight is skipped
    const skippedBg = await controller.refresh({ background: true });
    assert.strictEqual(skippedBg, false, "overlapping background refresh is skipped");
    assert.strictEqual(loadCalls, 1);

    // 2. Manual refresh #1 (slow) while background refresh #1 is in flight PREEMPTS #1
    mode = "slow-manual";
    const pSlowManual = controller.refresh({ background: false });
    assert.strictEqual(controller.getState().loading, true, "manual refresh sets loading=true");

    // 3. Another manual refresh #2 while manual refresh #1 is in flight ALSO preempts #1 via generation
    mode = "manual-preempt";
    const pFastManual = controller.refresh({ background: false });
    await pFastManual;
    assert.strictEqual(controller.getState().loading, false, "loading immediately becomes false when newest manual refresh completes");
    assert.strictEqual(lastEmittedState.loading, false, "onStateChange received loading=false");
    assert.deepEqual(controller.getState().containers.map(c => c.id), ["fresh"], "newest manual refresh applied fresh result");

    // Now let stale manual refresh #1 and stale background refresh #1 finish — both must be ignored
    resolveSlowManual();
    await pSlowManual;
    resolveBg();
    await pBg;
    assert.strictEqual(controller.getState().inFlightCount, 0);
    assert.strictEqual(lastEmittedState.inFlightCount, 0, "onStateChange stays in sync when preempted refreshes finish");
    assert.strictEqual(lastEmittedState.loading, false, "loading remains false after stale manual refresh finishes");
    assert.deepEqual(controller.getState().containers.map(c => c.id), ["fresh"], "stale preempted results ignored");

    // 4. Background failure increments consecutiveFailures and includes YYYY-MM-DD HH:MM:SS
    mode = "bg-fail-1";
    fakeClock = new Date(2026, 9, 15, 10, 5, 16);
    await controller.refresh({ background: true });
    assert.strictEqual(controller.getState().consecutiveFailures, 1);
    assert.strictEqual(controller.getState().lastWarningAt, "2026-10-15 10:05:16");
    assert.strictEqual(
        controller.getState().warning,
        "[2026-10-15 10:05:16, consecutive failures: 1] daemon temporary error"
    );
    assert.strictEqual(controller.getState().containers.length, 1, "preserves previous container list on background failure");

    // 5. Partial warning on successful load resets consecutiveFailures to 0 and does not claim consecutive failures
    mode = "bg-partial-warn";
    fakeClock = new Date(2026, 9, 15, 10, 5, 24);
    await controller.refresh({ background: true });
    assert.strictEqual(controller.getState().consecutiveFailures, 0, "partial warning does not inflate consecutiveFailures");
    assert.strictEqual(controller.getState().lastWarningAt, "2026-10-15 10:05:24");
    assert.strictEqual(
        controller.getState().warning,
        "[2026-10-15 10:05:24] partial stats failure"
    );

    // 6. Hung refresh times out via timeoutMs and does not permanently block future refreshes
    mode = "hang";
    fakeClock = new Date(2026, 9, 15, 10, 5, 32);
    await controller.refresh({ background: false });
    assert.strictEqual(controller.getState().inFlightCount, 0, "inFlightCount resets after timeout");
    assert.strictEqual(controller.getState().loading, false, "loading resets after timeout");
    assert.ok(controller.getState().error.includes("timed out"), "timeout error surfaced");

    // 7. Subsequent clean refresh succeeds after timeout recovery
    mode = "ok";
    await controller.refresh({ background: false });
    assert.strictEqual(controller.getState().error, null);
    assert.strictEqual(controller.getState().warning, null);
    assert.strictEqual(controller.getState().consecutiveFailures, 0);
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
    assert.strictEqual(inspected.rows.length, 1);
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

QUnit.test("loadContainers validates filter once per call and background refresh does not emit busy start state", async assert => {
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
    assert.strictEqual(emittedStates.length, 2, "manual refresh emits once on start and once on completion");
    assert.strictEqual(emittedStates[0].inFlightCount, 1);
    assert.strictEqual(emittedStates[0].loading, true);
    assert.strictEqual(emittedStates[1].inFlightCount, 0);
    assert.strictEqual(emittedStates[1].loading, false);
    assert.strictEqual(emittedStates[1].containers.length, 1);

    emittedStates.length = 0;
    await controller.refresh({ background: true });
    assert.strictEqual(emittedStates.length, 1, "background refresh only emits on completion so UI buttons do not flash every 8s");
    assert.strictEqual(emittedStates[0].loading, false);
});

