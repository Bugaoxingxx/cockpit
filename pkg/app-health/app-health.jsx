/*
 * Copyright (C) 2026 Chaoqian Li
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import '../lib/patternfly/patternfly-6-cockpit.scss';
import "polyfills";
import 'cockpit-dark-theme'; // once per page

import React, { useCallback, useEffect, useMemo, useState } from "react";
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
    chunkArray,
    containerMatchesFilter,
    DEFAULT_LABEL_SELECTORS,
    INSPECT_BATCH_SIZE,
    LIST_REFRESH_MS,
    lookupStats,
    normalizeContainerId,
    normalizeName,
    parseJsonLines,
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

/**
 * Load container list + restart counts + one-shot stats.
 * Detail view is intentionally stubbed (see ContainerDetailStub).
 */
async function loadContainers(filter) {
    const psOut = await dockerSpawn([
        "ps", "-a",
        "--format", "{{json .}}",
    ]);
    const listed = parseJsonLines(psOut);

    const containers = listed.map(row => {
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
            restartCount: null,
            cpu: null,
            memory: null,
        };
    });

    if (containers.length === 0)
        return containers;

    try {
        const ids = containers.map(c => c.id).filter(Boolean);
        if (ids.length > 0) {
            const inspected = await dockerInspectAll(ids);
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
                if (meta) {
                    c.restartCount = meta.restartCount;
                    c.labels = meta.labels;
                    if (meta.state)
                        c.state = meta.state;
                    if (meta.name)
                        c.name = meta.name;
                }
            }
        }
    } catch (e) {
        console.warn("app-health: docker inspect failed (restart counts skipped)", e);
    }

    const filtered = containers.filter(c => containerMatchesFilter(c, filter));

    try {
        const statsOut = await dockerSpawn([
            "stats", "--no-stream", "--format", "{{json .}}",
        ]);
        const byId = statsByContainerId(parseJsonLines(statsOut));
        for (const c of filtered) {
            const st = lookupStats(byId, c);
            if (st) {
                c.cpu = st.cpu;
                c.memory = st.memory;
            }
        }
    } catch (e) {
        console.warn("app-health: docker stats failed (CPU/memory skipped)", e);
    }

    filtered.sort((a, b) => a.name.localeCompare(b.name));
    return filtered;
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
    const [loading, setLoading] = useState(true);
    const filter = useMemo(() => readFilterConfig(), []);

    const refresh = useCallback(async (options = {}) => {
        const background = options.background === true;
        if (!background) {
            setLoading(true);
            setError(null);
        }
        try {
            const list = await loadContainers(filter);
            setContainers(list);
            if (!background)
                setError(null);
        } catch (e) {
            setContainers([]);
            setError(e.message || String(e));
        } finally {
            if (!background)
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
            <ListingTable aria-label={_("Docker containers")}
                          variant="compact"
                          emptyCaption={_("No matching containers. Adjust filters in manifest config or tag apps with the configured label.")}
                          columns={columns}
                          rows={rows} />
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
