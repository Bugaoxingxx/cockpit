/*
 * Copyright (C) 2026 Chaoqian Li
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import '../lib/patternfly/patternfly-6-cockpit.scss';
import "polyfills";
import 'cockpit-dark-theme'; // once per page

import React, { useCallback, useState } from "react";
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

import './app-health.scss';

const _ = cockpit.gettext;

/**
 * Spawn a docker CLI command. Docker must be on PATH for the logged-in user
 * and the user must be allowed to talk to the Docker daemon.
 */
function dockerSpawn(args, options = {}) {
    return cockpit.spawn(["docker", ...args], { err: "message", ...options });
}

/** Parse NDJSON (one JSON object per line) from docker --format '{{json .}}'. */
function parseJsonLines(text) {
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

function normalizeName(name) {
    if (!name)
        return "";
    return name.startsWith("/") ? name.slice(1) : name;
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

/**
 * Load container list + restart counts + one-shot stats.
 * Detail view is intentionally stubbed (see ContainerDetailStub).
 */
async function loadContainers() {
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
            restartCount: null,
            cpu: null,
            memory: null,
        };
    });

    if (containers.length === 0)
        return containers;

    // Restart counts (and names) via a single inspect of all IDs
    try {
        const ids = containers.map(c => c.id).filter(Boolean);
        if (ids.length > 0) {
            const inspectOut = await dockerSpawn([
                "inspect",
                "--format", "{{json .}}",
                ...ids,
            ]);
            const inspected = parseJsonLines(inspectOut);
            const byId = {};
            for (const info of inspected) {
                const id = (info.Id || "").slice(0, 12);
                const fullId = info.Id || "";
                const name = normalizeName(info.Name || "");
                const restartCount = info.RestartCount ?? info.State?.RestartCount ?? 0;
                byId[id] = { name, restartCount, fullId, state: info.State?.Status };
                byId[fullId] = byId[id];
            }
            for (const c of containers) {
                const meta = byId[c.id] || byId[c.id.slice(0, 12)];
                if (meta) {
                    c.restartCount = meta.restartCount;
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

    // Cheap one-shot CPU/memory for running containers only
    try {
        const statsOut = await dockerSpawn([
            "stats", "--no-stream", "--format", "{{json .}}",
        ]);
        const stats = parseJsonLines(statsOut);
        const byName = {};
        for (const s of stats) {
            const n = normalizeName(s.Name || s.Container || "");
            byName[n] = {
                cpu: s.CPUPerc || s.CPUPercentage || null,
                memory: s.MemUsage || s.MemoryUsage || null,
            };
        }
        for (const c of containers) {
            const st = byName[c.name];
            if (st) {
                c.cpu = st.cpu;
                c.memory = st.memory;
            }
        }
    } catch (e) {
        console.warn("app-health: docker stats failed (CPU/memory skipped)", e);
    }

    containers.sort((a, b) => a.name.localeCompare(b.name));
    return containers;
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

    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const list = await loadContainers();
            setContainers(list);
        } catch (e) {
            setContainers([]);
            setError(e.message || String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useInit(() => { refresh() });

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
                <Button variant="secondary" onClick={refresh}>{_("Retry")}</Button>
            </Alert>
        );
    } else {
        body = (
            <ListingTable aria-label={_("Docker containers")}
                          variant="compact"
                          emptyCaption={_("No containers. Use docker run --name … to create named apps.")}
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
                                onClick={refresh}>
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
                                {_("Listed by container name (docker run --name)")}
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
                    {_("应用健康")}
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
