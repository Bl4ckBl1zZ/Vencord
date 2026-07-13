/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { app, contentTracing, IpcMainInvokeEvent, shell } from "electron";
import { mkdir, writeFile } from "fs/promises";
import { join, normalize } from "path";

import type { NativeCaptureResult, PerformanceCase } from "./types";

const CASES_DIR = join(DATA_DIR, "performance-cases");

let activeCapture: {
    caseId: string;
    folder: string;
    startedAt: string;
    traceEnabled: boolean;
    metrics: unknown[];
} | undefined;

function sanitizeLabel(label: string) {
    return label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "performance-case";
}

function getProcessMetrics() {
    return app.getAppMetrics().map(metric => ({
        type: metric.type,
        name: metric.name,
        serviceName: metric.serviceName,
        cpu: metric.cpu,
        memory: metric.memory
    }));
}

function getVersions() {
    return {
        discord: app.getVersion(),
        electron: process.versions.electron ?? "unknown",
        chrome: process.versions.chrome ?? "unknown",
        node: process.versions.node
    };
}

export async function startCapture(_: IpcMainInvokeEvent, label: string, traceEnabled: boolean): Promise<NativeCaptureResult> {
    if (activeCapture) throw new Error("A performance capture is already active.");

    const startedAt = new Date().toISOString();
    const stamp = startedAt.replace(/[:.]/g, "-");
    const caseId = `${stamp}-${sanitizeLabel(label)}`;
    const folder = join(CASES_DIR, caseId);
    await mkdir(folder, { recursive: true });

    activeCapture = {
        caseId,
        folder,
        startedAt,
        traceEnabled,
        metrics: getProcessMetrics()
    };

    if (traceEnabled) {
        try {
            await contentTracing.startRecording({
                categoryFilter: "electron,toplevel,blink,cc,gpu,v8,devtools.timeline,disabled-by-default-devtools.timeline",
                traceOptions: "record-continuously,enable-sampling"
            });
        } catch (error) {
            activeCapture = undefined;
            throw error;
        }
    }

    return {
        caseId,
        folder,
        startedAt,
        traceEnabled,
        metrics: activeCapture.metrics,
        versions: getVersions()
    };
}

export async function finishCapture(_: IpcMainInvokeEvent, report: PerformanceCase, markdown: string) {
    if (!activeCapture || activeCapture.caseId !== report.caseId)
        throw new Error("No matching performance capture is active.");

    const capture = activeCapture;
    activeCapture = undefined;

    if (capture.traceEnabled) {
        await contentTracing.stopRecording(join(capture.folder, "chromium-trace.json"));
    }

    report.nativeProcessMetrics.end = getProcessMetrics();

    await Promise.all([
        writeFile(join(capture.folder, "case.json"), JSON.stringify(report, null, 2)),
        writeFile(join(capture.folder, "report.md"), markdown),
        writeFile(join(capture.folder, "reproduction.md"), `# Reproduction\n\n${report.label}\n\nRepeat this exact user story three times before and after a patch.\n`),
        writeFile(join(capture.folder, "source-map-index.json"), JSON.stringify({
            build: report.build,
            expectedMaps: ["renderer.js.map", "patcher.js.map"],
            note: "Use the matching Vencord checkout and dist source maps to resolve bundled frames."
        }, null, 2))
    ]);

    return capture.folder;
}

export async function cancelCapture(_: IpcMainInvokeEvent) {
    if (!activeCapture) return;
    const capture = activeCapture;
    activeCapture = undefined;
    if (capture.traceEnabled) await contentTracing.stopRecording();
}

export async function showCase(_: IpcMainInvokeEvent, folder: string) {
    const normalizedFolder = normalize(folder);
    const normalizedCasesDir = normalize(CASES_DIR + "/");
    if (!normalizedFolder.startsWith(normalizedCasesDir)) return false;

    shell.showItemInFolder(join(normalizedFolder, "report.md"));
    return true;
}
