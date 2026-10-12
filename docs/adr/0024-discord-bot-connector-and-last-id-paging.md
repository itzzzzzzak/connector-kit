# ADR-024: The Discord connector acts as a bot, and lists page by the last id

- Status: accepted
- Date: 2026-10-12

## Problem
Discord lists are bare JSON arrays with no "more" flag and no cursor. A page is continued by sending the id of its last item back as `before` (newest first, channel messages) or `after` (oldest first, members, bans). None of the existing strategies fit: `lastItemPagination` wants an object with a `has_more` flag. Discord also has two kinds of tokens that look the same on the wire but are sent differently (`Bot <token>` for bots, `Bearer <token>` for OAuth users), and it accepts mentions in any message by default.

## Alternatives considered
- Cover bot and user OAuth in one connector. Rejected: the header prefix depends on the token type, and the kit's `rawTokenPattern` (ADR-021) only switches between "bare" and "Bearer". User OAuth in Discord is mostly sign-in (`identify`, `guilds`), which a host does not need a connector for.
- Treat a page as complete when it is short and leave a full page to the caller. Rejected: the caller cannot tell a full page from the last one without knowing the page size the kit chose.

## Decision
- `lastIdPagination({ cursorParam: "before" | "after", idKey? })`: the body is the list; a page with as many items as the request asked for continues from its last item's id (`idKey` may be dotted, `user.id` for guild members); a short or empty page ends the listing.
- The connector authenticates with `Authorization: Bot <token>` and sends the descriptive `User-Agent` Discord requires.
- `messages.send` and `message.edit` set `allowed_mentions: { parse: [] }` unless the caller passes `allowMentions: true`, so a model cannot ping `@everyone`, a role or a user by accident. This is a safe default chosen for agents; a host that wants pings opts in per call.
- The generator takes `destructiveIds`, a pattern tested against the operation id of non-GET calls (`create_guild_ban`, `bulk_delete_messages`), because Discord's verb is not first. Kick, ban and prune are marked destructive and the conformance check accepts "ban", "kick" and "prun" as words for something destroyed.
- Not covered: file uploads (multipart), the real-time gateway, voice, and acting as a user.

## Why
It is a small, general strategy plus two safety defaults, and it keeps the generated 230 calls consistent with the hand-written ones.

## Trade-offs
A listing whose last page is exactly full costs one extra request that returns an empty page. The mention default means a message that is supposed to ping needs `allowMentions`.

## When we may revisit
User-OAuth tokens (a second auth type per connector), and the Gateway for events.
