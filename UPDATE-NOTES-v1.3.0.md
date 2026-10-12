# WCRP Utilities v1.3.1 — Update Notes

## Permissions and access
- Removed the blanket command-role lock that could leave ordinary staff commands inaccessible when no `/permissions set` role was configured.
- `/global ban`, `/global kick`, and `/global timeout` remain restricted to the configured Global Moderation Access role in the main guild.
- Added owner-controlled `/permission set`, `/permission clear`, and `/permission list` actions for ticket creation, role-request approval, role assignment, ban approvals, global moderation subcommands, and sticky-message management.
- Once `role-assign` is configured, `/role add`, `/role remove`, `/temp role`, and `/auto-role` use that allowlist instead of generic Manage Roles access.
- Ban approval permission can be assigned to a role/user and allows that authorized reviewer to approve a ban request, including their own request, as requested.

## Separate logs
- `/security setup` configures general security incident logs only; it no longer silently assigns that channel as the global ban review channel.
- Added `/ban-logs set`, `/ban-logs status`, and `/ban-logs disable`. The legacy `/ban logs` / `/ban status` aliases remain available.
- Global ban review embeds are sent to the dedicated ban-log channel. Global kick/timeout and unglobal requests use the general security channel.
- Global ban request/approval/denial records are not posted as separate ban embeds in the general security log. General security incidents such as role grants and quarantine events remain logged there.
- Ban embeds have plain labels without emoji decorations. Ban decisions are also posted as plain text in the associated evidence thread.

## Global ban safety
- Global ban attempts run immediately across guilds the bot is connected to, before review.
- Each request is persisted before guild operations and tracks the exact guild IDs where the bot newly banned the target. Pre-existing bans are tracked separately and are never unbanned by denial.
- If denied, the bot attempts to unban only guilds recorded as newly banned by that request, logs partial failures, and attempts to DM a one-use invite when it can create one.
- If the review message cannot be posted, the bot attempts rollback and reports the rollback outcome rather than claiming success.
- A partial ban/unban is represented as a partial result. Discord permissions, missing guilds, invite availability, and failed DMs can still prevent full completion.
- Unknown audit-log attribution during a protected-role assignment no longer triggers automatic quarantine of the recipient. The protected role is still removed where possible and the incident is recorded; an identified unauthorized grantor may be quarantined.

## Sticky messages
- Added `/sticky message set`, `view`, `update`, and `remove`.
- Sticky configuration is persisted in `bot-data.json`; new messages refresh the sticky to the bottom of the channel. Bot messages are ignored to prevent repost loops.
- Use `/permission set` with `sticky-manage` to restrict sticky management; otherwise the normal Manage Messages permission applies.

## Setup after update
1. Back up existing `bot-data.json` and `ticket-data.json` before deploying.
2. Run `/security setup` in the main guild and choose the general security log channel (not the ban-log channel).
3. Run `/ban-logs set` to choose the dedicated global ban review channel.
4. Use `/permission set` to configure role/user access for the actions you want to restrict. For example, choose `role-assign` and a role to restrict role grants, or `role-request-approve` for role-request reviewers.
5. For global ban requests, the bot needs ban/unban permissions in each target guild, and the review channel needs Send Messages, Embed Links, and Create Public Threads (for evidence threads). Invite delivery additionally needs Create Invite in a suitable channel and permission to DM the target.

## Test limitations
- `npm run check` performs JavaScript syntax checks and the included static self-test.
- This package has not been connected to Discord or Railway in this build session. Live guild permissions, Discord API behavior, actual invite/DM delivery, and deployment are not claimed as tested.

**Quarantine safety hotfix:** protected-role grant/tamper events are logged for owner review; the bot removes an unauthorized protected role and attempts rollback of protected-role edits, but does not automatically quarantine the grantor or re-apply quarantine when the quarantine role is removed. Manual owner-triggered quarantine remains available. This avoids audit-log attribution errors and prevents ordinary moderation-role holders from being automatically stripped/quarantined by these event handlers.
