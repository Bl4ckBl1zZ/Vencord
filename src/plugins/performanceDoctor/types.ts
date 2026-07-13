/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface FrameSample {
    at: number;
    delta: number;
}

export interface ScriptAttribution {
    duration: number;
    forcedStyleAndLayoutDuration: number;
    invoker: string;
    invokerType: string;
    sourceFunctionName: string;
    sourceURL: string;
}

export interface LongFrameSample {
    at: number;
    duration: number;
    blockingDuration: number;
    renderDuration: number;
    styleAndLayoutDuration: number;
    scripts: ScriptAttribution[];
}

export interface InputSample {
    at: number;
    name: string;
    duration: number;
    inputDelay: number;
    processingDuration: number;
}

export interface MemorySample {
    at: number;
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
}

export interface TimingAggregate {
    plugin: string;
    event: string;
    calls: number;
    promiseReturns: number;
    totalDuration: number;
    maxDuration: number;
    p95Duration: number;
}

export interface Marker {
    at: number;
    label: string;
}

export interface SummaryMetrics {
    refreshInterval: number;
    frameCount: number;
    frameP50: number;
    frameP95: number;
    frameP99: number;
    missedFrames: number;
    longFrameCount: number;
    worstLongFrame: number;
    inputEventCount: number;
    worstInputDuration: number;
    heapDelta?: number;
}

export interface NativeCaptureResult {
    caseId: string;
    folder: string;
    startedAt: string;
    traceEnabled: boolean;
    metrics: unknown[];
    versions: Record<string, string>;
}

export interface PerformanceCase {
    schemaVersion: 1;
    caseId: string;
    label: string;
    build: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    privacy: {
        messageContentCaptured: false;
        identifiersCaptured: false;
        rawTraceMayContainUrls: boolean;
    };
    environment: {
        platform: string;
        visibilityState: DocumentVisibilityState;
        hardwareConcurrency: number;
        deviceMemory?: number;
        nativeVersions: Record<string, string>;
    };
    metrics: SummaryMetrics;
    markers: Marker[];
    frames: FrameSample[];
    longAnimationFrames: LongFrameSample[];
    inputEvents: InputSample[];
    memory: MemorySample[];
    pluginFluxHandlers: TimingAggregate[];
    fluxEvents: Array<{ event: string; count: number; }>;
    enabledPlugins: string[];
    nativeProcessMetrics: {
        start: unknown[];
        end: unknown[];
    };
}

export interface PublicCaptureState {
    active: boolean;
    finishing: boolean;
    elapsedMs: number;
    recentLongFrames: number;
    recentWorstFrame: number;
    lastCaseFolder?: string;
    lastReport?: string;
    error?: string;
}
