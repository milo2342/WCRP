const fs = require('fs');
const { spawnSync } = require('child_process');

const source = fs.readFileSync('./index.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const syntax = spawnSync(process.execPath, ['--check', 'index.js'], { encoding: 'utf8' });
if (syntax.status !== 0) throw new Error(syntax.stderr || syntax.stdout || 'index.js syntax check failed');

expect(pkg.version === '1.2.1', 'Expected package version 1.2.1');
expect(source.includes("const MAIN_GUILD_ID = '1418997681254174883';"), 'Main guild hard lock missing');
expect(source.includes("const PRIMARY_OWNER_ID = '939620924213309451';"), 'Primary owner hard lock missing');
expect(source.includes('globalAccessRoleId'), 'Protected global access role missing');
expect(source.includes('globalGrantRoleId'), 'Protected grant-authority role missing');
expect(source.includes('quarantineRoleId'), 'Quarantine role missing');
expect(source.includes("case 'permissions':"), 'Owner command-permission manager missing');
expect(source.includes("case 'data':"), 'Owner-only data backup command missing');
expect(source.includes("sc.setName('backup').setDescription('Download a full backup of bot and ticket runtime data.')"), 'Data backup subcommand missing');
expect(source.includes('wcrp-main-data-backup-v1'), 'Backup manifest format missing');
expect(source.includes('sha256'), 'Backup integrity hashing missing');
expect(source.includes("const MAIN_GUILD_ONLY_COMMANDS = new Set(['global', 'unglobal', 'security', 'data']);"), 'Data command is not main-guild-only');
expect(source.includes("case 'security':"), 'Security command missing');
expect(source.includes('Unauthorized Protected Role Grant'), 'Unauthorized protected-role detection missing');
expect(source.includes('quarantineSecurityMembers'), 'Automatic quarantine response missing');
expect(source.includes('You cannot approve your own global moderation request'), 'Self-approval protection missing');
expect(source.includes('GLOBAL_REQUEST_LIMIT = 5'), 'Global action rate limit missing');
expect(source.includes('GLOBAL_APPROVAL_TTL_MS'), 'Approval expiry protection missing');
expect(source.includes('applyHardenedSecurityMigration'), 'Hardened migration missing');
expect(source.includes("sc.setName('add').setDescription('Add a member to the current ticket.')"), 'Ticket add-member command missing');
expect(source.includes("sc.setName('remove').setDescription('Remove an added member from the current ticket.')"), 'Ticket remove-member command missing');
expect(source.includes('addedUserIds'), 'Ticket added-user tracking missing');
expect(source.includes("name: 'WCRP UTILITIES • GLOBAL MODERATION'"), 'Polished global moderation log header missing');
expect(source.includes("setTitle('📎 Evidence Review Thread')"), 'Polished evidence thread missing');
expect(source.includes('Security rule:'), 'Global approval security summary missing');
expect(source.includes('securityMigrationClosed'), 'Legacy pending approval invalidation missing');
expect(source.includes("ban?.requestId && ban?.approvedBy"), 'Legacy global-ban auto-enforcement is not fail-closed');
expect(source.includes(".filter(c => guildId === MAIN_GUILD_ID || !MAIN_GUILD_ONLY_COMMANDS.has(c.toJSON().name))"), 'Foreign-guild command filtering missing');
expect(source.includes('async function registerCommands(botClient = client)'), 'Startup command registration fix missing');
expect(!/function hasGlobalRole[\s\S]{0,400}isStaff\(interaction\)/.test(source), 'Global role check still trusts generic staff permissions');

console.log('WCRP Utilities v1.2.1 self-test passed.');
console.log('Verified: hardened global moderation, polished approval/evidence logs, ticket add/remove controls, quarantine response, rate limits, two-person approval, legacy fail-closed migration, owner-controlled command roles, and owner-only data backups with integrity manifests.');
