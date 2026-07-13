/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { getIntlMessage, sendMessage } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, Emoji, Message, MessageAttachment, MessageJSON, MessageReaction, ReactionEmoji } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import { findByCodeLazy } from "@webpack";
import {
    Button,
    ChannelRouter,
    ChannelStore,
    ContextMenuApi,
    EmojiStore,
    GuildRoleStore,
    GuildStore,
    MessageActions,
    MessageStore,
    Parser,
    React,
    RestAPI,
    SelectedChannelStore,
    UserStore,
    useState,
    useStateFromStores
} from "@webpack/common";

type NotificationEmbed = {
    id?: string;
    url?: string;
    type?: string;
    title?: string;
    rawTitle?: string;
    description?: string;
    rawDescription?: string;
    color?: string | number;
    author?: { name?: string; url?: string; iconURL?: string; icon_url?: string; };
    provider?: { name?: string; url?: string; };
    footer?: { text?: string; iconURL?: string; icon_url?: string; };
    image?: EmbedMedia;
    thumbnail?: EmbedMedia;
    video?: EmbedMedia;
    fields?: Array<{ rawName?: string; name?: string; rawValue?: string; value?: string; inline?: boolean; }>;
};

type EmbedMedia = {
    url?: string;
    proxyURL?: string;
    proxy_url?: string;
    contentType?: string;
    content_type?: string;
    width?: number;
    height?: number;
    description?: string;
};

type NotificationMessage = MessageJSON & {
    author: MessageJSON["author"] & { bot?: boolean; system?: boolean; };
    embeds: NotificationEmbed[];
    reactions?: MessageReaction[];
    sticker_items?: { id: string; name: string; format_type?: number; }[];
};

type DisplayMessage = NotificationMessage | Message;

const notificationsShouldNotify = findByCodeLazy(".SUPPRESS_NOTIFICATIONS))return!1") as (
    message: NotificationMessage,
    channelId: string
) => boolean;
const useMessageMenu = findByCodeLazy(".MESSAGE,commandTargetId:");

