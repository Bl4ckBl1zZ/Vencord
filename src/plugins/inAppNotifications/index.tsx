/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import type { MessageJSON } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import { findByCodeLazy } from "@webpack";
import { Button, ChannelRouter, ChannelStore, GuildRoleStore, GuildStore, SelectedChannelStore, UserStore } from "@webpack/common";

type NotificationMessage = MessageJSON & {
    author: MessageJSON["author"] & { bot?: boolean; };
    sticker_items?: { name: string; }[];
};

const notificationsShouldNotify = findByCodeLazy(".SUPPRESS_NOTIFICATIONS))return!1") as (
    message: NotificationMessage,
    channelId: string
) => boolean;

const settings = definePluginSettings({
    showMessageContent: {
        type: OptionType.BOOLEAN,
        description: "Show a short message preview in notifications. Disable this for extra privacy.",
        default: true
    },
    showCurrentChannel: {
        type: OptionType.BOOLEAN,
        description: "Show notifications for the channel you are currently viewing.",
        default: false
    },
    showBotMessages: {
        type: OptionType.BOOLEAN,
        description: "Allow notifications from bots when they match your Discord notification settings.",
        default: true
    }
});

function getAuthorName(message: NotificationMessage) {
    return message.author.globalName || message.author.username;
}

function getContext(message: NotificationMessage) {
    const channel = ChannelStore.getChannel(message.channel_id);
    if (!channel) return "Unknown channel";

    if (channel.type === ChannelType.DM) return "Direct message";
    if (channel.type === ChannelType.GROUP_DM) return channel.name || "Group direct message";

    const guildName = GuildStore.getGuild(channel.guild_id)?.name;
    const channelName = channel.name ? `#${channel.name}` : "Server channel";
    return guildName ? `${guildName} · ${channelName}` : channelName;
}

function replaceMentions(content: string, message: NotificationMessage) {
    const channel = ChannelStore.getChannel(message.channel_id);

    return content
        .replace(/<@!?(\d+)>/g, (_, id: string) => {
            const mentioned = message.mentions.find(user => user.id === id) ?? UserStore.getUser(id);
            return `@${mentioned?.globalName || mentioned?.username || "unknown-user"}`;
        })
        .replace(/<#(\d+)>/g, (_, id: string) => `#${ChannelStore.getChannel(id)?.name || "unknown-channel"}`)
        .replace(/<@&(\d+)>/g, (_, id: string) => `@${GuildRoleStore.getRole(channel?.guild_id, id)?.name || "unknown-role"}`)
        .replace(/<a?:([^:>]+):\d+>/g, ":$1:")
        .replace(/\s+/g, " ")
        .trim();
}

function getPreview(message: NotificationMessage) {
    if (!settings.store.showMessageContent) return "New message";

    let preview = replaceMentions(message.content, message);
    const additions: string[] = [];

    if (message.attachments.length) {
        const count = message.attachments.length;
        additions.push(`${count} attachment${count === 1 ? "" : "s"}`);
    }
    if (message.sticker_items?.length) additions.push("sticker");
    if (message.embeds.length && !preview) additions.push("embed");

    if (additions.length) preview = [preview, additions.join(" · ")].filter(Boolean).join(" — ");
    if (!preview) preview = "Sent a message";

    return preview.length > 220 ? `${preview.slice(0, 219).trimEnd()}…` : preview;
}

function MessageNotificationBody({ preview, context }: { preview: string; context: string; }) {
    return (
        <div className="vc-in-app-notification-body">
            <p className="vc-in-app-notification-preview">{preview}</p>
            <p className="vc-in-app-notification-context">{context}</p>
        </div>
    );
}

function displayNotification(message: NotificationMessage) {
    const author = UserStore.getUser(message.author.id);
    const preview = getPreview(message);
    const context = getContext(message);

    showNotification({
        title: getAuthorName(message),
        body: `${preview} — ${context}`,
        richBody: <MessageNotificationBody preview={preview} context={context} />,
        icon: author?.getAvatarURL(ChannelStore.getChannel(message.channel_id)?.guild_id, 128, false),
        color: "var(--brand-500)",
        className: "vc-in-app-notification",
        position: "top-right",
        forceInApp: true,
        noPersist: true,
        onClick: () => ChannelRouter.transitionToChannel(message.channel_id)
    });
}

function showTestNotification() {
    const currentUser = UserStore.getCurrentUser();
    const preview = settings.store.showMessageContent
        ? "This is how a new message will look. Click a real notification to open its conversation."
        : "New message";
    const context = "Notification preview · #general";

    showNotification({
        title: currentUser?.globalName || currentUser?.username || "Message sender",
        body: `${preview} — ${context}`,
        richBody: <MessageNotificationBody preview={preview} context={context} />,
        icon: currentUser?.getAvatarURL(undefined, 128, false),
        color: "var(--brand-500)",
        className: "vc-in-app-notification",
        position: "top-right",
        forceInApp: true,
        noPersist: true
    });
}

export default definePlugin({
    name: "InAppNotifications",
    description: "Shows compact Discord message notifications in the top-right while you use Discord.",
    authors: [Devs.Bl4ckBl1zZ],
    tags: ["Notifications", "Appearance"],
    searchTerms: ["toast", "popup", "message"],
    enabledByDefault: true,
    settings,

    flux: {
        MESSAGE_CREATE({ message, optimistic }: { message: NotificationMessage; optimistic: boolean; }) {
            if (optimistic || !document.hasFocus()) return;
            if (message.author.id === UserStore.getCurrentUser()?.id) return;
            if (message.author.bot && !settings.store.showBotMessages) return;
            if (!settings.store.showCurrentChannel && SelectedChannelStore.getChannelId() === message.channel_id) return;
            if (!notificationsShouldNotify(message, message.channel_id)) return;

            displayNotification(message);
        }
    },

    settingsAboutComponent: () => (
        <Button onClick={showTestNotification}>
            Preview notification
        </Button>
    )
});
