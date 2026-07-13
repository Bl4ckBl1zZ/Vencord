/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { MediaEngineStore, UserStore } from "@webpack/common";

const logger = new Logger("StreamBitrateBooster");

const settings = definePluginSettings({
    targetBitrate: {
        description: "Maximum screenshare bitrate in Mbps. Higher values need a fast, stable upload connection.",
        type: OptionType.SLIDER,
        markers: makeRange(1, 30, 1),
        default: 10,
        stickToMarkers: true,
        onChange: refreshConnections
    },
    lockMinBitrate: {
        description: "Keep the minimum bitrate at the target instead of adapting to network conditions. Disable this if viewers see stuttering or dropped frames.",
        type: OptionType.BOOLEAN,
        default: false,
        onChange: refreshConnections
    },
    boostCamera: {
        description: "Apply the same override to camera and voice connections as well as screenshares.",
        type: OptionType.BOOLEAN,
        default: false,
        onChange: refreshConnections
    },
    debugLogging: {
        description: "Log overridden media transport options to the developer console.",
        type: OptionType.BOOLEAN,
        default: false
    }
});

interface MediaConnection {
    conn?: {
        setTransportOptions?: (options: Record<string, any>) => any;
    };
    context?: string;
    emitter?: {
        off?: (event: string, listener: () => void) => void;
        on?: (event: string, listener: () => void) => void;
        removeListener?: (event: string, listener: () => void) => void;
    };
    mediaEngineConnectionId?: string;
    streamUserId?: string;
}

interface PatchRecord {
    connection: MediaConnection;
    onConnected: () => void;
    onDestroy: () => void;
    original: (options: Record<string, any>) => any;
    wrapped: (options: Record<string, any>) => any;
}

const patched = new Map<NonNullable<MediaConnection["conn"]>, PatchRecord>();
let engine: any;
let onConnection: ((connection: MediaConnection) => void) | undefined;

function getBitrateOverrides() {
    const target = settings.store.targetBitrate * 1_000_000;
    const minimum = settings.store.lockMinBitrate ? target : Math.min(target, 1_000_000);

    return {
        encodingVideoBitRate: target,
        encodingVideoMinBitRate: minimum,
        encodingVideoMaxBitRate: target,
        callBitRate: target,
        callMinBitRate: minimum,
        callMaxBitRate: target
    };
}

function applyToStreamParameters(options: Record<string, any>) {
    if (!options.streamParameters) return;

    const target = settings.store.targetBitrate * 1_000_000;
    const parameters = Array.isArray(options.streamParameters)
        ? options.streamParameters
        : [options.streamParameters];

    for (const parameter of parameters) {
        if (parameter && typeof parameter === "object") parameter.maxBitrate = target;
    }
}

function shouldBoost(connection: MediaConnection) {
    if (connection.context === "stream") {
        return connection.streamUserId === UserStore.getCurrentUser()?.id;
    }

    return settings.store.boostCamera;
}

function removeListener(connection: MediaConnection, event: string, listener: () => void) {
    connection.emitter?.off?.(event, listener);
    connection.emitter?.removeListener?.(event, listener);
}

function unpatchConnection(native: NonNullable<MediaConnection["conn"]>) {
    const record = patched.get(native);
    if (!record) return;

    removeListener(record.connection, "connected", record.onConnected);
    removeListener(record.connection, "destroy", record.onDestroy);

    if (native.setTransportOptions === record.wrapped) {
        native.setTransportOptions = record.original;
    }

    patched.delete(native);
}

function refreshConnections() {
    for (const [native, record] of [...patched]) {
        if (shouldBoost(record.connection)) record.wrapped(getBitrateOverrides());
        else unpatchConnection(native);
    }

    engine?.connections?.forEach?.(wrapConnection);
}

function wrapConnection(connection: MediaConnection) {
    try {
        if (!shouldBoost(connection)) return;

        const native = connection.conn;
        if (!native?.setTransportOptions || patched.has(native)) return;

        const original = native.setTransportOptions;
        const wrapped = (options: Record<string, any>) => {
            try {
                Object.assign(options, getBitrateOverrides());
                applyToStreamParameters(options);
                if (settings.store.debugLogging) logger.info("Overrode transport options", options);
            } catch (error) {
                logger.error("Failed to override transport options", error);
            }

            return original.call(native, options);
        };
        const onConnected = () => {
            try {
                wrapped(getBitrateOverrides());
                logger.info(`Applied ${settings.store.targetBitrate} Mbps target to ${connection.context} connection`);
            } catch (error) {
                logger.error("Failed to apply bitrate after connecting", error);
            }
        };
        const onDestroy = () => unpatchConnection(native);

        patched.set(native, { connection, onConnected, onDestroy, original, wrapped });
        native.setTransportOptions = wrapped;
        connection.emitter?.on?.("connected", onConnected);
        connection.emitter?.on?.("destroy", onDestroy);

        logger.info(`Hooked ${connection.context} connection`, connection.mediaEngineConnectionId);
    } catch (error) {
        logger.error("Failed to hook connection", error);
    }
}

export default definePlugin({
    name: "StreamBitrateBooster",
    description: "Raises the target bitrate for your screenshares, with an optional minimum-bitrate lock.",
    authors: [Devs.zerohq],
    tags: ["Voice", "Utility"],
    searchTerms: ["screenshare", "stream", "bitrate"],
    enabledByDefault: true,
    settings,

    start() {
        engine = (MediaEngineStore as any).getMediaEngine();
        if (!engine) {
            logger.error("Discord's media engine is unavailable");
            return;
        }

        onConnection = wrapConnection;
        engine.emitter?.on?.("connection", onConnection);
        engine.connections?.forEach?.(wrapConnection);
    },

    stop() {
        if (engine && onConnection) {
            engine.emitter?.off?.("connection", onConnection);
            engine.emitter?.removeListener?.("connection", onConnection);
        }

        for (const native of [...patched.keys()]) unpatchConnection(native);

        engine = undefined;
        onConnection = undefined;
    }
});
