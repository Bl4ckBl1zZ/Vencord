/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Settings } from "@api/Settings";
import { createRoot } from "@webpack/common";
import type { MouseEvent, ReactNode } from "react";

import NotificationComponent from "./NotificationComponent";
import { persistNotification } from "./notificationLog";

let id = 42;

function getStack(position: "top-right" | "bottom-right") {
    const id = `vc-notification-container-${position}`;
    let container = document.getElementById(id);

    if (!container) {
        container = document.createElement("div");
        container.id = id;
        container.className = `vc-notification-stack vc-notification-stack-${position}`;
        container.setAttribute("aria-live", "polite");
        container.setAttribute("aria-label", "Notifications");
        document.body.append(container);
    }

    return container;
}

export interface NotificationData {
    title: string;
    body: string;
    /** Optional class name for custom in-app notification presentation */
    className?: string;
    /** Override the global in-app notification position */
    position?: "top-right" | "bottom-right";
    /** Always use Vencord's in-app notification, even when native notifications are enabled */
    forceInApp?: boolean;
    /**
     * Same as body but can be a custom component.
     * Will be used over body if present.
     * Not supported on desktop notifications, those will fall back to body */
    richBody?: ReactNode;
    /** Small icon. This is for things like profile pictures and should be square */
    icon?: string;
    /** Large image. Optimally, this should be around 16x9 but it doesn't matter much. Desktop Notifications might not support this */
    image?: string;
    onClick?(): void;
    /** Handle a right click on the in-app notification instead of dismissing it */
    onContextMenu?(event: MouseEvent<HTMLElement>): void;
    onClose?(): void;
    color?: string;
    /** Whether this notification should not have a timeout */
    permanent?: boolean;
    /** Whether this notification should not be persisted in the Notification Log */
    noPersist?: boolean;
    /** Whether this notification should be dismissed when clicked (defaults to true) */
    dismissOnClick?: boolean;
    /** Render a non-button root so rich bodies can contain inputs and other controls */
    interactive?: boolean;
}

function _showNotification(notification: NotificationData, id: number) {
    const position = notification.position ?? Settings.notifications.position;
    const stack = getStack(position);
    const item = document.createElement("div");
    item.className = "vc-notification-stack-item";
    item.dataset.notificationId = String(id);
    stack.append(item);

    const root = createRoot(item);

    return new Promise<void>(resolve => {
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            notification.onClose?.();

            queueMicrotask(() => {
                root.unmount();
                item.remove();
                resolve();
            });
        };

        root.render(
            <NotificationComponent key={id} {...notification} onClose={close} />,
        );
    });
}

function shouldBeNative() {
    if (typeof Notification === "undefined") return false;

    const { useNative } = Settings.notifications;
    if (useNative === "always") return true;
    if (useNative === "not-focused") return !document.hasFocus();
    return false;
}

export async function requestPermission() {
    return (
        Notification.permission === "granted" ||
        (Notification.permission !== "denied" && (await Notification.requestPermission()) === "granted")
    );
}

export async function showNotification(data: NotificationData) {
    persistNotification(data);

    if (!data.forceInApp && shouldBeNative() && await requestPermission()) {
        const { title, body, icon, image, onClick = null, onClose = null } = data;
        const n = new Notification(title, {
            body,
            icon,
            // @ts-expect-error ts is drunk
            image
        });
        n.onclick = onClick;
        n.onclose = onClose;
    } else {
        void _showNotification(data, id++);
    }
}
