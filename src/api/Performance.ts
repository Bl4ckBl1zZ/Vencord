/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface PluginFluxTiming {
    plugin: string;
    event: string;
    duration: number;
    returnedPromise: boolean;
}

export type PluginFluxTimingListener = (timing: PluginFluxTiming) => void;

let pluginFluxTimingListener: PluginFluxTimingListener | undefined;

export function getPluginFluxTimingListener() {
    return pluginFluxTimingListener;
}

export function setPluginFluxTimingListener(listener?: PluginFluxTimingListener) {
    pluginFluxTimingListener = listener;
}
