/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

import { startPerformanceMonitor, stopPerformanceMonitor } from "./capture";
import { PerformanceDoctorPanel } from "./components";
import { settings } from "./settings";

export default definePlugin({
    name: "PerformanceDoctor",
    description: "Captures LLM-friendly Discord performance cases with frame, input, plugin, memory, and Chromium trace evidence.",
    authors: [Devs.Bl4ckBl1zZ],
    tags: ["Developers", "Utility"],
    searchTerms: ["performance", "profiler", "stutter", "lag", "trace", "debug"],
    target: "desktop",
    enabledByDefault: true,
    requiresRestart: false,
    settings,
    start: startPerformanceMonitor,
    stop: stopPerformanceMonitor,
    settingsAboutComponent: PerformanceDoctorPanel
});
