/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginFluxTiming, setPluginFluxTimingListener } from "@api/Performance";
import { isPluginEnabled, plugins } from "@api/PluginManager";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { FluxDispatcher } from "@webpack/common";

import gitHash from "~git-hash";

import { settings } from "./settings";
import type {
    FrameSample,
    InputSample,
    LongFrameSample,
    Marker,
    MemorySample,
    NativeCaptureResult,
    PerformanceCase,
    PublicCaptureState,
    ScriptAttribution,
    SummaryMetrics,
    TimingAggregate
} from "./types";

const Native = VencordNative.pluginHelpers.PerformanceDoctor as PluginNative<typeof import("./native")>;
const logger = new Logger("PerformanceDoctor", "#7c8cff");

class RingBuffer<T> {
    private values: T[];
    private cursor = 0;
    private full = false;

    constructor(private capacity: number) {
        this.values = new Array(capacity);
    }

    push(value: T) {
        this.values[this.cursor] = value;
        this.cursor = (this.cursor + 1) % this.capacity;
        if (this.cursor === 0) this.full = true;
    }

    toArray() {
        if (!this.full) return this.values.slice(0, this.cursor);
        return [...this.values.slice(this.cursor), ...this.values.slice(0, this.cursor)];
    }
}

interface TimingBucket {
    plugin: string;
    event: string;
    calls: number;
    promiseReturns: number;
    totalDuration: number;
    maxDuration: number;
    samples: number[];
}

interface ActiveCapture {
    native: NativeCaptureResult;
    label: string;
    startedAt: number;
    frames: FrameSample[];
    longFrames: LongFrameSample[];
    inputs: InputSample[];
    memory: MemorySample[];
    markers: Marker[];
    timings: Map<string, TimingBucket>;
    fluxEvents: Map<string, number>;
}

const recentFrames = new RingBuffer<FrameSample>(3600);
const recentLongFrames = new RingBuffer<LongFrameSample>(240);
const subscribers = new Set<() => void>();

let activeCapture: ActiveCapture | undefined;
let finishing = false;
let lastCaseFolder: string | undefined;
let lastReport: string | undefined;
let lastError: string | undefined;
let animationFrame = 0;
let lastAnimationTime = 0;
let longFrameObserver: PerformanceObserver | undefined;
let eventObserver: PerformanceObserver | undefined;
let memoryTimer = 0;
let autoStopTimer = 0;
let dispatchOriginal: ((...args: any[]) => any) | undefined;
let dispatchWrapper: ((...args: any[]) => any) | undefined;

function notify() {
    subscribers.forEach(listener => listener());
}

function percentile(values: number[], percentile: number) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile))];
}

function round(value: number, places = 2) {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
}

function sanitizeSourceURL(sourceURL: string) {
    if (!sourceURL) return "unknown";
    const withoutQuery = sourceURL.split(/[?#]/, 1)[0];

    try {
        const url = new URL(withoutQuery);
        if (url.protocol === "file:") {
            const parts = url.pathname.split("/").filter(Boolean);
            return `file:///…/${parts.slice(-3).join("/")}`;
        }
        return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
        const parts = withoutQuery.split("/");
        return parts.slice(-3).join("/");
    }
}

function serializeLongFrame(entry: any): LongFrameSample {
    const end = entry.startTime + entry.duration;
    const scripts: ScriptAttribution[] = (entry.scripts ?? [])
        .map((script: any) => ({
            duration: round(script.duration ?? 0),
            forcedStyleAndLayoutDuration: round(script.forcedStyleAndLayoutDuration ?? 0),
            invoker: String(script.invoker ?? ""),
            invokerType: String(script.invokerType ?? ""),
            sourceFunctionName: String(script.sourceFunctionName ?? ""),
            sourceURL: sanitizeSourceURL(String(script.sourceURL ?? ""))
        }))
        .sort((a: ScriptAttribution, b: ScriptAttribution) => b.duration - a.duration)
        .slice(0, 12);

    return {
        at: round(entry.startTime),
        duration: round(entry.duration),
        blockingDuration: round(entry.blockingDuration ?? 0),
        renderDuration: round(entry.renderStart ? end - entry.renderStart : 0),
        styleAndLayoutDuration: round(entry.styleAndLayoutStart ? end - entry.styleAndLayoutStart : 0),
        scripts
    };
}

function handleAnimationFrame(timestamp: number) {
    if (lastAnimationTime && document.visibilityState === "visible") {
        const sample = { at: round(timestamp), delta: round(timestamp - lastAnimationTime) };
        recentFrames.push(sample);
        activeCapture?.frames.push(sample);
    }

    lastAnimationTime = timestamp;
    animationFrame = requestAnimationFrame(handleAnimationFrame);
}

function startLongFrameObserver() {
    if (longFrameObserver) return;
    if (!PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) return;

    longFrameObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
            const sample = serializeLongFrame(entry);
            recentLongFrames.push(sample);
            activeCapture?.longFrames.push(sample);

            if (activeCapture && settings.store.autoMarkLongFrames && sample.duration >= 100) {
                performance.mark("vc-perf:auto-long-frame", { startTime: sample.at });
            }
        }
    });
    longFrameObserver.observe({ type: "long-animation-frame", buffered: true } as PerformanceObserverInit);
}