const settings = definePluginSettings({
    showMessageContent: {
        type: OptionType.BOOLEAN,
        description: "Show message text and rich previews in notifications. Disable this for extra privacy.",
        default: true
    },
    showAttachments: {
        type: OptionType.BOOLEAN,
        description: "Show image, video, audio, and file attachment previews.",
        default: true
    },
    showEmbeds: {
        type: OptionType.BOOLEAN,
        description: "Show Discord embeds and previews for links.",
        default: true
    },
    showQuickReactions: {
        type: OptionType.BOOLEAN,
        description: "Show your recently used reactions when you hover a notification.",
        default: true
    },
    inlineReply: {
        type: OptionType.BOOLEAN,
        description: "Show a direct reply field when you hover a notification.",
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

function getAuthorName(message: DisplayMessage) {
    return message.author.globalName || message.author.username;
}

function getContext(message: DisplayMessage) {
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

function formatFileSize(bytes: number) {
    if (!Number.isFinite(bytes) || bytes < 1) return "File";
    const units = ["B", "KB", "MB", "GB"];
    const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** unit;
    return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function mediaKind(attachment: MessageAttachment) {
    const type = attachment.content_type?.toLowerCase() ?? "";
    if (type.startsWith("image/")) return "image";
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";

    const extension = attachment.filename.split(".").pop()?.toLowerCase();
    if (["apng", "avif", "gif", "jpeg", "jpg", "png", "webp"].includes(extension ?? "")) return "image";
    if (["m4v", "mov", "mp4", "webm"].includes(extension ?? "")) return "video";
    if (["flac", "m4a", "mp3", "ogg", "wav"].includes(extension ?? "")) return "audio";
    return "file";
}

function FileIcon() {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M6 2h7l5 5v15H6V2Zm7 1.8V8h4.2L13 3.8ZM8 12v2h8v-2H8Zm0 4v2h6v-2H8Z" />
        </svg>
    );
}

function AttachmentPreview({ attachment }: { attachment: MessageAttachment; }) {
    const [revealed, setRevealed] = useState(!attachment.spoiler);
    const kind = mediaKind(attachment);
    const url = attachment.proxy_url || attachment.url;
    const stopClick = (event: React.MouseEvent) => event.stopPropagation();

    if (kind === "file") {
        return (
            <a
                className="vc-in-app-notification-file"
                href={attachment.url}
                target="_blank"
                rel="noreferrer"
                onClick={stopClick}
                title={attachment.filename}
            >
                <span className="vc-in-app-notification-file-icon"><FileIcon /></span>
                <span className="vc-in-app-notification-file-copy">
                    <span className="vc-in-app-notification-file-name">{attachment.filename}</span>
                    <span className="vc-in-app-notification-file-meta">{formatFileSize(attachment.size)}</span>
                </span>
                <span className="vc-in-app-notification-download" aria-hidden="true">↓</span>
            </a>
        );
    }

    return (
        <div className={`vc-in-app-notification-media vc-in-app-notification-media-${kind}`} onClick={stopClick}>
            {kind === "image" && (
                <a href={attachment.url} target="_blank" rel="noreferrer" onClick={stopClick}>
                    <img
                        className={revealed ? "" : "vc-in-app-notification-spoiler-media"}
                        src={url}
                        alt={attachment.filename}
                        loading="lazy"
                    />
                </a>
            )}
            {kind === "video" && (
                <video
                    className={revealed ? "" : "vc-in-app-notification-spoiler-media"}
                    src={url}
                    controls={revealed}
                    muted
                    preload="metadata"
                />
            )}
            {kind === "audio" && (
                <div className={revealed ? "vc-in-app-notification-audio" : "vc-in-app-notification-audio vc-in-app-notification-spoiler-media"}>
                    <span title={attachment.filename}>{attachment.filename}</span>
                    <audio src={url} controls={revealed} preload="metadata" />
                </div>
            )}
            {!revealed && (
                <button
                    className="vc-in-app-notification-spoiler"
                    onClick={event => {
                        event.stopPropagation();
                        setRevealed(true);
                    }}
                >
                    SPOILER
                </button>
            )}
        </div>
    );
}

function getMediaUrl(media?: EmbedMedia) {
    return media?.proxyURL || media?.proxy_url || media?.url;
}

function getEmbedColor(color?: string | number) {
    if (typeof color === "number") return `#${color.toString(16).padStart(6, "0")}`;
    if (!color) return undefined;
    return color.startsWith("#") ? color : `#${color}`;
}

function EmbedPreview({ embed, channelId, messageId }: { embed: NotificationEmbed; channelId: string; messageId: string; }) {
    const title = embed.rawTitle || embed.title;
    const description = embed.rawDescription || embed.description;
    const image = getMediaUrl(embed.image);
    const thumbnail = getMediaUrl(embed.thumbnail);
    const video = getMediaUrl(embed.video);
    const videoType = embed.video?.contentType || embed.video?.content_type || "";
    const canPlayVideo = video && (videoType.startsWith("video/") || /\.(mp4|webm)(?:$|\?)/i.test(video));
    const stopClick = (event: React.MouseEvent) => event.stopPropagation();
    const parserOptions = { channelId, messageId, allowLinks: true, allowEmojiLinks: true };
    const hasCardCopy = embed.provider?.name || embed.author?.name || title || description || embed.fields?.length;

    if (!hasCardCopy && image) {
        return (
            <a className="vc-in-app-notification-embed-image-only" href={embed.url || image} target="_blank" rel="noreferrer" onClick={stopClick}>
                <img src={image} alt={embed.image?.description || "Embedded image"} loading="lazy" />
            </a>
        );
    }

    return (
        <div
            className="vc-in-app-notification-embed"
            style={{ borderLeftColor: getEmbedColor(embed.color) }}
            onClick={event => {
                if ((event.target as Element).closest("a, video")) event.stopPropagation();
            }}
        >
            <div className="vc-in-app-notification-embed-layout">
                <div className="vc-in-app-notification-embed-copy">
                    {(embed.provider?.name || embed.author?.name) && (
                        <p className="vc-in-app-notification-embed-provider">
                            {embed.provider?.name || embed.author?.name}
                        </p>
                    )}
                    {title && (embed.url ? (
                        <a className="vc-in-app-notification-embed-title" href={embed.url} target="_blank" rel="noreferrer" onClick={stopClick}>
                            {title}
                        </a>
                    ) : <p className="vc-in-app-notification-embed-title">{title}</p>)}
                    {description && (
                        <div className="vc-in-app-notification-embed-description">
                            {Parser.parse(description, true, parserOptions)}
                        </div>
                    )}
                    {embed.fields?.slice(0, 3).map((field, index) => (
                        <div className="vc-in-app-notification-embed-field" key={`${field.rawName || field.name}-${index}`}>
                            <strong>{field.rawName || field.name}</strong>
                            <span>{Parser.parse(field.rawValue || field.value || "", true, parserOptions)}</span>
                        </div>
                    ))}
                </div>
                {thumbnail && <img className="vc-in-app-notification-embed-thumbnail" src={thumbnail} alt="" loading="lazy" />}
            </div>
            {image && <img className="vc-in-app-notification-embed-media" src={image} alt={embed.image?.description || "Embedded image"} loading="lazy" />}
            {canPlayVideo && <video className="vc-in-app-notification-embed-media" src={video} controls muted preload="metadata" />}
            {embed.footer?.text && <p className="vc-in-app-notification-embed-footer">{embed.footer.text}</p>}
        </div>
    );
}

function getStickerItems(message: DisplayMessage) {
    return "stickerItems" in message ? message.stickerItems : message.sticker_items ?? [];
}

function emojiText(emoji: Emoji | ReactionEmoji) {
    if ("surrogates" in emoji) return emoji.optionallyDiverseSequence || emoji.surrogates;
    return emoji.name;
}

function emojiRoute(emoji: Emoji | ReactionEmoji) {
    const value = emoji.id ? `${emoji.name}:${emoji.id}` : emojiText(emoji);
    return encodeURIComponent(value);
}

function emojiMatches(left: Emoji | ReactionEmoji, right: ReactionEmoji) {
    return left.id ? left.id === right.id : emojiText(left) === right.name;
}

function EmojiVisual({ emoji }: { emoji: Emoji | ReactionEmoji; }) {
    if (emoji.id) {
        return (
            <img
                src={`https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "webp"}?size=48&quality=lossless`}
                alt={`:${emoji.name}:`}
            />
        );
    }

    return <span>{emojiText(emoji)}</span>;
}

async function toggleReaction(message: DisplayMessage, emoji: Emoji | ReactionEmoji, remove: boolean) {
    const url = `/channels/${message.channel_id}/messages/${message.id}/reactions/${emojiRoute(emoji)}/@me`;
    await (remove ? RestAPI.del : RestAPI.put)({ url });
}

function ReactionControls({ message, channel }: { message: DisplayMessage; channel: Channel; }) {
    const [pending, setPending] = useState<string | null>(null);
    const reactions = message.reactions ?? [];
    const recent = settings.store.showQuickReactions
        ? EmojiStore.getDisambiguatedEmojiContext(channel.guild_id).getFrequentlyUsedReactionEmojisWithoutFetchingLatest().slice(0, 4)
        : [];

    const react = async (emoji: Emoji | ReactionEmoji, remove: boolean) => {
        const key = emoji.id || emojiText(emoji);
        if (pending === key) return;
        setPending(key);
        try {
            await toggleReaction(message, emoji, remove);
        } finally {
            setPending(null);
        }
    };

    return (
        <>
            {!!reactions.length && (
                <div className="vc-in-app-notification-reactions" aria-label="Message reactions" onClick={event => event.stopPropagation()}>
                    {reactions.map(reaction => (
                        <button
                            className={reaction.me ? "vc-in-app-notification-reaction vc-in-app-notification-reaction-me" : "vc-in-app-notification-reaction"}
                            key={reaction.emoji.id || reaction.emoji.name}
                            onClick={() => react(reaction.emoji, reaction.me)}
                            disabled={pending === (reaction.emoji.id || reaction.emoji.name)}
                            title={`${reaction.emoji.name} · ${reaction.count}`}
                        >
                            <EmojiVisual emoji={reaction.emoji} />
                            <span>{reaction.count}</span>
                        </button>
                    ))}
                </div>
            )}
            {!!recent.length && (
                <div className="vc-in-app-notification-quick-reactions" aria-label="Recently used reactions" onClick={event => event.stopPropagation()}>
                    <span className="vc-in-app-notification-quick-label">React</span>
                    {recent.map(emoji => {
                        const existing = reactions.find(reaction => emojiMatches(emoji, reaction.emoji));
                        const key = emoji.id || emojiText(emoji);
                        return (
                            <button
                                className={existing?.me ? "vc-in-app-notification-quick-reaction vc-in-app-notification-quick-reaction-me" : "vc-in-app-notification-quick-reaction"}
                                key={key}
                                onClick={() => react(emoji, existing?.me === true)}
                                disabled={pending === key}
                                title={`${existing?.me ? "Remove" : "Add"} :${emoji.name}:`}
                            >
                                <EmojiVisual emoji={emoji} />
                            </button>
                        );
                    })}
                </div>
            )}
        </>
    );
}

function ReplyField({ message, channel }: { message: DisplayMessage; channel: Channel; }) {
    const [content, setContent] = useState("");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState(false);

    const submit = async () => {
        const trimmed = content.trim();
        if (!trimmed || sending) return;

        setSending(true);
        setError(false);
        try {
            const storedMessage = MessageStore.getMessage(message.channel_id, message.id) ?? message;
            const options = MessageActions.getSendMessageOptionsForReply({
                channel,
                message: storedMessage as Message,
                shouldMention: true,
                showMentionToggle: true
            });
            await sendMessage(channel.id, { content: trimmed }, true, options);
            setContent("");
        } catch {
            setError(true);
        } finally {
            setSending(false);
        }
    };

    return (
        <form
            className={error ? "vc-in-app-notification-reply vc-in-app-notification-reply-error" : "vc-in-app-notification-reply"}
            onSubmit={event => {
                event.preventDefault();
                event.stopPropagation();
                submit();
            }}
            onClick={event => event.stopPropagation()}
            onContextMenu={event => event.stopPropagation()}
        >
            <textarea
                value={content}
                rows={1}
                aria-label={`Reply to ${getAuthorName(message)}`}
                placeholder={error ? "Could not send — try again" : `Reply to ${getAuthorName(message)}`}
                onChange={event => {
                    setContent(event.currentTarget.value);
                    setError(false);
                }}
                onKeyDown={event => {
                    if (event.key !== "Enter" || event.shiftKey) return;
                    event.preventDefault();
                    submit();
                }}
            />
            <button type="submit" disabled={!content.trim() || sending} aria-label="Send reply" title="Send reply">
                {sending ? "…" : "↗"}
            </button>
        </form>
    );
}

function MessageNotificationBody({ fallback, preview, context }: { fallback?: NotificationMessage; preview: string; context: string; }) {
    const liveMessage = useStateFromStores(
        [MessageStore],
        () => fallback ? MessageStore.getMessage(fallback.channel_id, fallback.id) : undefined,
        [fallback?.channel_id, fallback?.id]
    );
    const message = (liveMessage ?? fallback) as DisplayMessage | undefined;
    const channel = message ? ChannelStore.getChannel(message.channel_id) : undefined;
    const showRichContent = !!message && settings.store.showMessageContent;
    const stickers = message ? getStickerItems(message) : [];

    return (
        <div className="vc-in-app-notification-body">
            {showRichContent && message.content ? (
                <div
                    className="vc-in-app-notification-content"
                    onClick={event => {
                        if ((event.target as Element).closest("a, button")) event.stopPropagation();
                    }}
                >
                    {Parser.parse(message.content, true, {
                        channelId: message.channel_id,
                        messageId: message.id,
                        allowLinks: true,
                        allowHeading: true,
                        allowList: true,
                        allowEmojiLinks: true
                    })}
                </div>
            ) : <p className="vc-in-app-notification-preview">{preview}</p>}
            <p className="vc-in-app-notification-context">{context}</p>

            {showRichContent && settings.store.showAttachments && !!message.attachments.length && (
                <div className="vc-in-app-notification-attachments">
                    {message.attachments.map(attachment => <AttachmentPreview attachment={attachment} key={attachment.id} />)}
                </div>
            )}

            {showRichContent && settings.store.showAttachments && !!stickers.length && (
                <div className="vc-in-app-notification-stickers">
                    {stickers.map(sticker => (
                        <img
                            src={`https://media.discordapp.net/stickers/${sticker.id}.webp?size=160`}
                            alt={sticker.name}
                            title={sticker.name}
                            loading="lazy"
                            key={sticker.id}
                        />
                    ))}
                </div>
            )}

            {showRichContent && settings.store.showEmbeds && !!message.embeds.length && (
                <div className="vc-in-app-notification-embeds">
                    {(message.embeds as NotificationEmbed[]).map((embed, index) => (
                        <EmbedPreview embed={embed} channelId={message.channel_id} messageId={message.id} key={embed.id || `${embed.url}-${index}`} />
                    ))}
                </div>
            )}

            {message && channel && <ReactionControls message={message} channel={channel} />}
            {message && channel && settings.store.inlineReply && <ReplyField message={message} channel={channel} />}
        </div>
    );
}

function MessageMenu({ message, channel, onHeightUpdate }: { message: Message; channel: Channel; onHeightUpdate?: () => void; }) {
    const canReport = message.author && !(message.author.id === UserStore.getCurrentUser()?.id || message.author.system);

    return useMessageMenu({
        navId: "message-actions",
        ariaLabel: getIntlMessage("MESSAGE_UTILITIES_A11Y_LABEL"),
        message,
        channel,
        canReport,
        onHeightUpdate,
        onClose: () => ContextMenuApi.closeContextMenu(),
        textSelection: "",
        favoriteableType: null,
        favoriteableId: null,
        favoriteableName: null,
        itemHref: void 0,
        itemSrc: void 0,
        itemSafeSrc: void 0,
        itemTextContent: void 0,
        isFullSearchContextMenu: true
    });
}

function openMessageContextMenu(event: React.MouseEvent<HTMLElement>, fallback: NotificationMessage) {
    const channel = ChannelStore.getChannel(fallback.channel_id);
    const message = (MessageStore.getMessage(fallback.channel_id, fallback.id) ?? fallback) as Message;
    if (!channel || !message) return;

    ContextMenuApi.openContextMenu(event, props => (
        <MessageMenu message={message} channel={channel} onHeightUpdate={props.onHeightUpdate} />
    ));
}

function displayNotification(message: NotificationMessage) {
    const author = UserStore.getUser(message.author.id);
    const preview = getPreview(message);
    const context = getContext(message);

    showNotification({
        title: getAuthorName(message),
        body: `${preview} — ${context}`,
        richBody: <MessageNotificationBody fallback={message} preview={preview} context={context} />,
        icon: author?.getAvatarURL(ChannelStore.getChannel(message.channel_id)?.guild_id, 128, false),
        color: "var(--brand-500)",
        className: "vc-in-app-notification",
        position: "top-right",
        forceInApp: true,
        noPersist: true,
        interactive: true,
        onClick: () => ChannelRouter.transitionToChannel(message.channel_id),
        onContextMenu: event => openMessageContextMenu(event, message)
    });
}

function showTestNotification() {
    const currentUser = UserStore.getCurrentUser();
    const preview = settings.store.showMessageContent
        ? "This is how message text and clickable links will look: https://discord.com"
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
        noPersist: true,
        interactive: true
    });
}

export default definePlugin({
    name: "InAppNotifications",
    description: "Shows interactive Discord message notifications with media, embeds, reactions, and replies.",
    authors: [Devs.Bl4ckBl1zZ],
    tags: ["Notifications", "Appearance"],
    searchTerms: ["toast", "popup", "message", "reply", "attachment", "embed"],
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
