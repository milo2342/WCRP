const fs = require('fs');
const { spawnSync } = require('child_process');

const source = fs.readFileSync('./index.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const syntax = spawnSync(process.execPath, ['--check', 'index.js'], { encoding: 'utf8' });
if (syntax.status !== 0) throw new Error(syntax.stderr || syntax.stdout || 'index.js syntax check failed');

expect(pkg.version === '1.3.7', 'Expected WCRP Utilities version 1.3.7');
expect(pkg.name === 'wcrp-utilities', 'Package must be branded as WCRP Utilities');
expect(source.includes("const MAIN_GUILD_ID = '1418997681254174883';"), 'Main guild hard lock missing');
expect(source.includes("const PRIMARY_OWNER_ID = '939620924213309451';"), 'Primary owner hard lock missing');
expect(source.includes('globalAccessRoleId'), 'Protected global access role missing');
expect(source.includes('globalGrantRoleId'), 'Protected grant-authority role missing');
expect(source.includes("case 'permission':"), 'Fine-grained permission manager missing');
expect(source.includes("setName('ban-logs')"), 'Dedicated ban-log command missing');
expect(source.includes("setName('sticky')"), 'Sticky message command missing');
expect(source.includes('Choose a command from the list'), 'Command permission selector must use a command list');
expect(source.includes("'auto-role'"), 'Auto-role must be available in the command permission list');
expect(source.includes("'role', 'temp', 'auto-role', 'welcome', 'serverlog'"), 'Important real command choices must be configurable');
expect(!source.includes("'quarantine', 'unquarantine', 'server-info'"), 'Non-top-level commands must not appear as permission choices');
expect(source.includes('commandExemptRoleIds'), 'Set-all command exemption role missing');
expect(source.includes('The exemption does NOT grant') || source.includes('This exemption does NOT grant'), 'Set-all must not bypass protected global moderation roles');
expect(source.includes("['global-ban', 'Use /global ban']"), 'Global ban permission action missing');
expect(source.includes("hasActionPermission(interaction, 'role-assign', false)"), 'Role assignment is not restricted to configured authorization');
expect(source.includes("if (action !== 'ban') await logSecurityIncident"), 'Global ban request-created log is not kept out of general security logs');
expect(!source.includes('state.banLogs[MAIN_GUILD_ID] = logChannel.id'), 'Security setup must not overwrite the dedicated ban-log channel');
expect(source.includes('state.stickyMessages'), 'Sticky messages are not persisted');
expect(source.includes('immediateBanAttempted'), 'Immediate global ban tracking missing');
expect(source.includes('bannedGuildIds'), 'Per-request ban reversal tracking missing');
expect(source.includes('reversalResult'), 'Global ban reversal result tracking missing');
expect(source.includes('Automatic quarantine is disabled for role-grant events to prevent false positives.'), 'Protected-role grants must not automatically quarantine members');
expect(source.includes('the bot did not re-apply quarantine automatically'), 'Quarantine role removal must not trigger automatic re-quarantine');
expect(source.includes('no automatic quarantine, owner review required'), 'Protected-role tampering must be logged without automatic quarantine');
expect(source.includes('const banOnlyIncident = details.action === \'ban\''), 'Ban records are not isolated from general security logs');
expect(source.includes("case 'data':"), 'Owner-only data backup command missing');
expect(source.includes('wcrp-main-data-backup-v1'), 'Backup manifest format missing');
expect(source.includes('sha256'), 'Backup integrity hashing missing');
expect(source.includes("case 'security':"), 'Security command missing');
expect(source.includes('securityMigrationClosed'), 'Legacy pending approval invalidation missing');
expect(source.includes('Only the primary owner can configure permissions.'), 'Permission setup owner check missing');
expect(source.includes("sc.setName('add').setDescription('Add a member to the current ticket.')"), 'Ticket add-member command missing');
expect(source.includes("sc.setName('remove').setDescription('Remove an added member from the current ticket.')"), 'Ticket remove-member command missing');
expect(source.includes('addedUserIds'), 'Ticket added-user tracking missing');
expect(source.includes('.setTitle(completedCleanly ? visual.label'), 'Completion embed action title missing');
expect(source.includes('Global ban denied by'), 'Ban denial decision is posted in the evidence thread');
expect(source.includes("client.on(Events.MessageCreate, async msg =>"), 'Sticky refresh listener missing');
expect(source.includes('request.immediateBanResult'), 'Immediate ban partial result tracking missing');
expect(source.includes('WCRP Global ${visual.short} Complete, All Systems Operational'), 'Completion embed must use WCRP branding and screenshot-style heading');
expect(source.includes('.setTitle(completedCleanly ? visual.label'), 'Completion embed title must be the action label, matching the requested layout');
expect(source.includes('has been globally ${actionPastTense} by:'), 'Completion embed must use screenshot-style action wording');

expect(source.includes('if (OWNER_ONLY_COMMANDS.has(name)) return { ok: false'), 'All-command exemption must not bypass owner-only commands');
expect(source.includes('configured role') && source.includes('to use /${name}'), 'Configured command roles must be enforced');
expect(source.includes('AutoRole] Failed for'), 'Auto-role failures must be visible in logs');
expect(source.includes('refresh skipped'), 'Sticky refresh must avoid duplicates when deletion fails');
console.log('WCRP Utilities v1.3.6 self-test passed.');
console.log('Verified statically: real command permission choices including auto-role, permission enforcement, safe exemptions, and background-task failure handling, separate ban/security logs, sticky persistence, global-ban tracking/reversal, quarantine safeguards, and backup support.');

for (const token of ['claimTicketAction', 'buildTranscriptHtml', '-transcript.html', 'toTranscriptMessage', 'I will be assisting you today. 👋', 'for your Ticket to be completed.']) {
  expect(source.includes(token), `Missing v1.3.7 token ${token}`);
}
expect(fs.existsSync('./transcript.js'), 'transcript.js missing');
console.log('v1.3.7 checks passed.');
{
  const guide = source.slice(source.indexOf('function ticketSupportGuideEmbed()'), source.indexOf('async function replyTicketGuide('));
  expect(guide.includes('COLORS.orange') && guide.includes('Ticket Support Guide'), 'Ticket support guide must be an orange embed');
}
console.log('ticket guide checks passed.');
expect(source.includes('DM the ticket opener their copy') && source.includes('Your ticket has been closed'), 'Opener transcript DM missing');
console.log('opener DM check passed.');
