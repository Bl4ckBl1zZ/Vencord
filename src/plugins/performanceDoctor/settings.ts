/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    captureDuration: {
        type: OptionType.SLIDER,
        description: "Default capture length in seconds. You can still stop a capture early.",
        default: 15,
        markers: [10, 15, 30, 60],
        stickToMarkers: true
    },
    rollingWindow: {
        type: OptionType.SLIDER,
        description: "Seconds of low-overhead frame history to include before capture starts.",
        default: 10,
        markers: [5, 10, 20, 30],
        stickToMarkers: true
    },
    chromiumTrace: {
        type: OptionType.BOOLEAN,
        description: "Record a multi-process Chromium trace for renderer, GPU, IPC, and Electron diagnosis.",
        default: true
    },
    autoMarkLongFrames: {
        type: OptionType.BOOLEAN,
        description: "Add trace markers for frames that take at least 100 ms.",
        default: true
    }
});
