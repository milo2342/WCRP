# Security Update v1.1.0

This build hardens the global moderation system after the cross-server permission issue.

## Hard security boundaries

- Global moderation commands are registered only in guild `1418997681254174883` and are also rejected at runtime anywhere else.
- User `939620924213309451` is the single primary security owner and bypasses command-role checks.
- Generic `Manage Server` / administrator status no longer grants Global Moderation Access.
- Global moderation fails closed until `/security setup` is completed.
- Old `globalRoles` access lists are not trusted after the upgrade.
- Pending pre-hardening global approval requests are automatically closed on first boot.
- Legacy global-ban/global-timeout records remain visible for review but are not automatically enforced on future joins unless they were created by the new hardened approval flow.

## Required first-time setup after deploying this build

1. Put the bot's highest Discord role above the Global Access, Grant Authority, and Quarantine roles.
2. Give the bot `View Audit Log` and `Manage Roles` in the main Discord. It also needs the normal moderation permissions required for the actions you use.
3. Create three separate roles:
   - Global Moderation Access — the only role that can submit/review global actions.
   - Global Access Grant Authority — the only role allowed to grant Global Moderation Access.
   - Security Quarantine — a dedicated role with no dangerous Discord permissions.
4. Run:
   `/security setup access-role:<role> grant-role:<role> quarantine-role:<role> log-channel:<channel>`
5. Configure staff commands with either:
   `/permissions set-all role:<staff role>`
   or individual `/permissions set command:<command> role:<role>` calls.
6. Review old enforcement data with `/security records`. Use `/security clear-record user:<user>` for compromised legacy records. This removes Titan's stored enforcement record; it does not automatically undo bans that already happened.
7. Grant Global Moderation Access through `/security grant user:<user>` or by having a member of the configured Grant Authority role assign the access role.

## Protected-role response

If someone without the configured Grant Authority role assigns Global Moderation Access, Titan removes the protected role and quarantines both the grantor and receiver where Discord hierarchy allows it.

If someone other than the primary owner assigns the Grant Authority role, the same response applies.

During quarantine Titan also strips manageable roles containing dangerous permissions such as Administrator, Manage Server, Manage Roles, Manage Channels, Manage Webhooks, Ban, Kick, or Moderate Members. Stripped roles are recorded and are NOT automatically restored when the owner removes quarantine.

Unauthorized removal of the quarantine role is detected and Titan attempts to re-apply it. Unauthorized edits/deletion of protected security roles are also detected; edits are rolled back where possible and deleted protected roles cause global moderation to fail closed until `/security setup` is run again.

## Global-action safety

- Global requests have a 15-second cooldown and a 5-per-hour operator safety limit.
- A non-owner operator cannot approve their own global request.
- Global approvals expire after 30 minutes.
- The primary owner, the bot itself, the main guild owner, Global Access members, and Grant Authority members are protected targets from non-owner global actions.
- Approval buttons are checked again at click time; possession of an old approval message is not enough.

## Useful security commands

- `/security setup`
- `/security status`
- `/security grant`
- `/security revoke`
- `/security quarantine`
- `/security unquarantine`
- `/security records`
- `/security clear-record`
- `/security incidents`
- `/permissions set`
- `/permissions clear`
- `/permissions set-all`
- `/permissions list`

Keep the bot's role above every staff role Titan is expected to quarantine or strip. Discord does not allow a bot to manage members/roles above its own highest role.

---

# v1.2.0 — Ticket Controls + Global Log Redesign

## Ticket member controls

Staff can now manage extra people inside an existing managed ticket:

- `/ticket add user:@member` grants that member private access to the current ticket.
- `/ticket remove user:@member` explicitly denies that added member access to the current ticket.
- The ticket opener cannot be removed with this command.
- Members who have the configured ticket support role cannot be removed this way because their support role grants access.
- Added ticket members are tracked in `ticket-data.json` and appear in transcripts.
- Closing a ticket also disables sending for added members; reopening restores it.
- Permission update failures now return an error instead of falsely reporting success.

## Global moderation log redesign

The global review card was rebuilt for faster staff review:

- action-specific title/icon and clear status state
- target, requester, scope, reason, stage, evidence, timestamp, request ID
- two-person approval security rule shown directly on the card
- cleaner approval/deny/ownership buttons
- approved requests show execution totals and reviewer details
- partial failures switch to a warning state instead of looking fully successful
- target avatar remains visible for quick identity checks
- global ban evidence threads now receive a structured evidence-review embed instead of a plain reminder message

## Preserved security controls

This release keeps the v1.1.0 hardening in place: main-guild-only global commands, protected Global Access and Grant Authority roles, automatic quarantine on unauthorized protected-role grants, owner-only permission setup, self-approval blocking, action rate limits, approval expiry, protected targets, and fail-closed legacy migration.


## v1.2.1 — Data backup safety

- Added owner-only `/data backup` in the main Discord.
- Backup exports the live bot state and ticket state as downloadable attachments.
- Adds a manifest containing SHA-256 integrity hashes for both data files.
- Large JSON files are automatically gzip-compressed before Discord upload.
- Environment variables and the Discord bot token are never included in the backup.
- Added `/data status` to show current runtime data sizes and the most recent manual backup timestamp.
- `/data` is not registered outside the main Discord and only the primary security owner can use it.
- Recommended workflow: run `/data backup` and save all attachments before every major bot update.