function startInputObserver() {
    if (eventObserver) return;
    if (!PerformanceObserver.supportedEntryTypes.includes("event")) return;

    eventObserver = new PerformanceObserver(list => {
        if (!activeCapture) return;
        for (const entry of list.getEntries() as any) {
            activeCapture.inputs.push({
                at: round(entry.startTime),
                name: String(entry.name ?? "event"),
                duration: round(entry.duration ?? 0),
                inputDelay: round((entry.processingStart ?? entry.startTime) - entry.startTime),
                processingDuration: round((entry.processingEnd ?? entry.startTime) - (entry.processingStart ?? entry.startTime))
            });
        }
    });
    eventObserver.observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
}

function sampleMemory() {
    if (!activeCapture) return;
    const { memory } = (performance as Performance & {
        memory?: { usedJSHeapSize: number; totalJSHeapSize: number; };
    });

    activeCapture.memory.push({
        at: round(performance.now()),
        usedJSHeapSize: memory?.usedJSHeapSize,
        totalJSHeapSize: memory?.totalJSHeapSize
    });
}

function recordPluginTiming(timing: PluginFluxTiming) {
    if (!activeCapture) return;
    const key = `${timing.plugin}\0${timing.event}`;
    const bucket = activeCapture.timings.get(key) ?? {
        plugin: timing.plugin,
        event: timing.event,
        calls: 0,
        promiseReturns: 0,
        totalDuration: 0,
        maxDuration: 0,
        samples: []
    };

    bucket.calls++;
    bucket.promiseReturns += Number(timing.returnedPromise);
    bucket.totalDuration += timing.duration;
    bucket.maxDuration = Math.max(bucket.maxDuration, timing.duration);
    if (bucket.samples.length < 1000) bucket.samples.push(timing.duration);
    activeCapture.timings.set(key, bucket);
}

function installFluxCounter() {
    try {
        const dispatcher = FluxDispatcher as any;
        dispatchOriginal = dispatcher.dispatch;
        dispatchWrapper = function (this: any, payload: { type?: string; }) {
            if (activeCapture && payload?.type) {
                activeCapture.fluxEvents.set(payload.type, (activeCapture.fluxEvents.get(payload.type) ?? 0) + 1);
            }
            return dispatchOriginal!.apply(this, arguments as any);
        };
        dispatcher.dispatch = dispatchWrapper;
    } catch (error) {
        dispatchOriginal = undefined;
        dispatchWrapper = undefined;
        logger.warn("Could not instrument Flux dispatch counts", error);
    }
}

function uninstallFluxCounter() {
    if (!dispatchOriginal || !dispatchWrapper) return;
    const dispatcher = FluxDispatcher as any;
    if (dispatcher.dispatch === dispatchWrapper) dispatcher.dispatch = dispatchOriginal;
    dispatchOriginal = undefined;
    dispatchWrapper = undefined;
}

function aggregateTimings(timings: Map<string, TimingBucket>): TimingAggregate[] {
    return Array.from(timings.values())
        .map(bucket => ({
            plugin: bucket.plugin,
            event: bucket.event,
            calls: bucket.calls,
            promiseReturns: bucket.promiseReturns,
            totalDuration: round(bucket.totalDuration),
            maxDuration: round(bucket.maxDuration),
            p95Duration: round(percentile(bucket.samples, 0.95))
        }))
        .sort((a, b) => b.totalDuration - a.totalDuration);
}

