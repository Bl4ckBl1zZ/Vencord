/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyWithToast } from "@utils/discord";
import { Button, Forms, React, TextInput, useEffect, useState } from "@webpack/common";

import {
    finishPerformanceCapture,
    getCaptureState,
    markStutter,
    showLastCase,
    startPerformanceCapture,
    subscribeCaptureState
} from "./capture";
import { settings } from "./settings";

export function PerformanceDoctorPanel() {
    const [label, setLabel] = useState("Scroll or interact until the stutter occurs");
    const [state, setState] = useState(getCaptureState);

    useEffect(() => {
        const update = () => setState(getCaptureState());
        const unsubscribe = subscribeCaptureState(update);
        const timer = window.setInterval(update, 500);
        return () => {
            unsubscribe();
            window.clearInterval(timer);
        };
    }, []);

    const status = state.finishing
        ? "Exporting trace…"
        : state.active
            ? `Capturing ${(state.elapsedMs / 1000).toFixed(1)} / ${settings.store.captureDuration}s`
            : "Ready";

    return (
        <section className="vc-performance-doctor">
            <div className="vc-performance-doctor-header">
                <div>
                    <Forms.FormTitle tag="h3">Performance Doctor</Forms.FormTitle>
                    <Forms.FormText>
                        Capture one repeatable user story. The report excludes message content and Discord identifiers; raw Chromium traces can still contain URLs and should stay local until reviewed.
                    </Forms.FormText>
                </div>
                <span className={state.active ? "vc-performance-doctor-status vc-performance-doctor-status-active" : "vc-performance-doctor-status"}>
                    {status}
                </span>
            </div>

            <div className="vc-performance-doctor-metrics">
                <div><strong>{state.recentLongFrames}</strong><span>Long frames · 30s</span></div>
                <div><strong>{state.recentWorstFrame} ms</strong><span>Worst recent frame</span></div>
                <div><strong>{settings.store.chromiumTrace ? "On" : "Off"}</strong><span>Chromium trace</span></div>
            </div>

            <Forms.FormTitle tag="h4">Reproduction story</Forms.FormTitle>
            <TextInput
                value={label}
                onChange={setLabel}
                disabled={state.active || state.finishing}
                placeholder="Example: Scroll a media-heavy channel while streaming 1440p30"
                maxLength={180}
            />

            <div className="vc-performance-doctor-actions">
                {!state.active ? (
                    <Button
                        color={Button.Colors.BRAND}
                        disabled={state.finishing}
                        onClick={() => startPerformanceCapture(label)}
                    >
                        Start capture
                    </Button>
                ) : (
                    <>
                        <Button color={Button.Colors.RED} onClick={markStutter}>
                            Mark stutter
                        </Button>
                        <Button color={Button.Colors.PRIMARY} onClick={finishPerformanceCapture}>
                            Stop & export
                        </Button>
                    </>
                )}

                {state.lastCaseFolder && (
                    <Button color={Button.Colors.PRIMARY} onClick={showLastCase}>
                        Show last case
                    </Button>
                )}
                {state.lastReport && (
                    <Button color={Button.Colors.PRIMARY} onClick={() => copyWithToast(state.lastReport!, "Performance report copied!")}>
                        Copy LLM report
                    </Button>
                )}
            </div>

            {state.error && <div className="vc-performance-doctor-error">{state.error}</div>}
            {state.lastCaseFolder && (
                <div className="vc-performance-doctor-path" title={state.lastCaseFolder}>
                    Last case: {state.lastCaseFolder}
                </div>
            )}
        </section>
    );
}
