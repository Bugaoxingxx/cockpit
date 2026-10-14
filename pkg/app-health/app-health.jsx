/*
 * Copyright (C) 2026 Chaoqian Li
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import '../lib/patternfly/patternfly-6-cockpit.scss';
import "polyfills";
import 'cockpit-dark-theme'; // once per page

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from 'react-dom/client';
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert/index.js";
import { Button } from "@patternfly/react-core/dist/esm/components/Button/index.js";
import { Card, CardBody, CardHeader, CardTitle } from '@patternfly/react-core/dist/esm/components/Card/index.js';
import { Page, PageSection } from "@patternfly/react-core/dist/esm/components/Page/index.js";
import { Title, TitleSizes } from '@patternfly/react-core/dist/esm/components/Title';
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Spinner } from "@patternfly/react-core/dist/esm/components/Spinner/index.js";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex/index.js";
import { EmptyStatePanel } from "cockpit-components-empty-state.jsx";
import { ListingTable } from "cockpit-components-table.jsx";
import { useInit, usePageLocation } from "hooks";
import { SyncAltIcon } from '@patternfly/react-icons';

import cockpit from "cockpit";

import {
    activeLabelSelectors,
    activeNamePrefixes,
    applyInspectMetadata,
    chunkArray,
    containerMatchesFilter,
    containersVisibleWithoutInspect,
    DEFAULT_LABEL_SELECTORS,
    INSPECT_BATCH_SIZE,
    isContainerRunning,
    labelSelectorToDockerFilter,
    LIST_REFRESH_MS,
    lookupStats,
    mergeContainersById,
    nameMatches,
    normalizeName,
    parseJsonLines,
    STATS_BATCH_SIZE,
    statsByContainerId,
} from './app-health-lib.js';

import './app-health.scss';

const _ = cockpit.gettext;

/**
 * Spawn a docker CLI command. Docker must be on PATH for the logged-in user
 * and the user must be allowed to talk to the Docker daemon.
 */
function dockerSpawn(args, options = {}) {
    return cockpit.spawn(["docker", ...args], { err: "message", ...options });
}

function readFilterConfig() {
    const config = cockpit.manifests?.["app-health"]?.config || {};
    const namePrefixes = config["name-prefixes"] ?? config.namePrefixes ?? [];
    const labelSelectors = config["label-selectors"] ?? config.labelSelectors;

    return {
        namePrefixes: Array.isArray(namePrefixes) ? namePrefixes : [],
        labelSelectors: Array.isArray(labelSelectors)
            ? labelSelectors
            : DEFAULT_LABEL_SELECTORS,
    };
}

function statusVariant(status, state) {
    const s = (state || status || "").toLowerCase();
    if (s.startsWith("up") || s === "running")
        return "success";
    if (s.startsWith("exited") || s === "dead" || s.includes("error"))
        return "danger";
    if (s.startsWith("created") || s.startsWith("paused") || s.startsWith("restarting"))
        return "warning";
    return "grey";
}

function labelColor(status, state) {
    const v = statusVariant(status, state);
    if (v === "success")
        return "green";
    if (v === "danger")
        return "red";
    if (v === "warning")
        return "orange";
    return "grey";
}