function summarize(capture: ActiveCapture): SummaryMetrics {
    const frameDeltas = capture.frames.map(frame => frame.delta).filter(delta => delta > 0 && delta < 1000);
    const refreshInterval = percentile(frameDeltas.filter(delta => delta < 30), 0.5) || 16.67;
    const missedFrameThreshold = Math.max(25, refreshInterval * 1.75);
    const heapStart = capture.memory.find(sample => sample.usedJSHeapSize != null)?.usedJSHeapSize;
    const heapEnd = capture.memory.findLast(sample => sample.usedJSHeapSize != null)?.usedJSHeapSize;

    return {
        refreshInterval: round(refreshInterval),
        frameCount: frameDeltas.length,
        frameP50: round(percentile(frameDeltas, 0.5)),
        frameP95: round(percentile(frameDeltas, 0.95)),
        frameP99: round(percentile(frameDeltas, 0.99)),
        missedFrames: frameDeltas.filter(delta => delta > missedFrameThreshold).length,
        longFrameCount: capture.longFrames.length,
        worstLongFrame: round(Math.max(0, ...capture.longFrames.map(frame => frame.duration))),
        inputEventCount: capture.inputs.length,
        worstInputDuration: round(Math.max(0, ...capture.inputs.map(input => input.duration))),
        heapDelta: heapStart != null && heapEnd != null ? heapEnd - heapStart : undefined
    };
}

function buildMarkdown(report: PerformanceCase) {
    const pluginRows = report.pluginFluxHandlers.slice(0, 8)
        .map(timing => `| ${timing.plugin} | ${timing.event} | ${timing.calls} | ${timing.totalDuration} ms | ${timing.maxDuration} ms |`)
        .join("\n") || "| — | — | 0 | 0 ms | 0 ms |";
    const firstFrameAt = report.frames[0]?.at ?? 0;
    const worstFrames = [...report.longAnimationFrames]
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 8)
        .map(frame => `- ${frame.duration} ms at +${round(frame.at - firstFrameAt)} ms; render ${frame.renderDuration} ms; layout ${frame.styleAndLayoutDuration} ms`)
        .join("\n") || "- None captured";
    const topFlux = report.fluxEvents.slice(0, 10)
        .map(entry => `\`${entry.event}\` ${entry.count}`)
        .join(", ") || "None captured";

    return "# Discord Performance Case\n\n" +
        `- **Case:** ${report.label}\n` +
        `- **Build:** ${report.build}\n` +
        `- **Duration:** ${(report.durationMs / 1000).toFixed(1)} seconds\n` +
        `- **Frame p95 / p99:** ${report.metrics.frameP95} / ${report.metrics.frameP99} ms\n` +
        `- **Missed frames:** ${report.metrics.missedFrames}\n` +
        `- **Long frames:** ${report.metrics.longFrameCount}; worst ${report.metrics.worstLongFrame} ms\n` +
        `- **Worst input event:** ${report.metrics.worstInputDuration} ms\n` +
        `- **Renderer heap delta:** ${report.metrics.heapDelta == null ? "Unavailable" : `${round(report.metrics.heapDelta / 1024 / 1024)} MiB`}\n\n` +
        "## Highest-cost Vencord Flux handlers\n\n" +
        `| Plugin | Event | Calls | Total | Max |\n|---|---|---:|---:|---:|\n${pluginRows}\n\n` +
        `## Worst long frames\n\n${worstFrames}\n\n` +
        `## Most frequent Flux events\n\n${topFlux}\n\n` +
        "## Analysis contract\n\n" +
        "Use evidence from case.json and the matching source before proposing a patch. Compare three equivalent runs before and after, change one variable at a time, and preserve a rollback. The raw Chromium trace can contain URLs; keep it local unless reviewed.\n";
}

function cleanupCaptureInstrumentation() {
    window.clearTimeout(autoStopTimer);
    window.clearInterval(memoryTimer);
    autoStopTimer = 0;
    memoryTimer = 0;
    eventObserver?.disconnect();
    eventObserver = undefined;
    setPluginFluxTimingListener();
    uninstallFluxCounter();
}

