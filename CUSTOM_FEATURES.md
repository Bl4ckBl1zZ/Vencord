# Custom notification features

This fork enables two focused communication-safety features by default.

## User stories

- As a Discord user browsing another channel, I want a small top-right notification for messages Discord considers important so I can notice them without leaving my current context.
- As a privacy-conscious user, I want to hide message previews while retaining sender and channel context.
- As a user in busy servers, I want mute rules, current-channel suppression, and bot filtering to prevent notification fatigue.
- As a user who receives a notification, I want one click to open the conversation and an obvious close action when I do not want to navigate.
- As a user following a conversation, I want deleted messages to remain in place and turn red so I understand what disappeared without losing the thread's chronology.
- As a moderator or power user, I want ignore lists and clear-history actions so temporary logging remains controllable.

## UX decisions

The notification card uses the existing Vencord notification lifecycle for hover-to-pause, keyboard focus, timed dismissal, and reduced-motion support. It is compact and fixed to the top-right, with sender, preview, and context ordered by importance. Notifications are intentionally limited to focused Discord sessions; native Discord notifications continue to handle background activity.

Deleted messages reuse Vencord's session-only MessageLogger instead of creating a second message cache. Red text is the default because it is visible without shifting the message layout; a red overlay remains available for users who prefer a stronger treatment.

## Build delivery

Every push to `main` runs Vencord's standalone web and desktop builds. The workflow uploads a 14-day GitHub Actions artifact and updates the fork's `fork-devbuild` release, providing both traceable CI output and a stable download location.
