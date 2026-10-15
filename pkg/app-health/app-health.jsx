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
    activeLabelSelectors,
    activeNamePrefixes,
    createRefreshController,
    DEFAULT_LABEL_SELECTORS,
    LIST_REFRESH_MS,
    loadContainers,
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
    const labelSelectors = config["label-selectors"] ?? config.labelSelectors ?? DEFAULT_LABEL_SELECTORS;

    return {
        namePrefixes: activeNamePrefixes({ namePrefixes }),
        labelSelectors: activeLabelSelectors({ labelSelectors }),
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
    const filter = useMemo(() => readFilterConfig(), []);
    const [refreshState, setRefreshState] = useState({
        containers: null,
        error: null,
        warning: null,
        loading: true,
        inFlightCount: 0,
        consecutiveFailures: 0,
        lastWarningAt: null,
    });

    const controller = useMemo(() => createRefreshController({
        load: () => loadContainers(filter, {
            spawn: dockerSpawn,
            formatInspectWarning: msg => cockpit.format(
                _("Could not inspect containers (restart counts and labels may be incomplete): $0"),
                msg
            ),
            formatStatsWarning: msg => cockpit.format(
                _("Could not read container stats (CPU/memory unavailable): $0"),
                msg
            ),
        }),
        formatWarningMeta: (msg, time, count) => cockpit.format(
            _("[$0, consecutive failures: $1] $2"),
            time,
            count,
            msg
        ),
        onStateChange: setRefreshState,
    }), [filter]);

    const refresh = useCallback((options = {}) => controller.refresh(options), [controller]);

    useInit(() => { refresh() });

    useEffect(() => {
        const timer = window.setInterval(() => refresh({ background: true }), LIST_REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [refresh]);

    const { containers, error, warning, loading, inFlightCount } = refreshState;
    const isBusy = loading || inFlightCount > 0;

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
                <Button variant="secondary" isDisabled={isBusy} onClick={() => refresh()}>{_("Retry")}</Button>
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
                                icon={isBusy ? <Spinner size="md" /> : <SyncAltIcon />}
                                isDisabled={isBusy}
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
