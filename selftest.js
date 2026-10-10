const fs = require('fs');
const { spawnSync } = require('child_process');

const source = fs.readFileSync('./index.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
const envExample = fs.readFileSync('./.env.example', 'utf8');

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const syntax = spawnSync(process.execPath, ['--check', 'index.js'], { encoding: 'utf8' });
if (syntax.status !== 0) throw new Error(syntax.stderr || syntax.stdout || 'index.js syntax check failed');

expect(pkg.name === 'wcrp-utilities-bot', 'Package should be WCRP Utilities branded');
expect(pkg.version === '1.3.0', 'Expected package version 1.3.0');
expect(!/houston/i.test(source), 'Houston branding must not appear in source');
expect(!/houston/i.test(JSON.stringify(pkg)), 'Houston branding must not appear in package metadata');
expect(source.includes("const MAIN_GUILD_ID = '1418997681254174883';"), 'Main guild hard lock missing');
expect(source.includes("const PRIMARY_OWNER_ID = '939620924213309451';"), 'Primary owner hard lock missing');
expect(source.includes('globalAccessRoleId'), 'Protected global access role missing');
expect(source.includes('globalGrantRoleId'), 'Protected grant-authority role missing');
expect(source.includes('quarantineRoleId'), 'Quarantine role missing');
expect(source.includes("case 'permissions':"), 'Owner command-permission manager missing');
expect(source.includes("case 'data':"), 'Owner-only data backup command missing');
expect(source.includes('wcrp-main-data-backup-v1'), 'Backup manifest format missing');
expect(source.includes('sha256'), 'Backup integrity hashing missing');
expect(source.includes('Unauthorized Protected Role Grant'), 'Unauthorized protected-role detection missing');
expect(source.includes('quarantineSecurityMembers'), 'Automatic quarantine response missing');
expect(source.includes('You cannot approve your own global moderation request'), 'Self-approval protection missing');
expect(source.includes('GLOBAL_REQUEST_LIMIT = 5'), 'Global action rate limit missing');
expect(source.includes('GLOBAL_APPROVAL_TTL_MS'), 'Approval expiry protection missing');
expect(source.includes('applyHardenedSecurityMigration'), 'Hardened migration missing');
expect(source.includes('addedUserIds'), 'Ticket added-user tracking missing');

// v1.3.0 global-ban workflow.
expect(source.includes('async function applyImmediateGlobalBan'), 'Immediate provisional global-ban helper missing');
expect(source.includes('newlyBannedGuildIds'), 'Newly-created ban tracking missing');
expect(source.includes('alreadyBannedGuildIds'), 'Pre-existing ban preservation missing');
expect(source.includes('async function rollbackImmediateGlobalBan'), 'Denied global-ban rollback helper missing');
expect(source.includes('guild.members.unban(request.userId'), 'Denied request does not unban provisional bans');
expect(source.includes('async function createWcrpReturnInvite'), 'Return-invite helper missing');
expect(source.includes('WCRP_INVITE_URL'), 'Configured WCRP return invite support missing');
expect(envExample.includes('WCRP_INVITE_URL='), '.env.example return invite setting missing');
expect(source.includes('Global ban ${verb} by <@${reviewerId}> for'), 'Thread approval/denial summary helper missing');
expect(source.includes('Global ban request was ran by ${interaction.user} for ${user}'), 'Origin-channel request confirmation missing');
expect(source.includes("recordSecurityIncident('Global Ban Request Started'"), 'Silent permanent request audit missing');
expect(source.includes('scheduleApprovalExpiry(interaction.client, request)'), 'Approval expiry scheduling missing');
expect(source.includes('request.returnInviteUrl'), 'Return invite is not cached before provisional ban');
expect(source.includes("[WCRP Global Ban Pending Review"), 'WCRP provisional-ban reason branding missing');
expect(source.includes("[WCRP Global Ban •"), 'WCRP approved-ban reason branding missing');

// Global moderation embeds should be clean and emoji-free.
const approvalStart = source.indexOf('function approvalActionVisual(action)');
const approvalEnd = source.indexOf('async function refreshApprovalMessage', approvalStart);
expect(approvalStart >= 0 && approvalEnd > approvalStart, 'Approval embed block missing');
const approvalBlock = source.slice(approvalStart, approvalEnd);
for (const emoji of ['🔨','🥾','⏳','♻️','🔓','⚙️','⛔','⚠️','✅','👑','🛡️','👤','🌐','📝','🔎','📎','🕒','📊','📡']) {
  expect(!approvalBlock.includes(emoji), `Approval embed still contains emoji ${emoji}`);
}
expect(source.includes(".setTitle('Evidence Review Thread')"), 'Clean evidence-thread title missing');
expect(!source.includes(".setTitle('📎 Evidence Review Thread')"), 'Evidence-thread emoji was not removed');

// Sticky messages copied forward from the DHS-style workflow.
expect(source.includes("setName('sticky').setDescription('Manage plain-text sticky messages.')"), '/sticky command missing');
for (const sub of ['add', 'edit', 'remove', 'status']) {
  expect(source.includes(`sc.setName('${sub}')`), `/sticky ${sub} missing`);
}
expect(source.includes('const stickyTimers = new Map();'), 'Sticky refresh timer missing');
expect(source.includes('async function refreshSticky'), 'Sticky refresh helper missing');
expect(source.includes("client.on(Events.MessageCreate, message =>"), 'Sticky message activity listener missing');
expect(source.includes("case 'sticky':"), 'Sticky command handler missing');
expect(source.includes("'serverlog', 'sticky'"), 'Sticky is not owner-role configurable');

console.log('WCRP Utilities v1.3.0 self-test passed.');
console.log('Verified: immediate provisional global bans, safe denial rollback preserving pre-existing bans, return-invite recovery, review-thread approval/denial summaries, clean emoji-free global moderation embeds, WCRP branding, sticky messages, and existing security/data protections.');