function psRowToContainer(row) {
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

async function dockerInspectAll(ids) {
    const inspected = [];
    for (const batch of chunkArray(ids, INSPECT_BATCH_SIZE)) {
        const inspectOut = await dockerSpawn([
            "inspect",
            "--format", "{{json .}}",
            ...batch,
        ]);
        inspected.push(...parseJsonLines(inspectOut));
    }
    return inspected;
}

async function dockerStatsForIds(ids) {
    const rows = [];
    for (const batch of chunkArray(ids, STATS_BATCH_SIZE)) {
        const statsOut = await dockerSpawn([
            "stats", "--no-stream", "--format", "{{json .}}",
            ...batch,
        ]);
        rows.push(...parseJsonLines(statsOut));
    }
    return rows;
}

async function fetchAllPsContainers() {
    const psOut = await dockerSpawn([
        "ps", "-a",
        "--format", "{{json .}}",
    ]);
    return parseJsonLines(psOut).map(psRowToContainer);
}

async function fetchPsWithLabelSelector(selector) {
    const dockerFilter = labelSelectorToDockerFilter(selector);
    if (!dockerFilter)
        return [];
    const psOut = await dockerSpawn([
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
 * `docker ps --filter`, name rules filter the ps list in memory, union when both.
 */
async function gatherCandidates(filter) {
    const namePrefixes = activeNamePrefixes(filter);
    const labelSelectors = activeLabelSelectors(filter);

    if (namePrefixes.length === 0 && labelSelectors.length === 0)
        return [];

    let candidates = [];

    for (const sel of labelSelectors)
        candidates = mergeContainersById(candidates, await fetchPsWithLabelSelector(sel));

    if (namePrefixes.length > 0) {
        const all = await fetchAllPsContainers();
        const byName = all.filter(c => nameMatches(c.name, namePrefixes));
        candidates = mergeContainersById(candidates, byName);
    }

    return candidates;
}

/**
 * Load container list + restart counts + one-shot stats for filtered apps only.
 * Detail view is intentionally stubbed (see ContainerDetailStub).
 */
async function loadContainers(filter) {
    let warning = null;
    const candidates = await gatherCandidates(filter);

    if (candidates.length === 0)
        return { containers: [], warning: null };

    const inspectIds = candidates.map(c => c.id).filter(Boolean);
    let inspectFailed = false;

    try {
        const inspected = await dockerInspectAll(inspectIds);
        applyInspectMetadata(candidates, inspected);
    } catch (e) {
        inspectFailed = true;
        warning = cockpit.format(
            _("Could not inspect containers (restart counts and labels may be incomplete): $0"),
            e.message || String(e)
        );
        console.warn("app-health: docker inspect failed", e);
    }

    let filtered = candidates.filter(c => containerMatchesFilter(c, filter));

    if (inspectFailed && filtered.length === 0 && candidates.length > 0) {
        filtered = containersVisibleWithoutInspect(candidates, filter);
        if (filtered.length > 0) {
            warning = (warning ? warning + " " : "") +
                _("Showing containers matched by name or label filter; inspect metadata is unavailable.");
        } else {
            throw new Error(
                warning ||
                _("Could not inspect containers and no applications matched without inspect metadata.")
            );
        }
    }

    const runningIds = filtered.filter(isContainerRunning).map(c => c.id).filter(Boolean);
    if (runningIds.length > 0) {
        try {
            const statsRows = await dockerStatsForIds(runningIds);
            const byId = statsByContainerId(statsRows);
            for (const c of filtered) {
                const st = lookupStats(byId, c);
                if (st) {
                    c.cpu = st.cpu;
                    c.memory = st.memory;
                }
            }
        } catch (e) {
            const statsWarning = cockpit.format(
                _("Could not read container stats (CPU/memory unavailable): $0"),
                e.message || String(e)
            );
            warning = warning ? `${warning} ${statsWarning}` : statsWarning;
            console.warn("app-health: docker stats failed", e);
        }
    }

    filtered.sort((a, b) => a.name.localeCompare(b.name));
    return { containers: filtered, warning };
}

const ContainerDetailStub = ({ name }) => (
    <PageSection hasBodyWrapper={false} padding={{ default: "padding" }}>
        <Card>
            <CardHeader>
                <CardTitle component="h2">{cockpit.format(_("Container: $0"), name)}</CardTitle>
            </CardHeader>
            <CardBody>
                <Alert variant="info" isInline title={_("Detail view is not implemented yet")}>
                    <p>
                        {_("This is a stub. A future revision can show inspect JSON, logs, and lifecycle actions.")}
                    </p>
                    <Button variant="link" isInline onClick={() => cockpit.location.go([])}>
                        {_("Back to list")}
                    </Button>
                </Alert>
            </CardBody>
        </Card>
    </PageSection>
);

const ContainerList = () => {
    const [containers, setContainers] = useState(null);
    const [error, setError] = useState(null);
    const [warning, setWarning] = useState(null);
    const [loading, setLoading] = useState(true);
    const filter = useMemo(() => readFilterConfig(), []);
    const refreshGenRef = useRef(0);
    const inFlightRef = useRef(false);

    const refresh = useCallback(async (options = {}) => {
        const background = options.background === true;
        if (background && inFlightRef.current)
            return;

        const gen = ++refreshGenRef.current;
        inFlightRef.current = true;

        if (!background) {
            setLoading(true);
            setError(null);
            setWarning(null);
        }
        try {
            const result = await loadContainers(filter);
            if (gen !== refreshGenRef.current)
                return;
            setContainers(result.containers);
            setError(null);
            setWarning(result.warning);
        } catch (e) {
            if (gen !== refreshGenRef.current)
                return;
            const message = e.message || String(e);
            if (background) {
                setWarning(message);
            } else {
                setContainers([]);
                setError(message);
            }
        } finally {
            if (gen === refreshGenRef.current)
                inFlightRef.current = false;
            if (!background && gen === refreshGenRef.current)
                setLoading(false);
        }
    }, [filter]);

    useInit(() => { refresh() });

    useEffect(() => {
        const timer = window.setInterval(() => refresh({ background: true }), LIST_REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [refresh]);

    const columns = [
        { title: _("Name") },
        { title: _("Image") },
        { title: _("Status") },
        { title: _("CPU") },
        { title: _("Memory") },
        { title: _("Restarts") },
        { title: _("Ports") },
    ];

    const rows = (containers || []).map(c => ({
        columns: [
            {
                title: (
                    <Button variant="link" isInline
                            onClick={() => cockpit.location.go([c.name])}>
                        {c.name}
                    </Button>
                )
            },
            { title: c.image || "—" },
            {
                title: (
                    <Label variant="outline" color={labelColor(c.status, c.state)}>
                        {c.status || c.state || "—"}
                    </Label>
                )
            },
            { title: c.cpu ?? "—" },
            { title: c.memory ?? "—" },
            { title: c.restartCount == null ? "—" : String(c.restartCount) },
            { title: c.ports || "—" },
        ],
        props: { key: c.id || c.name },
    }));

    let body;
    if (loading && containers === null) {
        body = <EmptyStatePanel loading title={_("Loading containers...")} />;
    } else if (error) {
        body = (
            <Alert variant="danger" isInline
                   title={_("Failed to list Docker containers")}>
                <p>{error}</p>
                <p className="app-health-hint">
                    {_("Ensure the Docker CLI is installed and the logged-in user can run docker (e.g. membership in the docker group).")}
                </p>
                <Button variant="secondary" onClick={() => refresh()}>{_("Retry")}</Button>
            </Alert>
        );
    } else {
        body = (
            <>
                {warning && (
                    <Alert variant="warning" isInline className="app-health-warning"
                           title={_("Some container data could not be refreshed")}>
                        <p>{warning}</p>
                    </Alert>
                )}
                <ListingTable aria-label={_("Docker containers")}
                              variant="compact"
                              emptyCaption={_("No matching containers. Adjust filters in manifest config or tag apps with the configured label.")}
                              columns={columns}
                              rows={rows} />
            </>
        );
    }

    return (
        <PageSection hasBodyWrapper={false}>
            <Card>
                <CardHeader actions={{
                    actions: (
                        <Button variant="secondary"
                                icon={loading ? <Spinner size="md" /> : <SyncAltIcon />}
                                isDisabled={loading}
                                onClick={() => refresh()}>
                            {_("Refresh")}
                        </Button>
                    )
                }}>
                    <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
                        <FlexItem>
                            <CardTitle component="h2">{_("Docker applications")}</CardTitle>
                        </FlexItem>
                        <FlexItem>
                            <span className="app-health-hint">
                                {_("Listed when container name or labels match manifest config")}
                            </span>
                        </FlexItem>
                    </Flex>
                </CardHeader>
                <CardBody>{body}</CardBody>
            </Card>
        </PageSection>
    );
};

const Application = () => {
    const location = usePageLocation();
    const detailName = location.path[0];

    return (
        <Page className="pf-m-no-sidebar">
            <PageSection hasBodyWrapper={false} padding={{ default: "padding" }}>
                <Title headingLevel="h1" size={TitleSizes['2xl']}>
                    {_("Application Health")}
                </Title>
            </PageSection>
            {detailName
                ? <ContainerDetailStub name={detailName} />
                : <ContainerList />}
        </Page>
    );
};

document.addEventListener("DOMContentLoaded", () => {
    const root = createRoot(document.getElementById("app"));
    root.render(<Application />);
});