export async function startPerformanceCapture(label: string) {
    if (activeCapture || finishing) return;
    lastError = undefined;
    const cleanLabel = label.trim() || "Reproduce a Discord stutter";

    try {
        const native = await Native.startCapture(cleanLabel, settings.store.chromiumTrace);
        const now = performance.now();
        const includeAfter = now - settings.store.rollingWindow * 1000;

        activeCapture = {
            native,
            label: cleanLabel,
            startedAt: now,
            frames: recentFrames.toArray().filter(frame => frame.at >= includeAfter),
            longFrames: recentLongFrames.toArray().filter(frame => frame.at >= includeAfter),
            inputs: [],
            memory: [],
            markers: [{ at: round(now), label: "Capture started" }],
            timings: new Map(),
            fluxEvents: new Map()
        };

        performance.mark("vc-perf:capture-start");
        setPluginFluxTimingListener(recordPluginTiming);
        installFluxCounter();
        startInputObserver();
        sampleMemory();
        memoryTimer = window.setInterval(sampleMemory, 1000);
        autoStopTimer = window.setTimeout(finishPerformanceCapture, settings.store.captureDuration * 1000);
        notify();
    } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await Native.cancelCapture().catch(() => { });
        notify();
    }
}

export function markStutter() {
    if (!activeCapture) return;
    const at = performance.now();
    activeCapture.markers.push({ at: round(at), label: "Stutter observed" });
    performance.mark("vc-perf:stutter-observed");
    notify();
}

export async function finishPerformanceCapture() {
    if (!activeCapture || finishing) return;
    finishing = true;
    sampleMemory();
    const capture = activeCapture;
    activeCapture = undefined;
    cleanupCaptureInstrumentation();
    performance.mark("vc-perf:capture-stop");
    notify();

    try {
        const finishedAt = new Date().toISOString();
        const metrics = summarize(capture);
        const report: PerformanceCase = {
            schemaVersion: 1,
            caseId: capture.native.caseId,
            label: capture.label,
            build: gitHash,
            startedAt: capture.native.startedAt,
            finishedAt,
            durationMs: round(performance.now() - capture.startedAt),
            privacy: {
                messageContentCaptured: false,
                identifiersCaptured: false,
                rawTraceMayContainUrls: capture.native.traceEnabled
            },
            environment: {
                platform: navigator.platform,
                visibilityState: document.visibilityState,
                hardwareConcurrency: navigator.hardwareConcurrency,
                deviceMemory: (navigator as Navigator & { deviceMemory?: number; }).deviceMemory,
                nativeVersions: capture.native.versions
            },
            metrics,
            markers: capture.markers,
            frames: capture.frames,
            longAnimationFrames: capture.longFrames,
            inputEvents: capture.inputs,
            memory: capture.memory,
            pluginFluxHandlers: aggregateTimings(capture.timings),
            fluxEvents: Array.from(capture.fluxEvents, ([event, count]) => ({ event, count }))
                .sort((a, b) => b.count - a.count),
            enabledPlugins: Object.keys(plugins).filter(isPluginEnabled).sort(),
            nativeProcessMetrics: {
                start: capture.native.metrics,
                end: []
            }
        };
        const markdown = buildMarkdown(report);
        lastCaseFolder = await Native.finishCapture(report, markdown);
        lastReport = markdown;
        lastError = undefined;
    } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await Native.cancelCapture().catch(() => { });
    } finally {
        finishing = false;
        notify();
    }
}

export function getCaptureState(): PublicCaptureState {
    const recent = recentLongFrames.toArray().filter(frame => frame.at >= performance.now() - 30_000);
    return {
        active: !!activeCapture,
        finishing,
        elapsedMs: activeCapture ? performance.now() - activeCapture.startedAt : 0,
        recentLongFrames: recent.length,
        recentWorstFrame: round(Math.max(0, ...recent.map(frame => frame.duration))),
        lastCaseFolder,
        lastReport,
        error: lastError
    };
}

export function subscribeCaptureState(listener: () => void) {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
}

export function showLastCase() {
    if (lastCaseFolder) return Native.showCase(lastCaseFolder);
}

export function startPerformanceMonitor() {
    if (!animationFrame) animationFrame = requestAnimationFrame(handleAnimationFrame);
    startLongFrameObserver();
}

export function stopPerformanceMonitor() {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    lastAnimationTime = 0;
    longFrameObserver?.disconnect();
    longFrameObserver = undefined;
    cleanupCaptureInstrumentation();
    activeCapture = undefined;
    finishing = false;
    Native.cancelCapture().catch(() => { });
}
