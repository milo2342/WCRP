require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const DATA_FILE = path.join(__dirname, 'bot-data.json');
const TICKET_FILE = path.join(__dirname, 'ticket-data.json');

const GLOBAL_MODERATION_GIF = 'https://images-ext-1.discordapp.net/external/PWBXAl9iXAQKrDOwVl97lT9Zcemf9cyT3-i6Bf_uG3A/https/cdn.calirp.gg/1767487024375625-trump_declares_you_are_banned.gif?width=384&height=215';

const COLORS = {
  primary: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  neutral: 0x2b2d31,
  purple: 0x9b59b6,
  pink: 0xeb459e,
  orange: 0xe67e22,
  teal: 0x1abc9c,
  gold: 0xf1c40f,
  blue: 0x3498db,
  white: 0xffffff,
};


// Security boundary: global moderation can only be requested/reviewed from the main guild.
const MAIN_GUILD_ID = '1418997681254174883';
const PRIMARY_OWNER_ID = '939620924213309451';
const OPEN_COMMANDS = new Set(['help', 'features', 'ping', 'server-info', 'user-info', 'ticket', 'request']);
const OWNER_ONLY_COMMANDS = new Set(['permissions', 'permission', 'data']);
const MAIN_GUILD_ONLY_COMMANDS = new Set(['global', 'unglobal', 'security', 'data']);
// Keep this list at Discord's 25-choice limit and focused on real, commonly managed commands.
// Global moderation/security and owner-only configuration are deliberately excluded: their
// dedicated role/action gates must never be bypassed by ordinary command-role settings.
const CONFIGURABLE_COMMANDS = new Set([
  'ban', 'kick', 'unban', 'timeout', 'untimeout', 'warn', 'warnings', 'clearwarn', 'purge',
  'role', 'temp', 'auto-role', 'welcome', 'serverlog', 'sticky', 'giveaway',
]);
const LOCKED_GLOBAL_ACTIONS = new Set(['ban', 'kick', 'timeout']);
const PERMISSION_ACTIONS = [
  ['ticket-create', 'Create tickets'], ['role-request-approve', 'Approve role requests'],
  ['role-assign', 'Assign/remove roles'], ['ban-approve', 'Approve ban requests'],
  ['global-ban', 'Use /global ban'], ['global-kick', 'Use /global kick'],
  ['global-timeout', 'Use /global timeout'], ['sticky-manage', 'Manage sticky messages'],
];
const GLOBAL_REQUEST_COOLDOWN_MS = 15_000;
const GLOBAL_REQUEST_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_REQUEST_LIMIT = 5;
const GLOBAL_APPROVAL_TTL_MS = 30 * 60 * 1000;
const globalRequestActivity = new Map();
const internalRoleGrants = new Map();
const internalRoleEdits = new Map();

const EMBED_COLOR_CHOICES = [
  ['Blurple', 'primary'],
  ['Purple', 'purple'],
  ['Pink', 'pink'],
  ['Blue', 'blue'],
  ['Teal', 'teal'],
  ['Green', 'success'],
  ['Gold', 'gold'],
  ['Orange', 'orange'],
  ['Red', 'danger'],
  ['Grey', 'neutral'],
  ['White', 'white'],
];

const defaultState = {
  banLogs: {},
  approvals: {},
  globalBans: {},
  globalTimeouts: {},
  autoRole: {},
  welcome: {},
  roleLogs: {},
  roleRequests: {},
  warnings: {},
  giveaways: {},
  serverLogs: {},
  globalRoles: {},
  security: {
    globalAccessRoleId: null,
    globalGrantRoleId: null,
    quarantineRoleId: null,
    logChannelId: null,
    hardenedMigrationAppliedAt: null,
    lastManualBackupAt: null,
    lastManualBackupBy: null,
  },
  commandPermissions: {},
  commandExemptRoleIds: {},
  actionPermissions: {},
  stickyMessages: {},
  securityIncidents: [],
  securityQuarantines: {},
};

const defaultTicketState = {
  nextPanelId: 1,
  panels: [],
  hubs: [],
  tickets: {},
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
      return clone(fallback);
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : clone(fallback);
  } catch (err) {
    console.error(`Failed to read ${path.basename(file)}:`, err);
    return clone(fallback);
  }
}

function writeJson(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

const state = { ...defaultState, ...readJson(DATA_FILE, defaultState) };
const ticketState = { ...defaultTicketState, ...readJson(TICKET_FILE, defaultTicketState) };
for (const key of Object.keys(defaultState)) if (!state[key]) state[key] = clone(defaultState[key]);
state.security = { ...clone(defaultState.security), ...(state.security && typeof state.security === 'object' ? state.security : {}) };
if (!state.commandPermissions || typeof state.commandPermissions !== 'object') state.commandPermissions = {};
if (!state.commandExemptRoleIds || typeof state.commandExemptRoleIds !== 'object') state.commandExemptRoleIds = {};
if (!state.actionPermissions || typeof state.actionPermissions !== 'object') state.actionPermissions = {};
if (!state.stickyMessages || typeof state.stickyMessages !== 'object') state.stickyMessages = {};
if (!Array.isArray(state.securityIncidents)) state.securityIncidents = [];
if (!state.securityQuarantines || typeof state.securityQuarantines !== 'object') state.securityQuarantines = {};
if (!Array.isArray(ticketState.panels)) ticketState.panels = [];
if (!Array.isArray(ticketState.hubs)) ticketState.hubs = [];
if (!ticketState.tickets || typeof ticketState.tickets !== 'object') ticketState.tickets = {};
for (const ticket of Object.values(ticketState.tickets)) {
  if (!Array.isArray(ticket.addedUserIds)) ticket.addedUserIds = [];
}
if (!Number.isInteger(ticketState.nextPanelId)) ticketState.nextPanelId = 1;

function saveState() { writeJson(DATA_FILE, state); }
function saveTickets() { writeJson(TICKET_FILE, ticketState); }

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function prepareBackupAttachment(filename, jsonText) {
  const raw = Buffer.from(jsonText, 'utf8');
  if (raw.length <= 7 * 1024 * 1024) {
    return { filename, attachmentName: filename, buffer: raw, rawBytes: raw.length, attachmentBytes: raw.length, compressed: false, sha256: sha256(raw) };
  }
  const gz = zlib.gzipSync(raw, { level: 9 });
  return { filename, attachmentName: `${filename}.gz`, buffer: gz, rawBytes: raw.length, attachmentBytes: gz.length, compressed: true, sha256: sha256(raw) };
}

function buildDataBackup(userId) {
  const createdAt = new Date().toISOString();
  state.security.lastManualBackupAt = Date.now();
  state.security.lastManualBackupBy = userId;
  saveState();
  saveTickets();

  const stamp = backupTimestamp();
  const botName = `wcrp-main-bot-data-${stamp}.json`;
  const ticketName = `wcrp-main-ticket-data-${stamp}.json`;
  const botFile = prepareBackupAttachment(botName, JSON.stringify(state, null, 2));
  const ticketFile = prepareBackupAttachment(ticketName, JSON.stringify(ticketState, null, 2));
  const manifest = {
    format: 'wcrp-main-data-backup-v1',
    createdAt,
    createdBy: userId,
    mainGuildId: MAIN_GUILD_ID,
    files: [
      { name: botFile.attachmentName, originalName: botFile.filename, sha256: botFile.sha256, rawBytes: botFile.rawBytes, attachmentBytes: botFile.attachmentBytes, compressed: botFile.compressed },
      { name: ticketFile.attachmentName, originalName: ticketFile.filename, sha256: ticketFile.sha256, rawBytes: ticketFile.rawBytes, attachmentBytes: ticketFile.attachmentBytes, compressed: ticketFile.compressed },
    ],
    note: 'Contains runtime bot configuration/state and ticket state only. Environment variables and Discord bot tokens are not included.',
  };
  const manifestName = `wcrp-main-backup-manifest-${stamp}.json`;
  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  return {
    createdAt,
    manifest,
    files: [
      { attachment: botFile.buffer, name: botFile.attachmentName },
      { attachment: ticketFile.buffer, name: ticketFile.attachmentName },
      { attachment: manifestBuffer, name: manifestName },
    ],
  };
}


function applyHardenedSecurityMigration() {
  if (state.security.hardenedMigrationAppliedAt) return false;
  let closed = 0;
  for (const request of Object.values(state.approvals ?? {})) {
    if (request?.status === 'pending' || request?.status === 'processing') {
      request.status = 'denied';
      request.resolvedBy = PRIMARY_OWNER_ID;
      request.resolvedAt = Date.now();
      request.securityMigrationClosed = true;
      closed++;
    }
  }
  // Never trust pre-hardening role lists. The new protected role must be explicitly configured.
  state.globalRoles = {};
  state.security.hardenedMigrationAppliedAt = Date.now();
  saveState();
  return closed;
}

function owners() {
  // Intentionally a single hard security owner. OWNER_IDS is no longer trusted for permission setup.
  return new Set([PRIMARY_OWNER_ID]);
}
function isOwner(id) { return id === PRIMARY_OWNER_ID; }
function isMainGuild(interactionOrGuild) {
  const id = interactionOrGuild?.guildId ?? interactionOrGuild?.id;
  return id === MAIN_GUILD_ID;
}
function configuredCommandRoleId(guildId, commandName) {
  return state.commandPermissions?.[guildId]?.[commandName] ?? null;
}
function hasConfiguredCommandRole(interaction, commandName = interaction.commandName) {
  if (!interaction.guild || !interaction.member || !commandName) return false;
  const roleId = configuredCommandRoleId(interaction.guild.id, commandName);
  return Boolean(roleId && interaction.member.roles?.cache?.has(roleId));
}
function hasCommandExemption(interaction) {
  const roleId = state.commandExemptRoleIds?.[interaction.guildId];
  return Boolean(roleId && interaction.member?.roles?.cache?.has(roleId));
}
function isStaff(interaction) {
  if (isOwner(interaction.user.id) || hasCommandExemption(interaction)) return true;
  if (interaction.isChatInputCommand?.() && hasConfiguredCommandRole(interaction)) return true;
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}
function hasGlobalRole(interaction) {
  if (!interaction.guild || !interaction.member || interaction.guild.id !== MAIN_GUILD_ID) return false;
  if (isOwner(interaction.user.id)) return true;
  const roleId = state.security.globalAccessRoleId;
  return Boolean(roleId && interaction.member.roles?.cache?.has(roleId));
}
function hasGlobalGrantAuthority(interaction) {
  if (!interaction.guild || !interaction.member || interaction.guild.id !== MAIN_GUILD_ID) return false;
  if (isOwner(interaction.user.id)) return true;
  const roleId = state.security.globalGrantRoleId;
  return Boolean(roleId && interaction.member.roles?.cache?.has(roleId));
}
function hasPermission(interaction, perm) {
  if (isOwner(interaction.user.id) || hasCommandExemption(interaction)) return true;
  if (interaction.isChatInputCommand?.() && hasConfiguredCommandRole(interaction)) return true;
  return Boolean(interaction.memberPermissions?.has(perm));
}

function actionPermissionConfigured(guildId, action) {
  const entry = state.actionPermissions?.[guildId]?.[action];
  return Boolean(entry && ((entry.roleIds?.length ?? 0) || (entry.userIds?.length ?? 0)));
}
function hasActionPermission(interaction, action, fallback = false) {
  if (isOwner(interaction.user.id)) return true;
  const entry = state.actionPermissions?.[interaction.guildId]?.[action];
  if (entry && ((entry.roleIds?.length ?? 0) || (entry.userIds?.length ?? 0))) {
    if (entry.userIds?.includes(interaction.user.id)) return true;
    const roles = interaction.member?.roles?.cache;
    return Boolean(roles && entry.roleIds?.some(id => roles.has(id)));
  }
  return fallback;
}

function isProtectedSecurityRole(roleId) {
  return Boolean(roleId && [state.security.globalAccessRoleId, state.security.globalGrantRoleId, state.security.quarantineRoleId].includes(roleId));
}
function commandAccessDecision(interaction) {
  const name = interaction.commandName;
  if (isOwner(interaction.user.id)) return { ok: true };
  // Enforce hard boundaries before the all-command exemption. The exemption only
  // bypasses ordinary command restrictions, never owner-only or main-guild boundaries.
  if (OWNER_ONLY_COMMANDS.has(name)) return { ok: false, reason: 'Only the security owner can use this command.' };
  if (MAIN_GUILD_ONLY_COMMANDS.has(name) && interaction.guildId !== MAIN_GUILD_ID) {
    return { ok: false, reason: 'This command is locked to the main Discord.' };
  }
  // Global moderation retains its dedicated role/action checks below.
  if (name !== 'global' && hasCommandExemption(interaction)) return { ok: true };
  if (OPEN_COMMANDS.has(name)) return { ok: true };
  if (name === 'global') {
    const sub = interaction.options.getSubcommand(false);
    if (!LOCKED_GLOBAL_ACTIONS.has(sub)) return { ok: true };
    const actionAllowed = hasGlobalRole(interaction) || hasActionPermission(interaction, `global-${sub}`, false);
    return actionAllowed
      ? { ok: true }
      : { ok: false, reason: `You need the configured Global Moderation Access role or the specific /permission set rule to use /global ${sub}.` };
  }
  if (name === 'unglobal') return { ok: true };
  if (name === 'security') {
    const sub = interaction.options.getSubcommand(false);
    if ((sub === 'grant' || sub === 'revoke') && hasGlobalGrantAuthority(interaction)) return { ok: true };
    return { ok: false, reason: 'Only the security owner or configured grant-authority role can use this action.' };
  }
  // Only real top-level commands are configurable. A saved role is enforced here;
  // unconfigured commands keep their existing built-in permission behavior.
  if (CONFIGURABLE_COMMANDS.has(name)) {
    const requiredRoleId = state.commandPermissions?.[interaction.guildId]?.[name];
    if (requiredRoleId && !interaction.member?.roles?.cache?.has(requiredRoleId)) {
      return { ok: false, reason: `You need the configured role <@&${requiredRoleId}> to use /${name}.` };
    }
  }
  return { ok: true };
}
function globalRateLimit(userId) {
  if (isOwner(userId)) return { ok: true };
  const now = Date.now();
  const recent = (globalRequestActivity.get(userId) ?? []).filter(ts => now - ts < GLOBAL_REQUEST_WINDOW_MS);
  if (recent.length && now - recent[recent.length - 1] < GLOBAL_REQUEST_COOLDOWN_MS) {
    return { ok: false, reason: 'Global moderation requests are rate limited. Wait a few seconds and try again.' };
  }
  if (recent.length >= GLOBAL_REQUEST_LIMIT) {
    return { ok: false, reason: `Global moderation safety limit reached (${GLOBAL_REQUEST_LIMIT} requests per hour). Contact the security owner.` };
  }
  recent.push(now);
  globalRequestActivity.set(userId, recent);
  return { ok: true };
}
function markInternalRoleGrant(guildId, userId, roleId) {
  internalRoleGrants.set(`${guildId}:${userId}:${roleId}`, Date.now() + 15_000);
}
function consumeInternalRoleGrant(guildId, userId, roleId) {
  const key = `${guildId}:${userId}:${roleId}`;
  const expires = internalRoleGrants.get(key) ?? 0;
  internalRoleGrants.delete(key);
  return expires > Date.now();
}

function markInternalRoleEdit(guildId, roleId) {
  internalRoleEdits.set(`${guildId}:${roleId}`, Date.now() + 15_000);
}
function consumeInternalRoleEdit(guildId, roleId) {
  const key = `${guildId}:${roleId}`;
  const expires = internalRoleEdits.get(key) ?? 0;
  internalRoleEdits.delete(key);
  return expires > Date.now();
}
function truncate(text, max = 1024) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}
function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'ticket';
}
function parseIds(input) {
  return String(input ?? '').split(',').map(v => v.trim()).map(v => v.replace(/^<@&?(\d{15,25})>$/, '$1')).filter(v => /^\d{15,25}$/.test(v));
}
function parseDuration(input) {
  const match = /^(\d+)\s*(s|m|h|d|w)$/i.exec(String(input ?? '').trim());
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit];
  return n * mult;
}
function replaceWelcome(text, member) {
  return String(text ?? '')
    .replaceAll('{user}', `${member}`)
    .replaceAll('{username}', member.user.username)
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{memberCount}', String(member.guild.memberCount));
}
function baseEmbed(title, description, color = COLORS.primary) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp();
}
function parseHexColor(input, fallback = COLORS.primary) {
  const raw = String(input ?? '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return fallback;
  return Number.parseInt(raw, 16);
}
function buttonStyleFromName(name) {
  return ({ primary: ButtonStyle.Primary, success: ButtonStyle.Success, danger: ButtonStyle.Danger, secondary: ButtonStyle.Secondary })[name] ?? ButtonStyle.Primary;
}
function embedColorFromPreset(preset, fallback = COLORS.primary) {
  return COLORS[preset] ?? fallback;
}
function resolveEmbedColor(customHex, preset, fallback = COLORS.primary) {
  if (customHex) return parseHexColor(customHex, fallback);
  if (preset) return embedColorFromPreset(preset, fallback);
  return fallback;
}
function makePanelOpenButton(panel) {
  const button = new ButtonBuilder()
    .setCustomId(`panel_open:${panel.id}`)
    .setLabel((panel.buttonLabel || 'Open Ticket').slice(0, 80))
    .setStyle(buttonStyleFromName(panel.buttonStyle));
  if (panel.buttonEmoji) button.setEmoji(panel.buttonEmoji);
  return button;
}
function buildTicketHubEmbed(guild, panels, title, description, color) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: `${guild.name} • Support Center`, iconURL: guild.iconURL({ size: 128 }) ?? undefined })
    .setTitle(title)
    .setDescription(`${description}\n\n**Open a Ticket**\nSelect one of the departments below. Your ticket will be private and routed to the appropriate support team.`)
    .addFields(...panels.map(panel => ({
      name: panel.name,
      value: truncate(panel.description || 'A private support ticket for this department.', 900),
      inline: false,
    })))
    .setFooter({ text: 'Support Center • Private Tickets • Please select a department below' })
    .setTimestamp();
  return embed;
}
function buildHubRows(panels) {
  const rows = [];
  for (let i = 0; i < panels.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(...panels.slice(i, i + 5).map(makePanelOpenButton)));
  }
  return rows;
}

function ticketPanelEmbed(panel, mode = 'panel', guild = null) {
  const embed = new EmbedBuilder()
    .setColor(panel.color ?? COLORS.primary)
    .setTitle(panel.title || panel.name || 'Ticket Selection')
    .setDescription(panel.description || 'Choose the support department you need below.')
    .setTimestamp();
  if (guild) {
    embed.setAuthor({ name: `${guild.name} • Support Center`, iconURL: guild.iconURL({ size: 128 }) ?? undefined });
  }
  if (mode === 'hub') {
    embed.addFields(
      { name: 'How it works', value: 'Select a department below to open a private ticket with the configured support team.', inline: false },
      { name: 'What to include', value: 'Please provide the relevant details, screenshots, order information, or evidence in your first message.', inline: false }
    );
    embed.setFooter({ text: 'Support Center • Private Tickets' });
  } else {
    embed.addFields(
      { name: 'Private Support', value: 'Only you and the configured support team can access this ticket.', inline: true },
      { name: 'Status', value: 'Awaiting a support representative', inline: true }
    );
    embed.setFooter({ text: 'Support Tickets • Private & Secure' });
  }
  return embed;
}

async function safeReply(interaction, payload) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(payload);
}
function getPanel(id, guildId) { return ticketState.panels.find(p => p.id === id && p.guildId === guildId); }
function getTicket(channelId) { return ticketState.tickets[channelId] ?? null; }
function getPanelForTicket(ticket) { return ticket ? ticketState.panels.find(p => p.id === ticket.panelId && p.guildId === ticket.guildId) : null; }

function ticketButtons(ticket) {
  if (ticket.closed) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket_reopen:${ticket.channelId}`).setLabel('Reopen Ticket').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`ticket_delete:${ticket.channelId}`).setLabel('Delete Ticket').setStyle(ButtonStyle.Danger),
    );
  }
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_claim:${ticket.channelId}`).setLabel('Claim Ticket').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ticket_close:${ticket.channelId}`).setLabel('Close Ticket').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket_delete:${ticket.channelId}`).setLabel('Delete Ticket').setStyle(ButtonStyle.Secondary),
  );
}

async function createTranscript(channel, ticket, panel) {
  if (!channel?.isTextBased()) return;
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const lines = [
    'WCRP Utilities Moderation Ticket Transcript',
    `Ticket: ${channel.name}`,
    `Guild: ${ticket.guildId}`,
    `Opened By: ${ticket.openerId}`,
    `Claimed By: ${ticket.claimedBy ?? 'Unclaimed'}`,
    `Added Users: ${(ticket.addedUserIds ?? []).length ? ticket.addedUserIds.join(', ') : 'None'}`,
    `Closed By: ${ticket.closedBy ?? 'Unknown'}`,
    '',
  ];
  if (messages) {
    for (const msg of [...messages.values()].reverse()) {
      const body = msg.content || msg.embeds.map(e => `[embed: ${e.title ?? 'untitled'}]`).join(' ') || '[no text]';
      lines.push(`[${msg.createdAt.toISOString()}] ${msg.author.tag}: ${body}`);
    }
  }
  const target = panel?.transcriptChannelId ? await channel.guild.channels.fetch(panel.transcriptChannelId).catch(() => null) : null;
  if (target?.isTextBased()) {
    await target.send({ content: `Transcript for ${channel}.`, files: [{ attachment: Buffer.from(lines.join('\n'), 'utf8'), name: `${channel.name}-transcript.txt` }] }).catch(() => null);
  }
}

async function logServerEvent(guild, event, description, meta = '') {
  const cfg = state.serverLogs[guild.id];
  if (!cfg?.channelId) return;
  if (!cfg.events?.includes(event)) return;
  const channel = await guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.send({ embeds: [baseEmbed(`Server Log • ${event}`, [description, meta].filter(Boolean).join('\n'), COLORS.neutral)] }).catch(() => null);
}


function recordSecurityIncident(type, details = {}) {
  const item = {
    id: `SEC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    type,
    at: Date.now(),
    ...details,
  };
  state.securityIncidents.push(item);
  if (state.securityIncidents.length > 500) state.securityIncidents.splice(0, state.securityIncidents.length - 500);
  saveState();
  return item;
}

async function logSecurityIncident(guild, title, description, color = COLORS.danger, details = {}) {
  const incident = recordSecurityIncident(title, { guildId: guild?.id ?? null, ...details });
  if (!guild || guild.id !== MAIN_GUILD_ID) return incident;
  const banOnlyIncident = details.action === 'ban' && /global (request|action).*(created|executed|denied)|global request created/i.test(title);
  const channelId = banOnlyIncident ? null : state.security.logChannelId;
  const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
  if (channel?.isTextBased()) {
    await channel.send({ embeds: [baseEmbed(`Security • ${title}`, `${description}\n\n**Incident:** \`${incident.id}\``, color)] }).catch(() => null);
  }
  return incident;
}

async function protectedTargetReason(client, userId) {
  if (userId === PRIMARY_OWNER_ID) return 'the primary security owner';
  if (userId === client.user?.id) return 'the bot itself';
  const guild = client.guilds.cache.get(MAIN_GUILD_ID);
  if (!guild) return null;
  if (userId === guild.ownerId) return 'the main server owner';
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return null;
  if (state.security.globalAccessRoleId && member.roles.cache.has(state.security.globalAccessRoleId)) return 'a Global Moderation Access member';
  if (state.security.globalGrantRoleId && member.roles.cache.has(state.security.globalGrantRoleId)) return 'a Global Access Grant Authority member';
  return null;
}

function roleHasDangerousSecurityPermission(role) {
  const dangerous = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.ModerateMembers,
  ];
  return dangerous.some(permission => role.permissions?.has(permission));
}

async function quarantineSecurityMembers(guild, userIds, reason) {
  if (!guild || guild.id !== MAIN_GUILD_ID) return { quarantined: [], failed: [], stripped: {} };
  const roleId = state.security.quarantineRoleId;
  const quarantineRole = roleId ? guild.roles.cache.get(roleId) : null;
  const quarantined = [];
  const failed = [];
  const stripped = {};
  state.securityQuarantines[guild.id] ??= {};

  for (const userId of [...new Set(userIds.filter(Boolean))]) {
    if (userId === PRIMARY_OWNER_ID || userId === guild.ownerId || userId === guild.client.user?.id) continue;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;
    try {
      const removableDangerous = member.roles.cache.filter(role =>
        role.id !== guild.id &&
        role.id !== roleId &&
        !role.managed &&
        role.position < guild.members.me.roles.highest.position &&
        (role.id === state.security.globalAccessRoleId || role.id === state.security.globalGrantRoleId || roleHasDangerousSecurityPermission(role))
      );
      const removedRoleIds = [...removableDangerous.keys()];
      if (removedRoleIds.length) {
        await member.roles.remove(removedRoleIds, `[Security Quarantine] ${reason}`);
        stripped[userId] = removedRoleIds;
      }
      const unmanageableDangerous = member.roles.cache.filter(role =>
        role.id !== guild.id && !role.managed && role.position >= guild.members.me.roles.highest.position && roleHasDangerousSecurityPermission(role)
      );
      if (unmanageableDangerous.size) {
        failed.push({ userId, error: `Dangerous role(s) above bot hierarchy: ${[...unmanageableDangerous.values()].map(r => r.name).join(', ')}` });
      }
      state.securityQuarantines[guild.id][userId] = {
        at: Date.now(),
        reason,
        removedRoleIds,
      };
      if (!quarantineRole) {
        failed.push({ userId, error: 'Quarantine role is not configured or no longer exists; privileged roles were still stripped where possible.' });
      } else {
        await member.roles.add(quarantineRole, `[Security Quarantine] ${reason}`);
        quarantined.push(userId);
      }
    } catch (err) {
      failed.push({ userId, error: String(err?.message ?? err) });
    }
  }
  saveState();
  return { quarantined, failed, stripped };
}

async function resolveRoleUpdateExecutor(guild, targetId, roleId) {
  const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 8 }).catch(() => null);
  if (!logs) return null;
  const now = Date.now();
  for (const entry of logs.entries.values()) {
    if (entry.targetId !== targetId || now - entry.createdTimestamp > 15_000) continue;
    const changed = entry.changes?.some(change => {
      if (change.key !== '$add' && change.key !== '$remove') return false;
      const roles = Array.isArray(change.new) ? change.new : Array.isArray(change.old) ? change.old : [];
      return roles.some(r => r?.id === roleId);
    });
    if (changed) return entry.executorId ?? entry.executor?.id ?? null;
  }
  return null;
}

function roleCanBeUsedForSecurity(role, guild) {
  if (!role || role.managed || role.id === guild.id) return false;
  const me = guild.members.me;
  if (!me) return false;
  return role.position < me.roles.highest.position;
}


function securityConfigReady(guild) {
  if (!guild || guild.id !== MAIN_GUILD_ID) return false;
  const cfg = state.security;
  return Boolean(
    cfg.globalAccessRoleId && guild.roles.cache.has(cfg.globalAccessRoleId) &&
    cfg.globalGrantRoleId && guild.roles.cache.has(cfg.globalGrantRoleId) &&
    cfg.quarantineRoleId && guild.roles.cache.has(cfg.quarantineRoleId) &&
    cfg.logChannelId && guild.channels.cache.has(cfg.logChannelId)
  );
}

function serverLogEvents() {
  return [
    'memberJoin', 'memberLeave', 'memberUpdate', 'messageDelete', 'messageEdit', 'messageBulkDelete',
    'banAdd', 'banRemove', 'channelCreate', 'channelDelete', 'channelUpdate', 'roleCreate', 'roleDelete',
    'roleUpdate', 'guildUpdate', 'threadCreate', 'threadDelete', 'inviteCreate', 'inviteDelete',
  ];
}

function approvalActionLabel(action) {
  return action === 'ban' ? 'GLOBAL BAN'
    : action === 'kick' ? 'GLOBAL KICK'
      : action === 'timeout' ? 'GLOBAL TIMEOUT'
        : action === 'unban' ? 'GLOBAL UNBAN'
          : 'GLOBAL UNTIMEOUT';
}

function approvalActionVisual(action) {
  if (action === 'ban') return { emoji: '🔨', label: 'Global Ban', short: 'Ban' };
  if (action === 'kick') return { emoji: '🥾', label: 'Global Kick', short: 'Kick' };
  if (action === 'timeout') return { emoji: '⏳', label: 'Global Timeout', short: 'Timeout' };
  if (action === 'unban') return { emoji: '♻️', label: 'Global Unban', short: 'Unban' };
  return { emoji: '🔓', label: 'Global Untimeout', short: 'Untimeout' };
}

function approvalStatus(request) {
  if (request.status === 'processing') return { icon: '⚙️', title: 'PROCESSING', text: 'Approval accepted. WCRP Utilities is applying this action across every connected server it can safely reach.', color: COLORS.primary, footer: 'PROCESSING' };
  if (request.status === 'denied') return { icon: '⛔', title: 'DENIED', text: request.action === 'ban' && request.immediateBanAttempted ? `The request was denied. The bot attempted to reverse only the bans recorded as created by this request. ${request.reversalResult ? `${request.reversalResult.succeeded} reversed; ${request.reversalResult.failed} failed.` : 'Reversal results pending.'}` : 'This request was denied and no enforcement action was executed.', color: COLORS.danger, footer: 'DENIED' };
  if (request.status === 'approved') {
    const result = request.result ? ` ${request.result.succeeded} server(s) succeeded${request.result.failed ? ` • ${request.result.failed} failed` : ' • 0 failed'}.` : '';
    return { icon: request.result?.failed ? '⚠️' : '✅', title: request.result?.failed ? 'APPROVED • PARTIAL RESULT' : 'APPROVED', text: `The request passed review and enforcement completed.${result}`, color: request.result?.failed ? COLORS.warning : COLORS.success, footer: 'APPROVED' };
  }
  if (request.stage === 'ownership') return { icon: '👑', title: 'OWNERSHIP REVIEW', text: 'Escalated for final ownership review. Only configured ownership authority can approve or deny this request.', color: COLORS.primary, footer: 'OWNERSHIP REVIEW' };
  return { icon: '🛡️', title: 'STAFF REVIEW', text: request.action === 'ban' && request.immediateBanAttempted ? 'The immediate ban attempt is recorded. A reviewer must approve to retain the recorded bans or deny to reverse only the bans created by this request.' : 'Awaiting an authorised reviewer. Check the target, reason, and evidence thread before taking action.', color: COLORS.warning, footer: 'PENDING REVIEW' };
}

function approvalComponents(request) {
  const visual = approvalActionVisual(request.action);
  if (request.status !== 'pending') {
    if (request.status === 'approved') {
      return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approval_done:${request.id}`).setLabel(`✓ ${visual.label} Approved`).setStyle(ButtonStyle.Success).setDisabled(true)
      )];
    }
    if (request.status === 'denied') {
      return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approval_done:${request.id}`).setLabel(`✕ ${visual.label} Denied`).setStyle(ButtonStyle.Danger).setDisabled(true)
      )];
    }
    return [];
  }

  if (request.stage === 'ownership') {
    const statusButton = new ButtonBuilder()
      .setCustomId(`approval_stage:${request.id}`)
      .setLabel('👑 Ownership Review')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);
    const ownerApprove = new ButtonBuilder().setCustomId(`approval_approve:${request.id}`).setLabel(`Approve ${visual.short}`).setStyle(ButtonStyle.Success);
    const ownerDeny = new ButtonBuilder().setCustomId(`approval_deny:${request.id}`).setLabel('Deny Request').setStyle(ButtonStyle.Danger);
    return [
      new ActionRowBuilder().addComponents(statusButton),
      new ActionRowBuilder().addComponents(ownerApprove, ownerDeny),
    ];
  }

  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`approval_approve:${request.id}`).setLabel(`Approve ${visual.short}`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`approval_deny:${request.id}`).setLabel('Deny Request').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`approval_ownership:${request.id}`).setLabel('Ownership Review').setStyle(ButtonStyle.Secondary)
  )];
}

async function buildApprovalEmbed(client, request) {
  const guild = client.guilds.cache.get(request.guildId);
  const targetMember = guild ? await guild.members.fetch(request.userId).catch(() => null) : null;
  const targetUser = targetMember?.user ?? await client.users.fetch(request.userId).catch(() => null);
  const requester = await client.users.fetch(request.requestedBy).catch(() => null);
  const resolver = request.resolvedBy ? await client.users.fetch(request.resolvedBy).catch(() => null) : null;
  const status = approvalStatus(request);
  const visual = approvalActionVisual(request.action);
  const submitted = Math.floor(request.createdAt / 1000);
  const stage = request.stage === 'ownership' ? 'Ownership Review' : 'Staff Review';
  const evidence = request.action === 'ban'
    ? '**Required**\nPost screenshots, clips, links, or other proof in the attached review thread.'
    : '**Recommended**\nUse the review thread for any supporting context or evidence.';
  const targetText = targetUser
    ? `${targetUser}\n**${targetUser.tag}**\n\`${request.userId}\``
    : `<@${request.userId}>\n\`${request.userId}\``;
  const requesterText = requester
    ? `${requester}\n**${requester.tag}**\n\`${request.requestedBy}\``
    : `<@${request.requestedBy}>\n\`${request.requestedBy}\``;

  const completedCleanly = request.status === 'approved' && Number(request.result?.failed ?? 0) === 0;
  const completionTitle = completedCleanly ? `WCRP Global ${visual.short} Complete, All Systems Operational` : `${visual.label} - ${status.title}`;
  const completionDescription = completedCleanly
    ? `<@${request.userId}> has been globally ${request.action === 'ban' ? 'banned' : request.action === 'kick' ? 'kicked' : request.action === 'timeout' ? 'timed out' : request.action === 'unban' ? 'unbanned' : 'untimed out'} by <@${request.resolvedBy}>\n\n**Reason:** ${truncate(request.reason, 700)}\n**Command Requested by:** <@${request.requestedBy}> • <t:${Math.floor(request.createdAt / 1000)}:F>`
    : `**${status.title}**\n${status.text}\n\n> **Security rule:** A global action requires an authorised requester and a separate authorised reviewer before execution.`;
  const embed = new EmbedBuilder()
    .setColor(status.color)
    .setAuthor({
      name: 'WCRP UTILITIES • GLOBAL MODERATION',
      ...(guild?.iconURL() ? { iconURL: guild.iconURL({ size: 128 }) } : {}),
    })
    .setTitle(completionTitle)
    .setDescription(completionDescription)
    .addFields(
      { name: 'TARGET', value: targetText, inline: true },
      { name: 'REQUESTED BY', value: requesterText, inline: true },
      { name: 'SCOPE', value: `**Connected Servers**\nRequest \`${request.id}\``, inline: true },
      { name: 'REASON', value: `>>> ${truncate(request.reason, 980)}`, inline: false },
      { name: 'REVIEW', value: `**Stage:** ${stage}\n**State:** ${status.title}`, inline: true },
      { name: 'EVIDENCE', value: evidence, inline: true },
      { name: 'SUBMITTED', value: `<t:${submitted}:F>\n<t:${submitted}:R>`, inline: true },
    )
    .setFooter({ text: `WCRP Utilities • Global Enforcement • ${request.id}` })
    .setTimestamp(request.resolvedAt ? new Date(request.resolvedAt) : new Date(request.createdAt));

  if (request.action === 'timeout' && request.durationMs) {
    embed.addFields({ name: 'TIMEOUT LENGTH', value: `**${formatDuration(request.durationMs)}**`, inline: true });
  }
  if (request.action === 'ban' && request.immediateBanAttempted) {
    embed.addFields({ name: 'PRE-EXISTING BANS', value: `${request.preexistingBanGuildIds?.length ?? 0} guild(s) were already banning this user and will not be unbanned if this request is denied.`, inline: false });
  }

  if (request.result) {
    const total = Number(request.result.succeeded || 0) + Number(request.result.failed || 0);
    const executionState = request.result.expired ? 'Expired before execution'
      : request.result.postingFailed ? 'Review post failed; rollback attempted'
        : request.action === 'ban' && request.immediateBanAttempted && request.status === 'pending' ? 'Immediate ban attempt (awaiting review)'
          : request.result.reversal ? 'Ban reversal result'
            : request.result.failed ? 'Completed with failures'
              : 'Completed successfully';
    embed.addFields({
      name: 'EXECUTION SUMMARY',
      value: `**${executionState}**\nSuccessful: **${request.result.succeeded || 0}**\nFailed: **${request.result.failed || 0}**\nProcessed: **${total}**`,
      inline: true,
    });
  }

  if (resolver) {
    const resolvedAt = request.resolvedAt ? Math.floor(request.resolvedAt / 1000) : null;
    embed.addFields({
      name: request.status === 'denied' ? 'REVIEWED BY' : 'APPROVED BY',
      value: `${resolver}\n**${resolver.tag}**${resolvedAt ? `\n<t:${resolvedAt}:F>` : ''}`,
      inline: true,
    });
  }

  if (completedCleanly) embed.setThumbnail(GLOBAL_MODERATION_GIF);
  else if (targetUser) embed.setThumbnail(targetUser.displayAvatarURL({ size: 256 }));
  return embed;
}

async function refreshApprovalMessage(client, request, messageOverride = null) {
  const guild = client.guilds.cache.get(request.guildId);
  const channel = guild ? await guild.channels.fetch(request.channelId).catch(() => null) : null;
  const message = messageOverride ?? (channel?.isTextBased() ? await channel.messages.fetch(request.messageId).catch(() => null) : null);
  if (!message) return false;
  const embed = await buildApprovalEmbed(client, request);
  await message.edit({ embeds: [embed], components: approvalComponents(request) }).catch(() => null);
  return true;
}

function formatDuration(ms) {
  let remaining = Math.max(0, Number(ms) || 0);
  const units = [['w', 604800000], ['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]];
  const parts = [];
  for (const [label, size] of units) {
    if (remaining >= size) {
      const amount = Math.floor(remaining / size);
      remaining -= amount * size;
      parts.push(`${amount}${label}`);
    }
  }
  return parts.join(' ') || '0s';
}

async function executeGlobalAction(interaction, request) {
  if (interaction.guildId !== MAIN_GUILD_ID || request.guildId !== MAIN_GUILD_ID) {
    await logSecurityIncident(interaction.guild, 'Blocked Foreign Approval', `${interaction.user} attempted to execute a global request outside the main Discord.`, COLORS.danger, { actorId: interaction.user.id, requestId: request.id });
    return interaction.reply({ content: 'This global request is not valid in this Discord.', ephemeral: true }).catch(() => null);
  }
  if (!hasGlobalRole(interaction) && !(request.action === 'ban' && hasActionPermission(interaction, 'ban-approve', false))) return interaction.reply({ content: 'You do not have permission to approve this global request.', ephemeral: true }).catch(() => null);
  if (!isOwner(interaction.user.id) && request.requestedBy === interaction.user.id && !(request.action === 'ban' && hasActionPermission(interaction, 'ban-approve', false))) {
    return interaction.reply({ content: 'You cannot approve your own global moderation request unless you hold the configured ban-approval permission.', ephemeral: true }).catch(() => null);
  }
  if (Date.now() - request.createdAt > GLOBAL_APPROVAL_TTL_MS) {
    request.status = 'denied';
    request.resolvedBy = interaction.user.id;
    request.resolvedAt = Date.now();
    request.result = { succeeded: 0, failed: 0, expired: true };
    saveState();
    await interaction.deferUpdate().catch(() => null);
    await refreshApprovalMessage(interaction.client, request, interaction.message);
    await logSecurityIncident(interaction.guild, 'Expired Global Request Blocked', `Request \`${request.id}\` expired before execution.`, COLORS.warning, { actorId: interaction.user.id, targetId: request.userId, requestId: request.id });
    return;
  }
  const protectedReason = await protectedTargetReason(interaction.client, request.userId);
  if ((request.userId === PRIMARY_OWNER_ID || request.userId === interaction.client.user.id) || (protectedReason && !isOwner(interaction.user.id))) {
    await logSecurityIncident(interaction.guild, 'Blocked Protected Global Execution', `${interaction.user} attempted to approve **${request.action}** against <@${request.userId}>${protectedReason ? ` (${protectedReason})` : ''}.`, COLORS.danger, { actorId: interaction.user.id, targetId: request.userId, requestId: request.id, action: request.action });
    return interaction.reply({ content: 'That target is protected from this global action.', ephemeral: true }).catch(() => null);
  }

  await interaction.deferUpdate().catch(() => null);
  request.status = 'processing';
  request.processingBy = interaction.user.id;
  request.processingAt = Date.now();
  saveState();
  await refreshApprovalMessage(interaction.client, request, interaction.message);

  let succeeded = 0;
  let failed = 0;
  if (request.action === 'ban' && request.immediateBanAttempted) {
    succeeded = Number(request.immediateBanResult?.succeeded ?? 0);
    failed = Number(request.immediateBanResult?.failed ?? 0);
  }
  const expiresAt = request.action === 'timeout' ? Date.now() + request.durationMs : null;

  await Promise.all([...(request.action === 'ban' && request.immediateBanAttempted ? [] : interaction.client.guilds.cache.values())].map(async (guild) => {
    try {
      if (request.action === 'ban') {
        await guild.members.ban(request.userId, { reason: `[Global Ban • ${request.id}] ${request.reason}` });
        succeeded++;
      } else if (request.action === 'kick') {
        const member = await guild.members.fetch(request.userId).catch(() => null);
        if (!member) { failed++; return; }
        await member.kick(`[Global Kick • ${request.id}] ${request.reason}`);
        succeeded++;
      } else if (request.action === 'timeout') {
        const member = await guild.members.fetch(request.userId).catch(() => null);
        if (!member) { failed++; return; }
        await member.timeout(Math.min(request.durationMs, 28 * 86400000), `[Global Timeout • ${request.id}] ${request.reason}`);
        succeeded++;
      } else if (request.action === 'unban') {
        await guild.members.unban(request.userId, `[Global Unban • ${request.id}]`);
        succeeded++;
      } else if (request.action === 'untimeout') {
        const member = await guild.members.fetch(request.userId).catch(() => null);
        if (!member) { failed++; return; }
        await member.timeout(null, `[Global Untimeout • ${request.id}]`);
        succeeded++;
      }
    } catch {
      failed++;
    }
  }));

  request.status = 'approved';
  request.resolvedBy = interaction.user.id;
  request.resolvedAt = Date.now();
  request.result = { succeeded, failed };
  if (request.action === 'ban') state.globalBans[request.userId] = { reason: request.reason, approvedBy: interaction.user.id, requestedBy: request.requestedBy, requestId: request.id, at: Date.now() };
  if (request.action === 'unban') delete state.globalBans[request.userId];
  if (request.action === 'timeout') state.globalTimeouts[request.userId] = { expiresAt, reason: request.reason, approvedBy: interaction.user.id, requestedBy: request.requestedBy, requestId: request.id };
  if (request.action === 'untimeout') delete state.globalTimeouts[request.userId];
  saveState();
  await refreshApprovalMessage(interaction.client, request, interaction.message);
  await logSecurityIncident(interaction.guild, 'Global Action Executed', `**Action:** ${request.action}\n**Target:** <@${request.userId}>\n**Approved by:** ${interaction.user}\n**Successful servers:** ${succeeded}\n**Failed servers:** ${failed}\n**Request:** \`${request.id}\``, failed ? COLORS.warning : COLORS.success, { actorId: interaction.user.id, targetId: request.userId, requestId: request.id, action: request.action, succeeded, failed });
}

function newApproval(interaction, action, userId, reason, durationMs = null) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    guildId: interaction.guild.id,
    channelId: interaction.channelId,
    messageId: null,
    requestedBy: interaction.user.id,
    userId,
    action,
    reason,
    durationMs,
    stage: 'staff',
    status: 'pending',
    createdAt: Date.now(),
    resolvedBy: null,
    resolvedAt: null,
    result: null,
  };
}

async function refreshGuildHubsForPanel(guild, panelId) {
  const hubs = ticketState.hubs.filter(h => h.guildId === guild.id && h.panelIds.includes(panelId));
  for (const hub of hubs) {
    const panels = hub.panelIds.map(id => getPanel(id, guild.id)).filter(Boolean);
    if (!panels.length) continue;
    const channel = await guild.channels.fetch(hub.channelId).catch(() => null);
    const message = channel?.isTextBased() && hub.messageId ? await channel.messages.fetch(hub.messageId).catch(() => null) : null;
    if (!message) continue;
    await message.edit({ embeds: [buildTicketHubEmbed(guild, panels, hub.title, hub.description, hub.color)], components: buildHubRows(panels) }).catch(() => null);
  }
}

async function openTicket(interaction, panelId) {
  if (!hasActionPermission(interaction, 'ticket-create', true)) return interaction.reply({ content: 'You are not authorized to create tickets.', ephemeral: true });
  const panel = getPanel(panelId, interaction.guild.id);
  if (!panel) return interaction.reply({ content: 'That ticket panel no longer exists.', ephemeral: true });
  const existing = Object.values(ticketState.tickets).find(t => t.guildId === interaction.guild.id && t.panelId === panel.id && t.openerId === interaction.user.id && !t.deleted);
  if (existing) return interaction.reply({ embeds: [baseEmbed('Ticket Already Exists', `You already have ${existing.channelId ? `<#${existing.channelId}>` : 'a ticket'}.`, COLORS.warning)], ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  panel.ticketCounter += 1;
  const overwrites = [
    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ...panel.supportRoleIds.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
  ];
  const channel = await interaction.guild.channels.create({
    name: `${normalizeName(panel.name)}-${panel.ticketCounter}`.slice(0, 95),
    type: ChannelType.GuildText,
    parent: panel.categoryId ?? undefined,
    permissionOverwrites: overwrites,
  });
  const ticket = {
    channelId: channel.id,
    guildId: interaction.guild.id,
    panelId: panel.id,
    openerId: interaction.user.id,
    claimedBy: null,
    claimedAt: null,
    addedUserIds: [],
    closed: false,
    closedBy: null,
    createdAt: Date.now(),
    deleted: false,
  };
  ticketState.tickets[channel.id] = ticket;
  saveTickets();
  const pingText = panel.pingRoleIds.length ? panel.pingRoleIds.map(id => `<@&${id}>`).join(' ') : '';
  const welcome = String(panel.welcomeMessage || 'Welcome to your ticket. A member of the support team will be with you shortly. Please provide all relevant details so we can assist you quickly.')
    .replaceAll('{user}', `${interaction.user}`)
    .replaceAll('{username}', interaction.user.username)
    .replaceAll('{server}', interaction.guild.name)
    .replaceAll('{ticket}', `#${panel.ticketCounter}`);
  const welcomeEmbed = new EmbedBuilder()
    .setColor(panel.color ?? COLORS.primary)
    .setTitle(`Welcome • ${panel.name}`)
    .setDescription(welcome)
    .addFields(
      { name: 'Opened By', value: `${interaction.user}`, inline: true },
      { name: 'Department', value: panel.name, inline: true },
      { name: 'Ticket Number', value: `#${panel.ticketCounter}`, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: 'Support Tickets • Please describe your request clearly' });
  await channel.send({
    content: `${interaction.user} ${pingText}`.trim(),
    allowedMentions: { users: [interaction.user.id], roles: panel.pingRoleIds },
    embeds: [welcomeEmbed],
    components: [ticketButtons(ticket)],
  });
  await interaction.editReply({ embeds: [baseEmbed('Ticket Created', `Your private ticket is ready: ${channel}`, COLORS.success)] });
}

async function createRoleRequest(interaction) {
  const role = interaction.options.getRole('role', true);
  if (role.managed || role.id === interaction.guild.id) return interaction.reply({ content: 'That role cannot be requested.', ephemeral: true });
  if (interaction.guild.id === MAIN_GUILD_ID && isProtectedSecurityRole(role.id)) {
    return interaction.reply({ content: 'Protected security roles cannot be obtained through role requests.', ephemeral: true });
  }
  const notes = interaction.options.getString('notes') ?? 'No notes provided.';
  const logId = state.roleLogs[interaction.guild.id];
  const logChannel = logId ? await interaction.guild.channels.fetch(logId).catch(() => null) : null;
  const request = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    guildId: interaction.guild.id,
    userId: interaction.user.id,
    roleId: role.id,
    notes,
    status: 'pending',
    createdAt: Date.now(),
    approvedBy: null,
    messageId: null,
    channelId: logChannel?.id ?? interaction.channelId,
  };
  state.roleRequests[request.id] = request;
  saveState();
  if (!logChannel?.isTextBased()) {
    return interaction.reply({ embeds: [baseEmbed('Role Request Submitted', `Requested **${role.name}**. No request log channel is configured, so an admin will need to review it manually.`, COLORS.success)], ephemeral: true });
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rolereq_approve:${request.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`rolereq_deny:${request.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );
  const msg = await logChannel.send({ embeds: [baseEmbed('Role Request', [`**User:** <@${request.userId}>`, `**Role:** <@&${request.roleId}>`, `**Notes:** ${truncate(notes, 800)}`, '**Status:** Waiting for staff review'].join('\n'), COLORS.warning)], components: [row] });
  request.messageId = msg.id;
  saveState();
  await interaction.reply({ embeds: [baseEmbed('Role Request Submitted', `Your request for **${role.name}** has been sent for review.`, COLORS.success)], ephemeral: true });
}

function scheduleTempRole(client, item) {
  const delay = item.expiresAt - Date.now();
  if (delay <= 0) return void removeTempRole(client, item);
  setTimeout(() => removeTempRole(client, item), Math.min(delay, 2_147_000_000));
}
async function removeTempRole(client, item) {
  if (item.expiresAt > Date.now()) return scheduleTempRole(client, item);
  const guild = client.guilds.cache.get(item.guildId);
  const member = guild ? await guild.members.fetch(item.userId).catch(() => null) : null;
  if (member) await member.roles.remove(item.roleId, 'Temporary role expired').catch(() => null);
  state.tempRoles = (state.tempRoles ?? []).filter(x => x.id !== item.id);
  saveState();
}

function commandData() {
  const commands = [];
  const add = c => commands.push(c);
  add(new SlashCommandBuilder().setName('help').setDescription('Show the full command directory.'));
  add(new SlashCommandBuilder().setName('features').setDescription('Show every bot feature.'));
  add(new SlashCommandBuilder().setName('ping').setDescription('Check bot latency.'));
  add(new SlashCommandBuilder().setName('server-info').setDescription('Show server information.').setDMPermission(false));
  add(new SlashCommandBuilder().setName('user-info').setDescription('Show member information.').addUserOption(o => o.setName('user').setDescription('Member to inspect')).setDMPermission(false));

  add(new SlashCommandBuilder().setName('ban').setDescription('Moderation and ban-log configuration.')
    .setDMPermission(false)
    .addSubcommand(sc => sc.setName('user').setDescription('Ban a user in this server.').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(sc => sc.setName('logs').setDescription('Set the global approval log channel.').addChannelOption(o => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(sc => sc.setName('status').setDescription('Show the approval log channel.')));
  add(new SlashCommandBuilder().setName('ban-logs').setDescription('Configure the dedicated global ban review channel.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('set').setDescription('Choose the ban request/review channel.').addChannelOption(o => o.setName('channel').setDescription('Ban review channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(sc => sc.setName('status').setDescription('Show the dedicated ban review channel.'))
    .addSubcommand(sc => sc.setName('disable').setDescription('Disable new global ban review posts.')));
  add(new SlashCommandBuilder().setName('kick').setDescription('Kick a member.').setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)));
  add(new SlashCommandBuilder().setName('unban').setDescription('Unban a user from this server.').setDMPermission(false).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)));
  add(new SlashCommandBuilder().setName('timeout').setDescription('Timeout a member.').setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o => o.setName('duration').setDescription('e.g. 10m, 2h, 3d').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)));
  add(new SlashCommandBuilder().setName('untimeout').setDescription('Remove a member timeout.').setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)));
  add(new SlashCommandBuilder().setName('warn').setDescription('Warn a member.').setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)));
  add(new SlashCommandBuilder().setName('warnings').setDescription('View a member warning history.').setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)));
  add(new SlashCommandBuilder().setName('clearwarn').setDescription('Clear all warnings for a member.').setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)));
  add(new SlashCommandBuilder().setName('purge').setDescription('Delete recent messages.').setDMPermission(false).addIntegerOption(o => o.setName('amount').setDescription('1-100').setMinValue(1).setMaxValue(100).setRequired(true)));

  add(new SlashCommandBuilder().setName('global').setDescription('Submit secured cross-server moderation actions.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('ban').setDescription('Global ban request.').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(sc => sc.setName('kick').setDescription('Global kick request.').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(sc => sc.setName('timeout').setDescription('Global timeout request.').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)).addStringOption(o => o.setName('duration').setDescription('e.g. 10m, 2h').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true))));
  add(new SlashCommandBuilder().setName('unglobal').setDescription('Submit a secured cross-server undo action for approval.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('ban').setDescription('Global unban request.').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(sc => sc.setName('timeout').setDescription('Global untimeout request.').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true))));

  add(new SlashCommandBuilder().setName('permissions').setDescription('Owner-only command permission setup.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('set').setDescription('Assign one role to a command.').addStringOption(o => o.setName('command').setDescription('Choose a command from the list').setRequired(true).addChoices(...[...CONFIGURABLE_COMMANDS].slice(0,25).map(value => ({ name: `/${value}`, value })))).addRoleOption(o => o.setName('role').setDescription('Role allowed to use the command').setRequired(true)))
    .addSubcommand(sc => sc.setName('clear').setDescription('Remove a command permission role.').addStringOption(o => o.setName('command').setDescription('Choose a command from the list').setRequired(true).addChoices(...[...CONFIGURABLE_COMMANDS].map(value => ({ name: `/${value}`, value })))))
    .addSubcommand(sc => sc.setName('set-all').setDescription('Give a role access to all ordinary bot commands. Global moderation roles remain separately required.').addRoleOption(o => o.setName('role').setDescription('Role exempt from ordinary bot restrictions').setRequired(true)))
    .addSubcommand(sc => sc.setName('list').setDescription('Show configured command roles.')));

  add(new SlashCommandBuilder().setName('permission').setDescription('Owner-only fine-grained staff permission setup.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('set').setDescription('Allow a role or user to perform an action.')
      .addStringOption(o => o.setName('action').setDescription('Permission action').setRequired(true).addChoices(...PERMISSION_ACTIONS.map(([value,name]) => ({name,value}))))
      .addRoleOption(o => o.setName('role').setDescription('Authorized role'))
      .addUserOption(o => o.setName('user').setDescription('Authorized user')))
    .addSubcommand(sc => sc.setName('clear').setDescription('Clear a permission action.').addStringOption(o => o.setName('action').setDescription('Permission action').setRequired(true).addChoices(...PERMISSION_ACTIONS.map(([value,name]) => ({name,value})))))
    .addSubcommand(sc => sc.setName('list').setDescription('List configured action permissions.')));

  add(new SlashCommandBuilder().setName('sticky').setDescription('Manage persistent channel sticky messages.').setDMPermission(false)
    .addSubcommandGroup(group => group.setName('message').setDescription('Set, view, update, or remove a sticky message.')
      .addSubcommand(sc => sc.setName('set').setDescription('Set the channel sticky message.').addStringOption(o => o.setName('text').setDescription('Message text').setMaxLength(1800).setRequired(true)))
      .addSubcommand(sc => sc.setName('update').setDescription('Update the channel sticky message.').addStringOption(o => o.setName('text').setDescription('New message text').setMaxLength(1800).setRequired(true)))
      .addSubcommand(sc => sc.setName('view').setDescription('View the configured sticky message.'))
      .addSubcommand(sc => sc.setName('remove').setDescription('Remove the channel sticky message.'))));

  add(new SlashCommandBuilder().setName('data').setDescription('Owner-only runtime data backup tools.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('backup').setDescription('Download a full backup of bot and ticket runtime data.'))
    .addSubcommand(sc => sc.setName('status').setDescription('Show backup and runtime data status.')));

  add(new SlashCommandBuilder().setName('security').setDescription('Global moderation security controls.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('setup').setDescription('Owner-only global security setup.')
      .addRoleOption(o => o.setName('access-role').setDescription('Only role allowed to use global moderation').setRequired(true))
      .addRoleOption(o => o.setName('grant-role').setDescription('Only role allowed to grant global access').setRequired(true))
      .addRoleOption(o => o.setName('quarantine-role').setDescription('Role applied after unauthorized access grants').setRequired(true))
      .addChannelOption(o => o.setName('log-channel').setDescription('General security logs (not ban logs)').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(sc => sc.setName('status').setDescription('Show the hardened global-security configuration.'))
    .addSubcommand(sc => sc.setName('grant').setDescription('Grant the protected global-access role.').addUserOption(o => o.setName('user').setDescription('User to authorize').setRequired(true)))
    .addSubcommand(sc => sc.setName('revoke').setDescription('Remove the protected global-access role.').addUserOption(o => o.setName('user').setDescription('User to deauthorize').setRequired(true)))
    .addSubcommand(sc => sc.setName('quarantine').setDescription('Owner-only: quarantine a user.').addUserOption(o => o.setName('user').setDescription('User to quarantine').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(sc => sc.setName('unquarantine').setDescription('Owner-only: remove security quarantine.').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(sc => sc.setName('records').setDescription('Review stored global enforcement records.').addUserOption(o => o.setName('user').setDescription('Optional user to inspect')))
    .addSubcommand(sc => sc.setName('clear-record').setDescription('Owner-only: remove stored global enforcement for one user.').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand(sc => sc.setName('incidents').setDescription('Show recent security incidents.')));

  add(new SlashCommandBuilder().setName('ticket-panel').setDescription('Create and manage ticket panels.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('create').setDescription('Create a ticket panel.')
      .addStringOption(o => o.setName('name').setDescription('Panel name').setRequired(true))
      .addStringOption(o => o.setName('title').setDescription('Embed title').setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('Embed description').setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Panel channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addStringOption(o => o.setName('support-roles').setDescription('Role IDs/mentions, comma-separated').setRequired(true))
      .addChannelOption(o => o.setName('category').setDescription('Ticket category').addChannelTypes(ChannelType.GuildCategory))
      .addChannelOption(o => o.setName('transcript-channel').setDescription('Transcript channel').addChannelTypes(ChannelType.GuildText))
      .addStringOption(o => o.setName('ping-roles').setDescription('Roles to ping when opened, comma-separated'))
      .addStringOption(o => o.setName('button-label').setDescription('Open button label'))
      .addStringOption(o => o.setName('button-style').setDescription('Discord button colour/style').addChoices(
        { name: 'Blurple', value: 'primary' },
        { name: 'Green', value: 'success' },
        { name: 'Red', value: 'danger' },
        { name: 'Grey', value: 'secondary' },
      ))
      .addStringOption(o => o.setName('button-emoji').setDescription('Optional button emoji'))
      .addStringOption(o => o.setName('embed-color').setDescription('Custom embed colour in hex, e.g. #7C3AED'))
      .addStringOption(o => o.setName('embed-color-preset').setDescription('Choose an embed colour').addChoices(...EMBED_COLOR_CHOICES.map(([name, value]) => ({ name, value }))))
      .addStringOption(o => o.setName('welcome-message').setDescription('Welcome message shown inside tickets')))
    .addSubcommand(sc => sc.setName('edit').setDescription('Edit a ticket panel appearance and text.')
      .addIntegerOption(o => o.setName('id').setDescription('Panel ID').setMinValue(1).setRequired(true))
      .addStringOption(o => o.setName('title').setDescription('New embed title'))
      .addStringOption(o => o.setName('description').setDescription('New embed description'))
      .addStringOption(o => o.setName('embed-color').setDescription('Custom embed colour in hex, e.g. #7C3AED'))
      .addStringOption(o => o.setName('embed-color-preset').setDescription('Choose an embed colour').addChoices(...EMBED_COLOR_CHOICES.map(([name, value]) => ({ name, value }))))
      .addStringOption(o => o.setName('button-label').setDescription('New button label'))
      .addStringOption(o => o.setName('button-style').setDescription('Discord button colour/style').addChoices(
        { name: 'Blurple', value: 'primary' },
        { name: 'Green', value: 'success' },
        { name: 'Red', value: 'danger' },
        { name: 'Grey', value: 'secondary' },
      ))
      .addStringOption(o => o.setName('button-emoji').setDescription('Optional button emoji'))
      .addStringOption(o => o.setName('welcome-message').setDescription('New ticket welcome message')))
    .addSubcommand(sc => sc.setName('list').setDescription('List ticket panels.'))
    .addSubcommand(sc => sc.setName('hub').setDescription('Post a polished ticket hub.').addChannelOption(o => o.setName('channel').setDescription('Hub channel').addChannelTypes(ChannelType.GuildText).setRequired(true)).addStringOption(o => o.setName('panel-ids').setDescription('Panel IDs, comma-separated (max 5)').setRequired(true)).addStringOption(o => o.setName('title').setDescription('Hub title')).addStringOption(o => o.setName('description').setDescription('Hub description')).addStringOption(o => o.setName('embed-color').setDescription('Custom hub embed colour in hex')).addStringOption(o => o.setName('embed-color-preset').setDescription('Choose a hub embed colour').addChoices(...EMBED_COLOR_CHOICES.map(([name, value]) => ({ name, value })))))
    .addSubcommand(sc => sc.setName('hub-edit').setDescription('Edit an existing ticket hub.').addIntegerOption(o => o.setName('id').setDescription('Hub ID').setMinValue(1).setRequired(true)).addStringOption(o => o.setName('title').setDescription('New hub title')).addStringOption(o => o.setName('description').setDescription('New hub description')).addStringOption(o => o.setName('embed-color').setDescription('Custom hub embed colour in hex')).addStringOption(o => o.setName('embed-color-preset').setDescription('Choose a hub embed colour').addChoices(...EMBED_COLOR_CHOICES.map(([name, value]) => ({ name, value })))).addStringOption(o => o.setName('panel-ids').setDescription('New panel IDs, comma-separated (max 5)')))
    .addSubcommand(sc => sc.setName('delete').setDescription('Delete a ticket panel.').addIntegerOption(o => o.setName('id').setDescription('Panel ID').setMinValue(1).setRequired(true))));
  add(new SlashCommandBuilder().setName('ticket').setDescription('Manage the current ticket.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('claim').setDescription('Claim the current ticket.'))
    .addSubcommand(sc => sc.setName('add').setDescription('Add a member to the current ticket.').addUserOption(o => o.setName('user').setDescription('Member to add').setRequired(true)))
    .addSubcommand(sc => sc.setName('remove').setDescription('Remove an added member from the current ticket.').addUserOption(o => o.setName('user').setDescription('Member to remove').setRequired(true)))
    .addSubcommand(sc => sc.setName('close').setDescription('Close the current ticket.'))
    .addSubcommand(sc => sc.setName('reopen').setDescription('Reopen the current ticket.'))
    .addSubcommand(sc => sc.setName('rename').setDescription('Rename the current ticket.').addStringOption(o => o.setName('name').setDescription('New name').setRequired(true)))
    .addSubcommand(sc => sc.setName('delete').setDescription('Delete the current ticket.')));

  add(new SlashCommandBuilder().setName('welcome').setDescription('Configure welcome messages.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('setup').setDescription('Set the welcome channel and message.').addChannelOption(o => o.setName('channel').setDescription('Welcome channel').addChannelTypes(ChannelType.GuildText).setRequired(true)).addStringOption(o => o.setName('message').setDescription('Supports {user}, {username}, {server}, {memberCount}').setRequired(true)))
    .addSubcommand(sc => sc.setName('disable').setDescription('Disable welcome messages.'))
    .addSubcommand(sc => sc.setName('test').setDescription('Send a sample welcome message.'))
    .addSubcommand(sc => sc.setName('status').setDescription('Show welcome configuration.')));
  add(new SlashCommandBuilder().setName('auto-role').setDescription('Configure automatic join roles.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('set').setDescription('Set the join role.').addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand(sc => sc.setName('disable').setDescription('Disable the automatic role.'))
    .addSubcommand(sc => sc.setName('status').setDescription('Show the configured join role.')));

  add(new SlashCommandBuilder().setName('request').setDescription('Member requests and log configuration.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('role').setDescription('Request a role.').addRoleOption(o => o.setName('role').setDescription('Role you want').setRequired(true)).addStringOption(o => o.setName('notes').setDescription('Optional notes')))
    .addSubcommand(sc => sc.setName('logs').setDescription('Set the role-request log channel.').addChannelOption(o => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(sc => sc.setName('status').setDescription('Show the role-request log channel.')));
  add(new SlashCommandBuilder().setName('role').setDescription('Role management.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('add').setDescription('Give a role to a member.').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand(sc => sc.setName('remove').setDescription('Remove a role from a member.').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand(sc => sc.setName('logs').setDescription('Set the role-request log channel.').addChannelOption(o => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(sc => sc.setName('status').setDescription('Show role log configuration.')));
  add(new SlashCommandBuilder().setName('temp').setDescription('Temporary role tools.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('role').setDescription('Give a role for a limited time.').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)).addStringOption(o => o.setName('duration').setDescription('e.g. 30m, 2h, 3d').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Optional reason'))));

  add(new SlashCommandBuilder().setName('giveaway').setDescription('Manage giveaways.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('start').setDescription('Start a giveaway.').addStringOption(o => o.setName('prize').setDescription('Prize').setRequired(true)).addStringOption(o => o.setName('duration').setDescription('e.g. 10m, 2h, 3d').setRequired(true)).addIntegerOption(o => o.setName('winners').setDescription('Winner count').setMinValue(1).setMaxValue(20)).addRoleOption(o => o.setName('role').setDescription('Optional role awarded to each winner')))
    .addSubcommand(sc => sc.setName('end').setDescription('End a giveaway early.').addStringOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true)))
    .addSubcommand(sc => sc.setName('reroll').setDescription('Reroll a giveaway.').addStringOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true))));

  add(new SlashCommandBuilder().setName('serverlog').setDescription('Configure server audit logging.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('setup').setDescription('Set the log channel and tracked events.').addChannelOption(o => o.setName('channel').setDescription('Log channel').addChannelTypes(ChannelType.GuildText).setRequired(true)).addStringOption(o => o.setName('events').setDescription('Comma-separated events; blank = all')))
    .addSubcommand(sc => sc.setName('status').setDescription('Show server log settings.'))
    .addSubcommand(sc => sc.setName('disable').setDescription('Disable server logging.')));

  return commands;
}

const commandList = commandData();
function featuresEmbed() {
  return baseEmbed('Bot Command Directory', [
    '**Moderation:** `/ban` `/unban` `/kick` `/timeout` `/untimeout` `/warn` `/warnings` `/clearwarn` `/purge`',
    '**Global Security:** `/global ban|kick|timeout` `/unglobal ban|timeout` • main Discord only',
    '**Owner Security Setup:** `/security setup|status|records|clear-record|incidents` `/permissions set|clear|set-all|list`',
    '**Data Safety:** `/data backup` `/data status` • primary owner + main Discord only',
    '**Protected Access:** `/security grant` `/security revoke`',
    '**Tickets:** `/ticket-panel create|edit|list|hub|hub-edit|delete` `/ticket claim|add|remove|close|reopen|rename|delete`',
    '**Roles:** `/request role` `/request logs` `/role add|remove|logs|status` `/temp role` `/auto-role set|disable|status`',
    '**Community:** `/welcome setup|disable|test|status` `/giveaway start|end|reroll`',
    '**Logging:** `/serverlog setup|status|disable` `/ban logs|status`',
    '**Utilities:** `/ping` `/server-info` `/user-info` `/help` `/features`',
  ].join('\n\n'));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
});

async function registerCommandsForGuild(guildId, rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN)) {
  const body = commandList
    .filter(c => guildId === MAIN_GUILD_ID || !MAIN_GUILD_ONLY_COMMANDS.has(c.toJSON().name))
    .map(c => c.toJSON());
  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId),
    { body }
  );
  console.log(`Registered ${body.length} slash commands in guild ${guildId}${guildId === MAIN_GUILD_ID ? ' (main security guild)' : ''}.`);
}

async function registerCommands(botClient = client) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  const guildIds = [...botClient.guilds.cache.keys()];

  if (guildIds.length === 0) {
    console.log('No guilds available for command registration yet.');
    return;
  }

  // Register commands separately in every server the bot is actually in.
  // This keeps command availability independent per guild and avoids locking
  // the ticket system to one DISCORD_GUILD_ID.
  await Promise.all(guildIds.map(id => registerCommandsForGuild(id, rest)));

  // Clear any legacy global registrations so the same commands do not appear twice.
  await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: [] }).catch(() => null);
}

async function handleCommand(interaction) {
  if (!interaction.guild && !['ping', 'help', 'features'].includes(interaction.commandName)) return;
  if (interaction.guild) {
    const access = commandAccessDecision(interaction);
    if (!access.ok) {
      await logSecurityIncident(
        interaction.guild,
        'Blocked Command Access',
        `**User:** ${interaction.user} (\`${interaction.user.id}\`)\n**Command:** \`/${interaction.commandName}\`\n**Reason:** ${access.reason}`,
        COLORS.warning,
        { actorId: interaction.user.id, command: interaction.commandName, reason: access.reason },
      ).catch(() => null);
      return interaction.reply({ content: access.reason, ephemeral: true });
    }
  }
  switch (interaction.commandName) {
    case 'help': return interaction.reply({ embeds: [featuresEmbed()] });
    case 'features': return interaction.reply({ embeds: [featuresEmbed()] });
    case 'ping': return interaction.reply({ embeds: [baseEmbed('Pong', `WebSocket latency: **${interaction.client.ws.ping}ms**`, COLORS.success)] });
    case 'server-info': {
      const g = interaction.guild;
      return interaction.reply({ embeds: [baseEmbed('Server Information', [`**Name:** ${g.name}`, `**ID:** ${g.id}`, `**Owner:** <@${g.ownerId}>`, `**Members:** ${g.memberCount}`, `**Channels:** ${g.channels.cache.size}`, `**Roles:** ${g.roles.cache.size}`].join('\n'))] });
    }
    case 'user-info': {
      const user = interaction.options.getUser('user') ?? interaction.user;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      return interaction.reply({ embeds: [baseEmbed('User Information', [`**User:** ${user}`, `**ID:** ${user.id}`, `**Bot:** ${user.bot ? 'Yes' : 'No'}`, `**Joined:** ${member?.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime()/1000)}:F>` : 'Unknown'}`, `**Roles:** ${member ? member.roles.cache.filter(r => r.id !== interaction.guild.id).size : 0}`].join('\n'))] });
    }
    case 'ban': {
      const sub = interaction.options.getSubcommand();
      if (sub === 'logs') {
        if (!isStaff(interaction)) return interaction.reply({ content: 'Manage Server permission required.', ephemeral: true });
        const channel = interaction.options.getChannel('channel', true);
        state.banLogs[interaction.guild.id] = channel.id; saveState();
        return interaction.reply({ embeds: [baseEmbed('Ban Approval Logs', `Ban approval requests will be posted in ${channel}.`, COLORS.success)] });
      }
      if (sub === 'status') {
        if (!isStaff(interaction)) return interaction.reply({ content: 'Manage Server permission required.', ephemeral: true });
        const id = state.banLogs[interaction.guild.id];
        return interaction.reply({ embeds: [baseEmbed('Ban Approval Status', id ? `Configured channel: <#${id}>.` : 'No approval channel configured. Use `/ban logs`.')] });
      }
      const target = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason', true);
      await interaction.deferReply({ ephemeral: true });
      await interaction.guild.members.ban(target.id, { reason });
      return interaction.editReply({ embeds: [baseEmbed('User Banned', `${target} was banned from this server.\n**Reason:** ${reason}`, COLORS.success)] });
    }
    case 'unban': {
      if (!hasPermission(interaction, PermissionFlagsBits.BanMembers)) return interaction.reply({ content: 'Ban Members permission required.', ephemeral: true });
      const target = interaction.options.getUser('user', true); const reason = interaction.options.getString('reason', true);
      await interaction.guild.members.unban(target.id, reason);
      return interaction.reply({ embeds: [baseEmbed('User Unbanned', `${target} was unbanned.\n**Reason:** ${reason}`, COLORS.success)] });
    }
    case 'ban-logs': {
      if (!isOwner(interaction.user.id) && !isStaff(interaction)) return interaction.reply({ content: 'You need staff permissions to configure ban logs.', ephemeral: true });
      const sub = interaction.options.getSubcommand();
      if (sub === 'set') {
        const channel = interaction.options.getChannel('channel', true);
        state.banLogs[interaction.guild.id] = channel.id; saveState();
        return interaction.reply({ embeds: [baseEmbed('Ban Review Channel Updated', `Global ban requests and their review controls will be posted in ${channel}. This is separate from general security logs.`, COLORS.success)], ephemeral: true });
      }
      if (sub === 'disable') {
        delete state.banLogs[interaction.guild.id]; saveState();
        return interaction.reply({ content: 'Ban review posting is disabled until a channel is configured.', ephemeral: true });
      }
      const id = state.banLogs[interaction.guild.id];
      return interaction.reply({ content: id ? `Ban review channel: <#${id}>` : 'No ban review channel configured. Use /ban-logs set.', ephemeral: true });
    }
    case 'kick': {
      if (!hasPermission(interaction, PermissionFlagsBits.KickMembers)) return interaction.reply({ content: 'Kick Members permission required.', ephemeral: true });
      const target = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason', true);
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (!member) return interaction.reply({ content: 'That user is not in this server.', ephemeral: true });
      await member.kick(reason);
      await logServerEvent(interaction.guild, 'memberLeave', `${target} was kicked by ${interaction.user}.`, `**Reason:** ${reason}`);
      return interaction.reply({ embeds: [baseEmbed('User Kicked', `${target} was kicked.\n**Reason:** ${reason}`, COLORS.success)] });
    }
    case 'timeout': {
      if (!hasPermission(interaction, PermissionFlagsBits.ModerateMembers)) return interaction.reply({ content: 'Moderate Members permission required.', ephemeral: true });
      const member = await interaction.guild.members.fetch(interaction.options.getUser('user', true).id).catch(() => null);
      const duration = parseDuration(interaction.options.getString('duration', true));
      const reason = interaction.options.getString('reason', true);
      if (!member || !duration) return interaction.reply({ content: 'Invalid member or duration. Use values such as 10m, 2h, or 3d.', ephemeral: true });
      await member.timeout(Math.min(duration, 28 * 86400000), reason);
      return interaction.reply({ embeds: [baseEmbed('Member Timed Out', `${member} was timed out.\n**Duration:** ${interaction.options.getString('duration', true)}\n**Reason:** ${reason}`, COLORS.success)] });
    }
    case 'warn': {
      if (!hasPermission(interaction, PermissionFlagsBits.ModerateMembers)) return interaction.reply({ content: 'Moderate Members permission required.', ephemeral: true });
      const target = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason', true);
      state.warnings[interaction.guild.id] ??= {};
      state.warnings[interaction.guild.id][target.id] ??= [];
      const warning = { id: `${Date.now()}`, moderatorId: interaction.user.id, reason, at: Date.now() };
      state.warnings[interaction.guild.id][target.id].push(warning); saveState();
      return interaction.reply({ embeds: [baseEmbed('Warning Issued', `${target} has been warned.\n**Reason:** ${reason}\n**Warning ID:** ${warning.id}`, COLORS.warning)] });
    }
    case 'warnings': {
      const target = interaction.options.getUser('user', true);
      const list = state.warnings[interaction.guild.id]?.[target.id] ?? [];
      const text = list.length ? list.map(w => `**${w.id}** • <@${w.moderatorId}> • <t:${Math.floor(w.at/1000)}:R>\n${w.reason}`).join('\n\n') : 'No warnings recorded.';
      return interaction.reply({ embeds: [baseEmbed(`Warnings • ${target.tag}`, truncate(text, 3900))] });
    }
    case 'clearwarn': {
      if (!hasPermission(interaction, PermissionFlagsBits.ModerateMembers)) return interaction.reply({ content: 'Moderate Members permission required.', ephemeral: true });
      const target = interaction.options.getUser('user', true);
      if (state.warnings[interaction.guild.id]) delete state.warnings[interaction.guild.id][target.id];
      saveState();
      return interaction.reply({ embeds: [baseEmbed('Warnings Cleared', `All warnings for ${target} were cleared.`, COLORS.success)] });
    }
    case 'untimeout': {
      if (!hasPermission(interaction, PermissionFlagsBits.ModerateMembers)) return interaction.reply({ content: 'Moderate Members permission required.', ephemeral: true });
      const member = await interaction.guild.members.fetch(interaction.options.getUser('user', true).id).catch(() => null);
      if (!member) return interaction.reply({ content: 'Member not found.', ephemeral: true });
      const reason = interaction.options.getString('reason', true);
      await member.timeout(null, reason);
      return interaction.reply({ embeds: [baseEmbed('Timeout Removed', `${member} is no longer timed out.\n**Reason:** ${reason}`, COLORS.success)] });
    }
    case 'purge': {
      const amount = interaction.options.getInteger('amount', true);
      const deleted = await interaction.channel.bulkDelete(amount, true);
      return interaction.reply({ content: `Deleted ${deleted.size} message(s).`, ephemeral: true });
    }
    case 'permission': {
      if (!isOwner(interaction.user.id)) return interaction.reply({ content: 'Only the primary owner can configure permissions.', ephemeral: true });
      const sub = interaction.options.getSubcommand();
      state.actionPermissions[interaction.guild.id] ??= {};
      if (sub === 'set') {
        const action = interaction.options.getString('action', true);
        const role = interaction.options.getRole('role');
        const user = interaction.options.getUser('user');
        if (!role && !user) return interaction.reply({ content: 'Choose a role, a user, or both.', ephemeral: true });
        if (role && (role.managed || role.id === interaction.guild.id)) return interaction.reply({ content: 'That role cannot be used for permissions.', ephemeral: true });
        const entry = state.actionPermissions[interaction.guild.id][action] ?? { roleIds: [], userIds: [] };
        if (role && !entry.roleIds.includes(role.id)) entry.roleIds.push(role.id);
        if (user && !entry.userIds.includes(user.id)) entry.userIds.push(user.id);
        state.actionPermissions[interaction.guild.id][action] = entry; saveState();
        return interaction.reply({ content: `Permission updated for **${action}**. ${role ? `Authorized role: ${role}. ` : ''}${user ? `Authorized user: ${user}.` : ''}`, ephemeral: true });
      }
      if (sub === 'clear') {
        const action = interaction.options.getString('action', true);
        delete state.actionPermissions[interaction.guild.id][action]; saveState();
        return interaction.reply({ content: `Cleared the configured permission for **${action}**. Commands fall back to their normal Discord permission checks.`, ephemeral: true });
      }
      const entries = Object.entries(state.actionPermissions[interaction.guild.id] ?? {});
      const text = entries.length ? entries.map(([action, entry]) => `**${action}** — roles: ${(entry.roleIds ?? []).map(id => `<@&${id}>`).join(', ') || 'none'}; users: ${(entry.userIds ?? []).map(id => `<@${id}>`).join(', ') || 'none'}`).join('\n') : 'No fine-grained action permissions configured.';
      return interaction.reply({ embeds: [baseEmbed('Action Permissions', truncate(text, 3900))], ephemeral: true });
    }
    case 'sticky': {
      const group = interaction.options.getSubcommandGroup();
      const sub = interaction.options.getSubcommand();
      if (group !== 'message') return interaction.reply({ content: 'Unknown sticky action.', ephemeral: true });
      if (!hasActionPermission(interaction, 'sticky-manage', hasPermission(interaction, PermissionFlagsBits.ManageMessages))) return interaction.reply({ content: 'You need Manage Messages or the configured sticky-manage permission.', ephemeral: true });
      const key = `${interaction.guild.id}:${interaction.channel.id}`;
      const current = state.stickyMessages[key];
      if (sub === 'view') return interaction.reply({ content: current ? `Sticky message in this channel:\n${current.content}` : 'No sticky message is configured for this channel.', ephemeral: true });
      if (sub === 'remove') {
        if (!current) return interaction.reply({ content: 'No sticky message is configured for this channel.', ephemeral: true });
        if (current.messageId) await interaction.channel.messages.delete(current.messageId).catch(() => null);
        delete state.stickyMessages[key]; saveState();
        return interaction.reply({ content: 'Sticky message removed.', ephemeral: true });
      }
      const content = interaction.options.getString('text', true);
      if (sub === 'update' && !current) return interaction.reply({ content: 'No sticky message exists here. Use /sticky message set first.', ephemeral: true });
      if (current?.messageId) await interaction.channel.messages.delete(current.messageId).catch(() => null);
      state.stickyMessages[key] = { guildId: interaction.guild.id, channelId: interaction.channel.id, content, messageId: null, updatedBy: interaction.user.id, updatedAt: Date.now() };
      const stickyMsg = await interaction.channel.send({ content, allowedMentions: { parse: [] } });
      state.stickyMessages[key].messageId = stickyMsg.id; saveState();
      return interaction.reply({ content: `Sticky message ${sub === 'update' ? 'updated' : 'set'} for this channel.`, ephemeral: true });
    }
    case 'data': {
      if (!isOwner(interaction.user.id)) return interaction.reply({ content: 'Only the primary security owner can use data backup tools.', ephemeral: true });
      if (interaction.guildId !== MAIN_GUILD_ID) return interaction.reply({ content: 'Data backup tools can only be used in the main Discord.', ephemeral: true });
      const sub = interaction.options.getSubcommand();
      if (sub === 'status') {
        const botBytes = fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE).size : 0;
        const ticketBytes = fs.existsSync(TICKET_FILE) ? fs.statSync(TICKET_FILE).size : 0;
        const last = state.security.lastManualBackupAt
          ? `<t:${Math.floor(state.security.lastManualBackupAt / 1000)}:F> (<t:${Math.floor(state.security.lastManualBackupAt / 1000)}:R>)`
          : 'No manual backup recorded yet';
        return interaction.reply({
          embeds: [baseEmbed('Data Backup Status', [
            `**Primary Owner:** <@${PRIMARY_OWNER_ID}>`,
            `**Bot Data:** ${botBytes.toLocaleString()} bytes`,
            `**Ticket Data:** ${ticketBytes.toLocaleString()} bytes`,
            `**Last Manual Backup:** ${last}`,
            `**Last Backup By:** ${state.security.lastManualBackupBy ? `<@${state.security.lastManualBackupBy}>` : 'N/A'}`,
            '',
            'Use `/data backup` before major updates. The backup excludes environment variables and the Discord bot token.',
          ].join('\n'), COLORS.primary)],
          ephemeral: true,
        });
      }
      if (sub === 'backup') {
        await interaction.deferReply({ ephemeral: true });
        const backup = buildDataBackup(interaction.user.id);
        await logSecurityIncident(
          interaction.guild,
          'Manual Data Backup Created',
          `${interaction.user} created a full runtime data backup.\n**Files:** bot state + ticket state + integrity manifest`,
          COLORS.success,
          { actorId: interaction.user.id, backupCreatedAt: backup.createdAt },
        ).catch(() => null);
        return interaction.editReply({
          content: 'Backup created. Save **all three attachments** somewhere safe before updating the bot. The manifest includes SHA-256 hashes so the data files can be integrity-checked later.',
          files: backup.files,
        });
      }
      return interaction.reply({ content: 'Unknown data action.', ephemeral: true });
    }
    case 'permissions': {
      if (!isOwner(interaction.user.id)) return interaction.reply({ content: 'Only the primary owner can manage permissions.', ephemeral: true });
      const sub = interaction.options.getSubcommand();
      state.commandPermissions[interaction.guild.id] ??= {};
      if (sub === 'set') {
        const command = interaction.options.getString('command', true);
        const role = interaction.options.getRole('role', true);
        if (!CONFIGURABLE_COMMANDS.has(command)) return interaction.reply({ content: `Choose a listed command: ${[...CONFIGURABLE_COMMANDS].map(c => `/${c}`).join(', ')}`, ephemeral: true });
        state.commandPermissions[interaction.guild.id][command] = role.id; saveState();
        return interaction.reply({ content: `Saved command role for /${command}: ${role}.`, ephemeral: true });
      }
      if (sub === 'clear') {
        const command = interaction.options.getString('command', true);
        delete state.commandPermissions[interaction.guild.id][command]; saveState();
        return interaction.reply({ content: `Cleared the legacy command-role entry for /${command}.`, ephemeral: true });
      }
      if (sub === 'set-all') {
        const role = interaction.options.getRole('role', true);
        if (role.managed || role.id === interaction.guild.id) return interaction.reply({ content: 'Choose a normal, assignable server role.', ephemeral: true });
        state.commandExemptRoleIds[interaction.guild.id] = role.id; saveState();
        return interaction.reply({ content: `${role} now bypasses ordinary bot command restrictions. This exemption does NOT grant /global ban, /global kick, or /global timeout; those still require the configured Global Moderation Access role or explicit action permission.`, ephemeral: true });
      }
      if (sub === 'list') {
        const roleId = state.commandExemptRoleIds[interaction.guild.id];
        const entries = Object.entries(state.commandPermissions[interaction.guild.id] ?? {}).map(([cmd,id]) => `/${cmd}: <@&${id}>`);
        return interaction.reply({ content: `**All-command exemption:** ${roleId ? `<@&${roleId}>` : 'not configured'}\n**Individual command roles:**\n${entries.join('\n') || 'None configured'}\n**Global ban/kick/timeout:** always require their separate global role/action permissions.`, ephemeral: true });
      }
      return interaction.reply({ content: 'Unknown permissions action.', ephemeral: true });
    }
    case 'security': {
      if (interaction.guild.id !== MAIN_GUILD_ID) return interaction.reply({ content: 'Global security controls only exist in the main Discord.', ephemeral: true });
      const sub = interaction.options.getSubcommand();
      if (sub === 'setup') {
        if (!isOwner(interaction.user.id)) return interaction.reply({ content: 'Only the primary security owner can change global security setup.', ephemeral: true });
        const accessRole = interaction.options.getRole('access-role', true);
        const grantRole = interaction.options.getRole('grant-role', true);
        const quarantineRole = interaction.options.getRole('quarantine-role', true);
        const logChannel = interaction.options.getChannel('log-channel', true);
        const me = interaction.guild.members.me;
        if (!me?.permissions.has(PermissionFlagsBits.ViewAuditLog) || !me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
          return interaction.reply({ content: 'WCRP Utilities needs **View Audit Log** and **Manage Roles** in the main Discord before security setup can be enabled.', ephemeral: true });
        }
        const logPerms = logChannel.permissionsFor(me);
        if (!logPerms?.has(PermissionFlagsBits.ViewChannel) || !logPerms?.has(PermissionFlagsBits.SendMessages) || !logPerms?.has(PermissionFlagsBits.EmbedLinks)) {
          return interaction.reply({ content: 'WCRP Utilities needs View Channel, Send Messages, and Embed Links in the selected security log channel.', ephemeral: true });
        }
        if (new Set([accessRole.id, grantRole.id, quarantineRole.id]).size !== 3) return interaction.reply({ content: 'Access, grant-authority, and quarantine roles must be three different roles.', ephemeral: true });
        if (roleHasDangerousSecurityPermission(quarantineRole)) return interaction.reply({ content: 'The quarantine role must not have Administrator, Manage Server/Roles/Channels/Webhooks, Ban, Kick, or Moderate Members permissions.', ephemeral: true });
        for (const role of [accessRole, grantRole, quarantineRole]) {
          if (!roleCanBeUsedForSecurity(role, interaction.guild)) return interaction.reply({ content: `${role} cannot be used. Make sure it is not managed and is below the bot's highest role.`, ephemeral: true });
        }
        state.security.globalAccessRoleId = accessRole.id;
        state.security.globalGrantRoleId = grantRole.id;
        state.security.quarantineRoleId = quarantineRole.id;
        state.security.logChannelId = logChannel.id;
        // Legacy role lists are deliberately cleared so old compromised permissions cannot carry forward.
        state.globalRoles = {};
        saveState();
        await logSecurityIncident(interaction.guild, 'Security Configuration Updated', `**Access role:** ${accessRole}\n**Grant authority:** ${grantRole}\n**Quarantine:** ${quarantineRole}\n**General security logs (not bans):** ${logChannel}\n**Ban approval logs:** configure separately with /ban-logs set`, COLORS.success, { actorId: interaction.user.id });
        return interaction.reply({ embeds: [baseEmbed('Global Security Locked In', `**Global commands:** ${accessRole} only\n**Who can grant that role:** ${grantRole} only (plus the primary owner)\n**Unauthorized protected-role grants:** the protected role is removed and the incident is logged; no automatic member quarantine\n**Global command location:** this Discord only\n**Logs:** ${logChannel}`, COLORS.success)], ephemeral: true });
      }
      if (sub === 'status') {
        if (!isOwner(interaction.user.id)) return interaction.reply({ content: 'Only the primary security owner can view security configuration.', ephemeral: true });
        const cfg = state.security;
        return interaction.reply({ embeds: [baseEmbed('Global Security Status', [
          `**Main Discord:** \`${MAIN_GUILD_ID}\``,
          `**Primary Owner:** <@${PRIMARY_OWNER_ID}>`,
          `**Global Access Role:** ${cfg.globalAccessRoleId ? `<@&${cfg.globalAccessRoleId}>` : 'NOT CONFIGURED'}`,
          `**Grant Authority Role:** ${cfg.globalGrantRoleId ? `<@&${cfg.globalGrantRoleId}>` : 'NOT CONFIGURED'}`,
          `**Quarantine Role:** ${cfg.quarantineRoleId ? `<@&${cfg.quarantineRoleId}>` : 'NOT CONFIGURED'}`,
          `**Security Log:** ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'NOT CONFIGURED'}`,
          `**Request Limit:** ${GLOBAL_REQUEST_LIMIT}/hour per operator + ${GLOBAL_REQUEST_COOLDOWN_MS / 1000}s cooldown`,
          '**Self approval:** blocked for non-owner operators',
        ].join('\n'), cfg.globalAccessRoleId && cfg.globalGrantRoleId && cfg.quarantineRoleId && cfg.logChannelId ? COLORS.success : COLORS.warning)], ephemeral: true });
      }
      if (sub === 'grant') {
        if (!hasGlobalGrantAuthority(interaction)) return interaction.reply({ content: 'You do not have the configured Global Access Grant Authority role.', ephemeral: true });
        const roleId = state.security.globalAccessRoleId;
        const role = roleId ? interaction.guild.roles.cache.get(roleId) : null;
        if (!role) return interaction.reply({ content: 'Global Access role is not configured. The primary owner must run `/security setup`.', ephemeral: true });
        const user = interaction.options.getUser('user', true);
        if (user.id === interaction.client.user.id) return interaction.reply({ content: 'The bot cannot be granted Global Moderation Access.', ephemeral: true });
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.reply({ content: 'That user is not in the main Discord.', ephemeral: true });
        markInternalRoleGrant(interaction.guild.id, member.id, role.id);
        await member.roles.add(role, `[Security] Global access granted by ${interaction.user.tag}`);
        await logSecurityIncident(interaction.guild, 'Global Access Granted', `${member} received ${role}.\n**Granted by:** ${interaction.user}`, COLORS.success, { actorId: interaction.user.id, targetId: member.id, roleId: role.id });
        return interaction.reply({ embeds: [baseEmbed('Global Access Granted', `${member} can now submit global moderation requests.`, COLORS.success)], ephemeral: true });
      }
      if (sub === 'revoke') {
        if (!hasGlobalGrantAuthority(interaction)) return interaction.reply({ content: 'You do not have the configured Global Access Grant Authority role.', ephemeral: true });
        const roleId = state.security.globalAccessRoleId;
        const role = roleId ? interaction.guild.roles.cache.get(roleId) : null;
        if (!role) return interaction.reply({ content: 'Global Access role is not configured.', ephemeral: true });
        const user = interaction.options.getUser('user', true);
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.reply({ content: 'That user is not in the main Discord.', ephemeral: true });
        markInternalRoleGrant(interaction.guild.id, member.id, role.id);
        await member.roles.remove(role, `[Security] Global access revoked by ${interaction.user.tag}`);
        await logSecurityIncident(interaction.guild, 'Global Access Revoked', `${member} lost ${role}.\n**Revoked by:** ${interaction.user}`, COLORS.warning, { actorId: interaction.user.id, targetId: member.id, roleId: role.id });
        return interaction.reply({ embeds: [baseEmbed('Global Access Revoked', `${member} can no longer submit global moderation requests.`, COLORS.success)], ephemeral: true });
      }
      if (sub === 'quarantine') {
        if (!isOwner(interaction.user.id)) return interaction.reply({ content: 'Only the primary security owner can manually quarantine users.', ephemeral: true });
        const user = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason', true);
        if (user.id === PRIMARY_OWNER_ID || user.id === interaction.guild.ownerId || user.id === interaction.client.user.id) return interaction.reply({ content: 'That account is protected from quarantine.', ephemeral: true });
        const result = await quarantineSecurityMembers(interaction.guild, [user.id], reason);
        await logSecurityIncident(interaction.guild, 'Manual Security Quarantine', `${user} was quarantined by ${interaction.user}.\n**Reason:** ${reason}`, COLORS.danger, { actorId: interaction.user.id, targetId: user.id });
        return interaction.reply({ embeds: [baseEmbed('User Quarantined', result.quarantined.includes(user.id) ? `${user} was quarantined.` : `WCRP Utilities could not apply the quarantine role to ${user}. Check role hierarchy.`, result.quarantined.includes(user.id) ? COLORS.success : COLORS.danger)], ephemeral: true });
      }
      if (sub === 'unquarantine') {
        if (!isOwner(interaction.user.id)) return interaction.reply({ content: 'Only the primary security owner can remove security quarantine.', ephemeral: true });
        const user = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason', true);
        const roleId = state.security.quarantineRoleId;
        const role = roleId ? interaction.guild.roles.cache.get(roleId) : null;
        if (!role) return interaction.reply({ content: 'The quarantine role is not configured or no longer exists.', ephemeral: true });
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.reply({ content: 'That user is not in the main Discord.', ephemeral: true });
        const quarantineRecord = state.securityQuarantines?.[interaction.guild.id]?.[member.id] ?? null;
        markInternalRoleGrant(interaction.guild.id, member.id, role.id);
        await member.roles.remove(role, `[Security] Unquarantined by ${interaction.user.tag}: ${reason}`);
        if (state.securityQuarantines?.[interaction.guild.id]) delete state.securityQuarantines[interaction.guild.id][member.id];
        saveState();
        await logSecurityIncident(interaction.guild, 'Security Quarantine Removed', `${member} was unquarantined by ${interaction.user}.\n**Reason:** ${reason}${quarantineRecord?.removedRoleIds?.length ? `\n**Previously stripped roles (not auto-restored):** ${quarantineRecord.removedRoleIds.map(id => `<@&${id}>`).join(', ')}` : ''}`, COLORS.success, { actorId: interaction.user.id, targetId: member.id });
        return interaction.reply({ embeds: [baseEmbed('Quarantine Removed', `${member} is no longer quarantined.${quarantineRecord?.removedRoleIds?.length ? `\n\nFor safety, WCRP Utilities did **not** automatically restore stripped privileged roles: ${quarantineRecord.removedRoleIds.map(id => `<@&${id}>`).join(', ')}` : ''}`, COLORS.success)], ephemeral: true });
      }
      if (sub === 'records') {
        if (!isOwner(interaction.user.id)) return interaction.reply({ content: 'Only the primary security owner can review global enforcement records.', ephemeral: true });
        const user = interaction.options.getUser('user');
        if (user) {
          const ban = state.globalBans[user.id];
          const timeout = state.globalTimeouts[user.id];
          return interaction.reply({ embeds: [baseEmbed(`Global Records • ${user.tag}`, `**Global Ban:** ${ban ? `Yes — ${truncate(ban.reason, 500)}` : 'No'}\n**Global Timeout:** ${timeout && timeout.expiresAt > Date.now() ? `Yes — expires <t:${Math.floor(timeout.expiresAt / 1000)}:R>` : 'No'}`)], ephemeral: true });
        }
        const bans = Object.entries(state.globalBans).slice(-15).map(([id, rec]) => `🚫 <@${id}> — ${truncate(rec.reason, 80)}`);
        const timeouts = Object.entries(state.globalTimeouts).filter(([, rec]) => rec.expiresAt > Date.now()).slice(-15).map(([id, rec]) => `⏳ <@${id}> — <t:${Math.floor(rec.expiresAt / 1000)}:R>`);
        return interaction.reply({ embeds: [baseEmbed('Global Enforcement Records', truncate([...bans, ...timeouts].join('\n') || 'No active global enforcement records.', 3900))], ephemeral: true });
      }
      if (sub === 'clear-record') {
        if (!isOwner(interaction.user.id)) return interaction.reply({ content: 'Only the primary security owner can clear enforcement records.', ephemeral: true });
        const user = interaction.options.getUser('user', true);
        delete state.globalBans[user.id];
        delete state.globalTimeouts[user.id];
        saveState();
        await logSecurityIncident(interaction.guild, 'Global Record Cleared', `Stored global enforcement for ${user} was removed by ${interaction.user}.`, COLORS.warning, { actorId: interaction.user.id, targetId: user.id });
        return interaction.reply({ embeds: [baseEmbed('Global Record Cleared', `Stored global ban/timeout enforcement for ${user} was removed. This does not automatically unban them from servers where they are already banned.`, COLORS.success)], ephemeral: true });
      }
      if (sub === 'incidents') {
        if (!isOwner(interaction.user.id)) return interaction.reply({ content: 'Only the primary security owner can view security incidents.', ephemeral: true });
        const items = state.securityIncidents.slice(-12).reverse();
        const text = items.length ? items.map(i => `**${i.id}** • ${i.type} • <t:${Math.floor(i.at / 1000)}:R>${i.actorId ? ` • <@${i.actorId}>` : ''}${i.targetId ? ` → <@${i.targetId}>` : ''}`).join('\n') : 'No security incidents recorded.';
        return interaction.reply({ embeds: [baseEmbed('Recent Security Incidents', truncate(text, 3900))], ephemeral: true });
      }
      return interaction.reply({ content: 'Unknown security action.', ephemeral: true });
    }
    case 'global':
    case 'unglobal': {
      if (interaction.guild.id !== MAIN_GUILD_ID) {
        await logSecurityIncident(interaction.guild, 'Blocked Foreign Global Command', `${interaction.user} attempted \`/${interaction.commandName}\` outside the main Discord.`, COLORS.danger, { actorId: interaction.user.id, command: interaction.commandName });
        return interaction.reply({ content: 'Global moderation commands can only be used in the main Discord.', ephemeral: true });
      }
      if (interaction.commandName === 'global' && !securityConfigReady(interaction.guild)) {
        return interaction.reply({ content: 'Global moderation is locked until `/security setup` is complete and all protected roles/channels still exist.', ephemeral: true });
      }
      if (interaction.commandName === 'global') {
        const requestedAction = interaction.options.getSubcommand();
        if (!hasGlobalRole(interaction) && !hasActionPermission(interaction, `global-${requestedAction}`, false)) return interaction.reply({ content: `You do not have permission to use /global ${requestedAction}.`, ephemeral: true });
      }
      const limit = globalRateLimit(interaction.user.id);
      if (!limit.ok) {
        await logSecurityIncident(interaction.guild, 'Global Request Rate Limited', `${interaction.user} was blocked by the global request safety limit.`, COLORS.warning, { actorId: interaction.user.id });
        return interaction.reply({ content: limit.reason, ephemeral: true });
      }
      const globalCommand = interaction.commandName === 'global';
      const sub = interaction.options.getSubcommand();
      const action = globalCommand ? sub : (sub === 'ban' ? 'unban' : 'untimeout');
      const reviewChannelId = action === 'ban' ? state.banLogs[MAIN_GUILD_ID] : state.security.logChannelId;
      const logChannel = reviewChannelId ? await interaction.guild.channels.fetch(reviewChannelId).catch(() => null) : null;
      if (!logChannel?.isTextBased()) return interaction.reply({ content: action === 'ban' ? 'The dedicated ban review channel is missing. Configure it with `/ban-logs set`. General security logs are configured separately with `/security setup`.' : 'The general security log channel is missing. Configure it with `/security setup`.', ephemeral: true });
      const user = interaction.options.getUser('user', true);
      const protectedReason = await protectedTargetReason(interaction.client, user.id);
      if (protectedReason && !isOwner(interaction.user.id)) {
        await logSecurityIncident(interaction.guild, 'Blocked Protected Target', `${interaction.user} attempted **${action}** against ${user}, who is ${protectedReason}.`, COLORS.danger, { actorId: interaction.user.id, targetId: user.id, action });
        return interaction.reply({ content: `That target is protected (${protectedReason}). Only the primary security owner can request action against protected staff.`, ephemeral: true });
      }
      if (user.id === PRIMARY_OWNER_ID || user.id === interaction.client.user.id) return interaction.reply({ content: 'That target is permanently protected from global moderation.', ephemeral: true });
      const reason = interaction.options.getString('reason', true);
      const durationMs = action === 'timeout' ? parseDuration(interaction.options.getString('duration', true)) : null;
      if (action === 'timeout' && !durationMs) return interaction.reply({ content: 'Invalid duration.', ephemeral: true });
      const request = newApproval(interaction, action, user.id, reason, durationMs);
      const actionLabel = action === 'ban' ? 'Global Ban Request' : action === 'kick' ? 'Global Kick Request' : action === 'timeout' ? 'Global Timeout Request' : action === 'unban' ? 'Global Unban Request' : 'Global Untimeout Request';
      if (action === 'ban') {
        request.immediateBanAttempted = true;
        request.bannedGuildIds = [];
        request.preexistingBanGuildIds = [];
        // Persist the request before touching any guild so a restart cannot orphan partial bans.
        state.approvals[request.id] = request;
        saveState();
        let immediateSucceeded = 0;
        let immediateFailed = 0;
        // Run guild checks concurrently so one slow/unavailable guild does not stall all other bans.
        await Promise.all([...interaction.client.guilds.cache.values()].map(async (guild) => {
          let alreadyBanned = false;
          try {
            await guild.bans.fetch(user.id);
            alreadyBanned = true;
          } catch (fetchError) {
            if (Number(fetchError?.code) !== 10026) {
              immediateFailed++;
              (request.immediateFailures ??= []).push({ guildId: guild.id, error: `Could not verify existing ban: ${String(fetchError?.message ?? fetchError).slice(0, 180)}` });
              return;
            }
          }
          if (alreadyBanned) {
            request.preexistingBanGuildIds.push(guild.id);
            return;
          }
          try {
            await guild.members.ban(user.id, { reason: `[Global Ban Request ${request.id}] ${reason}` });
            request.bannedGuildIds.push(guild.id);
            immediateSucceeded++;
          } catch (banError) {
            immediateFailed++;
            (request.immediateFailures ??= []).push({ guildId: guild.id, error: String(banError?.message ?? banError).slice(0, 180) });
          }
        }));
        saveState();
        request.immediateBanResult = { succeeded: immediateSucceeded, failed: immediateFailed };
        request.result = { succeeded: immediateSucceeded, failed: immediateFailed, immediate: true };
      }
      state.approvals[request.id] = request;
      saveState();
      const embed = await buildApprovalEmbed(interaction.client, request);
      let msg = null;
      try {
        msg = await logChannel.send({ embeds: [embed], components: approvalComponents(request) });
      } catch (postError) {
        request.status = 'failed';
        request.postingError = String(postError?.message ?? postError).slice(0, 300);
        if (action === 'ban') {
          const rollback = { succeeded: 0, failed: 0, guildResults: [] };
          for (const guildId of request.bannedGuildIds ?? []) {
            const guild = interaction.client.guilds.cache.get(guildId);
            if (!guild) { rollback.failed++; rollback.guildResults.push({ guildId, status: 'failed', error: 'Guild unavailable' }); continue; }
            try {
              await guild.members.unban(user.id, `[Global Ban Request ${request.id}] Review post failed; rollback`);
              rollback.succeeded++; rollback.guildResults.push({ guildId, status: 'unbanned' });
            } catch (err) {
              rollback.failed++; rollback.guildResults.push({ guildId, status: 'failed', error: String(err?.message ?? err).slice(0, 180) });
            }
          }
          request.reversalResult = rollback;
          request.result = { succeeded: rollback.succeeded, failed: rollback.failed, reversal: true, postingFailed: true };
        }
        saveState();
        await interaction.channel.send({ content: `Global ${action} request ${request.id} could not be posted to its review channel. ${action === 'ban' ? `Rollback: ${request.reversalResult.succeeded} bans reversed, ${request.reversalResult.failed} reversals failed.` : ''} Check bot channel permissions.`, allowedMentions: { parse: [] } }).catch(() => null);
        return interaction.reply({ content: `The review message could not be posted. ${action === 'ban' ? `The bot attempted to reverse its own bans (${request.reversalResult.succeeded} succeeded, ${request.reversalResult.failed} failed).` : 'No moderation action was executed.'} Check channel permissions and the audit record.`, ephemeral: true });
      }
      request.channelId = logChannel.id;
      request.messageId = msg.id;
      saveState();
      if (action === 'ban') {
        const thread = await createProofThread(msg, request, interaction.client).catch(() => null);
        if (thread) { request.threadId = thread.id; saveState(); }
      }
      if (action !== 'ban') await logSecurityIncident(interaction.guild, 'Global Request Created', `Action: ${action}\nTarget: ${user}\nRequester: ${interaction.user}\nRequest: ${request.id}`, COLORS.warning, { actorId: interaction.user.id, targetId: user.id, action, requestId: request.id });
      const notice = action === 'ban'
        ? `Global ban request ${request.id} for ${user.tag} started by ${interaction.user.tag}. Immediate bans: ${request.immediateBanResult.succeeded} succeeded, ${request.immediateBanResult.failed} failed. Review: ${logChannel}.`
        : `Global ${action} request ${request.id} for ${user.tag} was submitted by ${interaction.user.tag}. Review: ${logChannel}.`;
      await interaction.channel.send({ content: notice, allowedMentions: { parse: [] } }).catch(() => null);
      return interaction.reply({ embeds: [baseEmbed('Global Request Submitted', `**${actionLabel}** for ${user} was posted to ${logChannel}.\n\n**Request ID:** \`${request.id}\`\n${action === 'ban' ? `**Immediate bans:** ${request.immediateBanResult.succeeded} succeeded; ${request.immediateBanResult.failed} failed. Already-banned servers were left unchanged.` : 'A reviewer must decide this request.'}`, action === 'ban' && request.immediateBanResult.failed ? COLORS.warning : COLORS.success)], ephemeral: true });
    }
    case 'ticket-panel': {
      if (!isStaff(interaction)) return interaction.reply({ content: 'Manage Server permission required.', ephemeral: true });
      const sub = interaction.options.getSubcommand();
      if (sub === 'list') {
        const panels = ticketState.panels.filter(p => p.guildId === interaction.guild.id);
        return interaction.reply({ embeds: [baseEmbed('Ticket Panels', panels.length ? panels.map(p => `**#${p.id} — ${p.name}** → <#${p.channelId}> • ${p.ticketCounter} tickets`).join('\n') : 'No ticket panels configured.')] });
      }
      if (sub === 'delete') {
        const id = interaction.options.getInteger('id', true);
        const index = ticketState.panels.findIndex(p => p.id === id && p.guildId === interaction.guild.id);
        if (index === -1) return interaction.reply({ content: 'Panel not found.', ephemeral: true });
        const [panel] = ticketState.panels.splice(index, 1); saveTickets();
        if (panel.messageId) {
          const channel = await interaction.guild.channels.fetch(panel.channelId).catch(() => null);
          await channel?.messages.delete(panel.messageId).catch(() => null);
        }
        return interaction.reply({ embeds: [baseEmbed('Ticket Panel Deleted', `Panel #${id} was deleted.`, COLORS.success)] });
      }
      if (sub === 'edit') {
        const id = interaction.options.getInteger('id', true);
        const panel = getPanel(id, interaction.guild.id);
        if (!panel) return interaction.reply({ content: 'Panel not found.', ephemeral: true });
        const title = interaction.options.getString('title');
        const description = interaction.options.getString('description');
        const embedColor = interaction.options.getString('embed-color');
        const embedPreset = interaction.options.getString('embed-color-preset');
        const buttonLabel = interaction.options.getString('button-label');
        const buttonStyle = interaction.options.getString('button-style');
        const buttonEmoji = interaction.options.getString('button-emoji');
        const welcomeMessage = interaction.options.getString('welcome-message');
        if (title !== null) panel.title = title;
        if (description !== null) panel.description = description;
        if (embedColor !== null || embedPreset !== null) panel.color = resolveEmbedColor(embedColor, embedPreset, panel.color ?? COLORS.primary);
        if (buttonLabel !== null) panel.buttonLabel = buttonLabel;
        if (buttonStyle !== null) panel.buttonStyle = buttonStyle;
        if (buttonEmoji !== null) panel.buttonEmoji = buttonEmoji || null;
        if (welcomeMessage !== null) panel.welcomeMessage = welcomeMessage;
        saveTickets();
        await refreshGuildHubsForPanel(interaction.guild, panel.id);
        const channel = await interaction.guild.channels.fetch(panel.channelId).catch(() => null);
        const oldMessage = channel?.isTextBased() && panel.messageId ? await channel.messages.fetch(panel.messageId).catch(() => null) : null;
        if (oldMessage) {
          const button = makePanelOpenButton(panel);
          await oldMessage.edit({ embeds: [ticketPanelEmbed(panel, 'panel', interaction.guild)], components: [new ActionRowBuilder().addComponents(button)] }).catch(() => null);
        }
        return interaction.reply({ embeds: [baseEmbed('Ticket Panel Updated', `Panel **#${panel.id} — ${panel.name}** has been updated.`, COLORS.success)] });
      }
      if (sub === 'hub') {
        const channel = interaction.options.getChannel('channel', true);
        const ids = [...new Set(String(interaction.options.getString('panel-ids', true)).split(',').map(s => Number(s.trim())).filter(Number.isInteger))].slice(0, 5);
        const panels = ids.map(id => getPanel(id, interaction.guild.id)).filter(Boolean);
        if (!panels.length) return interaction.reply({ content: 'No valid panel IDs found.', ephemeral: true });
        const title = interaction.options.getString('title') ?? 'Ticket Selection';
        const description = interaction.options.getString('description') ?? 'Choose the support department you need below. Your ticket will be private and routed to the appropriate support team.';
        const hubColor = resolveEmbedColor(interaction.options.getString('embed-color'), interaction.options.getString('embed-color-preset'), panels[0]?.color ?? COLORS.primary);
        const hub = { id: Date.now(), guildId: interaction.guild.id, channelId: channel.id, panelIds: panels.map(p => p.id), title, description, color: hubColor, messageId: null };
        const message = await channel.send({ embeds: [buildTicketHubEmbed(interaction.guild, panels, title, description, hubColor)], components: buildHubRows(panels) });
        hub.messageId = message.id;
        ticketState.hubs.push(hub);
        saveTickets();
        return interaction.reply({ embeds: [baseEmbed('Ticket Hub Posted', `Hub **#${hub.id}** was posted in ${channel}.`, COLORS.success)] });
      }
      if (sub === 'hub-edit') {
        const id = interaction.options.getInteger('id', true);
        const hub = ticketState.hubs.find(h => h.id === id && h.guildId === interaction.guild.id);
        if (!hub) return interaction.reply({ content: 'Hub not found.', ephemeral: true });
        const title = interaction.options.getString('title');
        const description = interaction.options.getString('description');
        const embedColor = interaction.options.getString('embed-color');
        const embedPreset = interaction.options.getString('embed-color-preset');
        const panelIdsInput = interaction.options.getString('panel-ids');
        if (title !== null) hub.title = title;
        if (description !== null) hub.description = description;
        if (embedColor !== null || embedPreset !== null) hub.color = resolveEmbedColor(embedColor, embedPreset, hub.color ?? COLORS.primary);
        if (panelIdsInput !== null) hub.panelIds = [...new Set(panelIdsInput.split(',').map(v => Number(v.trim())).filter(Number.isInteger))].slice(0, 5);
        const panels = hub.panelIds.map(panelId => getPanel(panelId, interaction.guild.id)).filter(Boolean);
        if (!panels.length) return interaction.reply({ content: 'The hub has no valid panels.', ephemeral: true });
        const channel = await interaction.guild.channels.fetch(hub.channelId).catch(() => null);
        const message = channel?.isTextBased() && hub.messageId ? await channel.messages.fetch(hub.messageId).catch(() => null) : null;
        if (!message) return interaction.reply({ content: 'The original hub message could not be found. Create a new hub instead.', ephemeral: true });
        await message.edit({ embeds: [buildTicketHubEmbed(interaction.guild, panels, hub.title, hub.description, hub.color)], components: buildHubRows(panels) });
        saveTickets();
        return interaction.reply({ embeds: [baseEmbed('Ticket Hub Updated', `Hub **#${hub.id}** has been updated.`, COLORS.success)] });
      }
      const supportRoles = parseIds(interaction.options.getString('support-roles', true));
      const pingRoles = parseIds(interaction.options.getString('ping-roles') ?? '');
      if (!supportRoles.length) return interaction.reply({ content: 'Provide valid support role IDs or mentions.', ephemeral: true });
      const panel = {
        id: ticketState.nextPanelId++, guildId: interaction.guild.id,
        name: interaction.options.getString('name', true), title: interaction.options.getString('title', true),
        description: interaction.options.getString('description', true),
        channelId: interaction.options.getChannel('channel', true).id,
        categoryId: interaction.options.getChannel('category')?.id ?? null,
        transcriptChannelId: interaction.options.getChannel('transcript-channel')?.id ?? null,
        supportRoleIds: supportRoles, pingRoleIds: pingRoles,
        buttonLabel: interaction.options.getString('button-label') ?? 'Open Ticket',
        buttonStyle: interaction.options.getString('button-style') ?? 'primary',
        buttonEmoji: interaction.options.getString('button-emoji') ?? null,
        welcomeMessage: interaction.options.getString('welcome-message') ?? 'Welcome to your ticket. A member of the support team will be with you shortly. Please provide all relevant details so we can assist you quickly.',
        color: resolveEmbedColor(interaction.options.getString('embed-color'), interaction.options.getString('embed-color-preset'), COLORS.primary),
        ticketCounter: 0, messageId: null,
      };
      const channel = await interaction.guild.channels.fetch(panel.channelId);
      const openButton = makePanelOpenButton(panel);
      const msg = await channel.send({
        embeds: [ticketPanelEmbed(panel, 'panel', interaction.guild)],
        components: [new ActionRowBuilder().addComponents(openButton)]
      });
      panel.messageId = msg.id; ticketState.panels.push(panel); saveTickets();
      return interaction.reply({ embeds: [baseEmbed('Ticket Panel Created', `Panel **#${panel.id} — ${panel.name}** was posted in ${channel}.`, COLORS.success)] });
    }
    case 'ticket': {
      const ticket = getTicket(interaction.channelId);
      if (!ticket) return interaction.reply({ content: 'This channel is not a managed ticket.', ephemeral: true });
      const sub = interaction.options.getSubcommand();
      if (sub === 'claim') {
        if (!isStaff(interaction)) return interaction.reply({ content: 'Only staff can claim tickets.', ephemeral: true });
        ticket.claimedBy = interaction.user.id; ticket.claimedAt = Date.now();
        await interaction.channel.setName(`ticket-${normalizeName(interaction.user.username)}`.slice(0, 95)).catch(() => null); saveTickets();
        return interaction.reply({ embeds: [baseEmbed('Ticket Claimed', `${interaction.user} is now handling this ticket.`, COLORS.success)] });
      }
      if (sub === 'add' || sub === 'remove') {
        if (!isStaff(interaction)) return interaction.reply({ content: 'Only staff can add or remove members from tickets.', ephemeral: true });
        const user = interaction.options.getUser('user', true);
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.reply({ content: 'That member is not in this server.', ephemeral: true });
        ticket.addedUserIds ??= [];
        if (sub === 'add') {
          if (user.id === ticket.openerId) return interaction.reply({ content: 'The ticket opener already has access to this ticket.', ephemeral: true });
          const updated = await interaction.channel.permissionOverwrites.edit(user.id, {
            ViewChannel: true,
            SendMessages: !ticket.closed,
            ReadMessageHistory: true,
            AttachFiles: true,
            EmbedLinks: true,
          }, { reason: `Added to ticket by ${interaction.user.tag}` }).then(() => true).catch(() => false);
          if (!updated) return interaction.reply({ content: 'I could not update this channel’s permissions. Make sure the bot has **Manage Channels** and its role is high enough.', ephemeral: true });
          if (!ticket.addedUserIds.includes(user.id)) ticket.addedUserIds.push(user.id);
          saveTickets();
          return interaction.reply({ embeds: [baseEmbed('Member Added', `${user} can now access this ticket.${ticket.closed ? '\nThe ticket is closed, so they cannot send messages until it is reopened.' : ''}`, COLORS.success)] });
        }
        if (user.id === ticket.openerId) return interaction.reply({ content: 'You cannot remove the ticket opener. Close the ticket instead.', ephemeral: true });
        const panel = getPanelForTicket(ticket);
        const hasSupportRole = Boolean(panel?.supportRoleIds?.some(roleId => member.roles.cache.has(roleId)));
        if (hasSupportRole) return interaction.reply({ content: 'That member has one of this ticket panel’s support roles. Remove the support role or change the panel configuration if you need to revoke their ticket access.', ephemeral: true });
        const updated = await interaction.channel.permissionOverwrites.edit(user.id, {
          ViewChannel: false,
          SendMessages: false,
          ReadMessageHistory: false,
        }, { reason: `Removed from ticket by ${interaction.user.tag}` }).then(() => true).catch(() => false);
        if (!updated) return interaction.reply({ content: 'I could not revoke this member’s channel permissions. Make sure the bot has **Manage Channels** and its role is high enough.', ephemeral: true });
        ticket.addedUserIds = ticket.addedUserIds.filter(id => id !== user.id);
        saveTickets();
        const adminNote = member.permissions.has(PermissionFlagsBits.Administrator) ? '\n\n⚠️ This member has Administrator, which can bypass normal channel permission restrictions.' : '';
        return interaction.reply({ embeds: [baseEmbed('Member Removed', `${user} was removed from this ticket and their channel access was denied.${adminNote}`, COLORS.warning)] });
      }
      if (sub === 'rename') {
        if (!isStaff(interaction)) return interaction.reply({ content: 'Only staff can rename tickets.', ephemeral: true });
        const name = normalizeName(interaction.options.getString('name', true));
        await interaction.channel.setName(name).catch(() => null); ticket.name = name; saveTickets();
        return interaction.reply({ embeds: [baseEmbed('Ticket Renamed', `Ticket renamed to **${name}**.`, COLORS.success)] });
      }
      if (sub === 'delete') {
        if (!isStaff(interaction)) return interaction.reply({ content: 'Only staff can delete tickets.', ephemeral: true });
        await interaction.reply({ embeds: [baseEmbed('Deleting Ticket', 'This ticket will be permanently deleted shortly.', COLORS.danger)] });
        ticket.deleted = true; saveTickets();
        return setTimeout(() => interaction.channel.delete().catch(() => null), 1500);
      }
      if (sub === 'close' || sub === 'reopen') {
        if (!isStaff(interaction) && interaction.user.id !== ticket.openerId) return interaction.reply({ content: 'Only the ticket opener or staff can do this.', ephemeral: true });
        if (sub === 'close') {
          if (ticket.closed) return interaction.reply({ content: 'Ticket already closed.', ephemeral: true });
          ticket.closed = true; ticket.closedBy = interaction.user.id; ticket.closedAt = Date.now();
          await interaction.channel.permissionOverwrites.edit(ticket.openerId, { SendMessages: false }).catch(() => null);
          for (const userId of ticket.addedUserIds ?? []) await interaction.channel.permissionOverwrites.edit(userId, { SendMessages: false }).catch(() => null);
          await createTranscript(interaction.channel, ticket, getPanelForTicket(ticket));
          saveTickets();
          await interaction.reply({ embeds: [baseEmbed('Ticket Closed', `This ticket has been closed by ${interaction.user}.\n\nUse the controls below to reopen this ticket or permanently delete it.`, COLORS.warning)] });
          await interaction.channel.send({
            embeds: [baseEmbed('Ticket Controls', 'This ticket is currently closed. Choose an action below.', COLORS.primary)],
            components: [ticketButtons(ticket)]
          }).catch(() => null);
          return;
        }
        ticket.closed = false; ticket.closedBy = null; ticket.closedAt = null;
        await interaction.channel.permissionOverwrites.edit(ticket.openerId, { SendMessages: true }).catch(() => null);
        for (const userId of ticket.addedUserIds ?? []) await interaction.channel.permissionOverwrites.edit(userId, { SendMessages: true }).catch(() => null);
        saveTickets();
        return interaction.reply({ embeds: [baseEmbed('Ticket Reopened', `Reopened by ${interaction.user}.`, COLORS.success)], components: [ticketButtons(ticket)] });
      }
      return;
    }
    case 'welcome': {
      if (!isStaff(interaction)) return interaction.reply({ content: 'Manage Server permission required.', ephemeral: true });
      const sub = interaction.options.getSubcommand();
      if (sub === 'setup') {
        const channel = interaction.options.getChannel('channel', true); const message = interaction.options.getString('message', true);
        state.welcome[interaction.guild.id] = { channelId: channel.id, message }; saveState();
        return interaction.reply({ embeds: [baseEmbed('Welcome System Enabled', `New members will be welcomed in ${channel}.\n\n**Preview:** ${replaceWelcome(message, interaction.member)}`, COLORS.success)] });
      }
      if (sub === 'disable') { delete state.welcome[interaction.guild.id]; saveState(); return interaction.reply({ embeds: [baseEmbed('Welcome Disabled', 'Welcome messages are disabled for this server.', COLORS.success)] }); }
      if (sub === 'status') {
        const cfg = state.welcome[interaction.guild.id]; return interaction.reply({ embeds: [baseEmbed('Welcome Status', cfg ? `Channel: <#${cfg.channelId}>\nMessage: ${cfg.message}` : 'Welcome system is disabled.')] });
      }
      const cfg = state.welcome[interaction.guild.id]; if (!cfg) return interaction.reply({ content: 'Welcome system is not configured.', ephemeral: true });
      const channel = await interaction.guild.channels.fetch(cfg.channelId).catch(() => null); if (!channel?.isTextBased()) return interaction.reply({ content: 'Configured welcome channel is unavailable.', ephemeral: true });
      await channel.send({ embeds: [baseEmbed('Welcome Preview', replaceWelcome(cfg.message, interaction.member), COLORS.success)] });
      return interaction.reply({ content: 'Welcome preview sent.', ephemeral: true });
    }
    case 'auto-role': {
      if (!hasActionPermission(interaction, 'role-assign', false)) return interaction.reply({ content: 'Role assignment is not permitted for your account/roles.', ephemeral: true });
      const sub = interaction.options.getSubcommand();
      if (sub === 'set') { const role = interaction.options.getRole('role', true); if (interaction.guild.id === MAIN_GUILD_ID && isProtectedSecurityRole(role.id)) return interaction.reply({ content: 'Protected security roles cannot be used as an auto-role.', ephemeral: true }); state.autoRole[interaction.guild.id] = { roleId: role.id }; saveState(); return interaction.reply({ embeds: [baseEmbed('Auto Role Enabled', `New members will receive ${role}.`, COLORS.success)] }); }
      if (sub === 'disable') { delete state.autoRole[interaction.guild.id]; saveState(); return interaction.reply({ embeds: [baseEmbed('Auto Role Disabled', 'Automatic role assignment is disabled.', COLORS.success)] }); }
      const roleId = state.autoRole[interaction.guild.id]?.roleId; return interaction.reply({ embeds: [baseEmbed('Auto Role Status', roleId ? `Configured role: <@&${roleId}>` : 'No automatic role configured.')] });
    }
    case 'request': {
      const sub = interaction.options.getSubcommand();
      if (sub === 'role') return createRoleRequest(interaction);
      if (!isStaff(interaction)) return interaction.reply({ content: 'Manage Server permission required.', ephemeral: true });
      const channel = interaction.options.getChannel('channel'); if (sub === 'logs') { state.roleLogs[interaction.guild.id] = channel.id; saveState(); return interaction.reply({ embeds: [baseEmbed('Role Request Logs', `Requests will be posted in ${channel}.`, COLORS.success)] }); }
      const id = state.roleLogs[interaction.guild.id]; return interaction.reply({ embeds: [baseEmbed('Role Request Log Status', id ? `Configured channel: <#${id}>` : 'No role-request log channel configured.')] });
    }
    case 'role': {
      const sub = interaction.options.getSubcommand();
      if (sub === 'logs') { if (!isStaff(interaction)) return interaction.reply({ content: 'Manage Server permission required.', ephemeral: true }); const channel = interaction.options.getChannel('channel', true); state.roleLogs[interaction.guild.id] = channel.id; saveState(); return interaction.reply({ embeds: [baseEmbed('Role Request Logs', `Requests will be posted in ${channel}.`, COLORS.success)] }); }
      if (sub === 'status') { if (!isStaff(interaction)) return interaction.reply({ content: 'Manage Server permission required.', ephemeral: true }); const id = state.roleLogs[interaction.guild.id]; return interaction.reply({ embeds: [baseEmbed('Role Log Status', id ? `Configured channel: <#${id}>` : 'No role-request log channel configured.')] }); }
      if (!hasActionPermission(interaction, 'role-assign', false)) return interaction.reply({ content: 'Role assignment is not permitted for your account/roles.', ephemeral: true });
      const user = interaction.options.getUser('user', true); const role = interaction.options.getRole('role', true);
      if (interaction.guild.id === MAIN_GUILD_ID && isProtectedSecurityRole(role.id)) return interaction.reply({ content: 'Protected security roles can only be managed through `/security grant` and `/security revoke` (or directly by the primary owner).', ephemeral: true });
      if (role.managed || role.position >= interaction.guild.members.me.roles.highest.position) return interaction.reply({ content: 'I cannot manage that role. Move my highest role above it.', ephemeral: true });
      const member = await interaction.guild.members.fetch(user.id).catch(() => null); if (!member) return interaction.reply({ content: 'Member not found.', ephemeral: true });
      if (sub === 'add') { await member.roles.add(role, `Role added by ${interaction.user.tag}`); return interaction.reply({ embeds: [baseEmbed('Role Added', `${role} was added to ${member}.`, COLORS.success)] }); }
      await member.roles.remove(role, `Role removed by ${interaction.user.tag}`); return interaction.reply({ embeds: [baseEmbed('Role Removed', `${role} was removed from ${member}.`, COLORS.success)] });
    }
    case 'temp': {
      if (!hasActionPermission(interaction, 'role-assign', false)) return interaction.reply({ content: 'Role assignment is not permitted for your account/roles.', ephemeral: true });
      const role = interaction.options.getRole('role', true); const user = interaction.options.getUser('user', true); const durationMs = parseDuration(interaction.options.getString('duration', true));
      if (interaction.guild.id === MAIN_GUILD_ID && isProtectedSecurityRole(role.id)) return interaction.reply({ content: 'Protected security roles cannot be issued as temporary roles.', ephemeral: true });
      if (!durationMs) return interaction.reply({ content: 'Invalid duration.', ephemeral: true });
      if (role.managed || role.position >= interaction.guild.members.me.roles.highest.position) return interaction.reply({ content: 'I cannot manage that role.', ephemeral: true });
      const member = await interaction.guild.members.fetch(user.id).catch(() => null); if (!member) return interaction.reply({ content: 'Member not found.', ephemeral: true });
      await member.roles.add(role, `Temporary role by ${interaction.user.tag}`);
      state.tempRoles ??= [];
      const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`, guildId: interaction.guild.id, userId: user.id, roleId: role.id, expiresAt: Date.now() + durationMs, reason: interaction.options.getString('reason') ?? '' };
      state.tempRoles.push(item); saveState(); scheduleTempRole(interaction.client, item);
      return interaction.reply({ embeds: [baseEmbed('Temporary Role Added', `${role} was given to ${member} for **${interaction.options.getString('duration', true)}**.`, COLORS.success)] });
    }
    case 'giveaway': {
      if (!isStaff(interaction)) return interaction.reply({ content: 'Manage Server permission required.', ephemeral: true });
      const sub = interaction.options.getSubcommand();
      if (sub === 'start') {
        const durationMs = parseDuration(interaction.options.getString('duration', true)); if (!durationMs) return interaction.reply({ content: 'Invalid duration.', ephemeral: true });
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`; const prize = interaction.options.getString('prize', true); const winners = interaction.options.getInteger('winners') ?? 1; const role = interaction.options.getRole('role');
        if (role && !hasActionPermission(interaction, 'role-assign', false)) return interaction.reply({ content: 'You need the configured role-assign permission to create a role-reward giveaway.', ephemeral: true });
        if (role && interaction.guild.id === MAIN_GUILD_ID && isProtectedSecurityRole(role.id)) return interaction.reply({ content: 'Protected security roles cannot be used as giveaway rewards.', ephemeral: true });
        if (role && (role.managed || role.position >= interaction.guild.members.me.roles.highest.position)) return interaction.reply({ content: 'I cannot manage that giveaway reward role. Move my highest role above it.', ephemeral: true });
        const giveaway = { id, guildId: interaction.guild.id, channelId: interaction.channelId, messageId: null, prize, rewardRoleId: role?.id ?? null, winnerCount: winners, entrants: [], endsAt: Date.now() + durationMs, ended: false };
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`giveaway_enter:${id}`).setLabel('Enter Giveaway').setStyle(ButtonStyle.Success));
        const msg = await interaction.channel.send({ embeds: [baseEmbed('Giveaway', `**Prize:** ${prize}\n**Winners:** ${winners}${role ? `\n**Reward Role:** <@&${role.id}>` : ''}\n**Ends:** <t:${Math.floor(giveaway.endsAt/1000)}:R>\n\nClick the button below to enter.`, COLORS.primary)], components: [row] });
        giveaway.messageId = msg.id; state.giveaways[id] = giveaway; saveState(); scheduleGiveaway(interaction.client, giveaway);
        return interaction.reply({ embeds: [baseEmbed('Giveaway Started', `Giveaway **${id}** has started.`, COLORS.success)], ephemeral: true });
      }
      const id = interaction.options.getString('id', true); const giveaway = state.giveaways[id]; if (!giveaway || giveaway.guildId !== interaction.guild.id) return interaction.reply({ content: 'Giveaway not found.', ephemeral: true });
      if (sub === 'end') { await endGiveaway(interaction.client, giveaway, false); return interaction.reply({ embeds: [baseEmbed('Giveaway Ended', `Giveaway **${id}** was ended.`, COLORS.success)], ephemeral: true }); }
      if (!giveaway.ended) return interaction.reply({ content: 'End the giveaway before rerolling it.', ephemeral: true });
      if (giveaway.rewardRoleId && !hasActionPermission(interaction, 'role-assign', false)) return interaction.reply({ content: 'You need the configured role-assign permission to assign giveaway reward roles.', ephemeral: true });
      const winners = chooseWinners(giveaway.entrants, giveaway.winnerCount); if (giveaway.rewardRoleId && !(interaction.guild.id === MAIN_GUILD_ID && isProtectedSecurityRole(giveaway.rewardRoleId))) { for (const uid of winners) { const member = await interaction.guild.members.fetch(uid).catch(() => null); if (member) await member.roles.add(giveaway.rewardRoleId, 'Giveaway winner role').catch(() => null); } } const channel = await interaction.guild.channels.fetch(giveaway.channelId).catch(() => null); if (channel?.isTextBased()) await channel.send({ embeds: [baseEmbed('Giveaway Rerolled', winners.length ? winners.map(x => `<@${x}>`).join(', ') : 'No eligible entrants.', COLORS.success)] });
      return interaction.reply({ embeds: [baseEmbed('Giveaway Rerolled', 'A new winner selection was posted.', COLORS.success)], ephemeral: true });
    }
    case 'serverlog': {
      if (!isStaff(interaction)) return interaction.reply({ content: 'Manage Server permission required.', ephemeral: true });
      const sub = interaction.options.getSubcommand();
      if (sub === 'disable') { delete state.serverLogs[interaction.guild.id]; saveState(); return interaction.reply({ embeds: [baseEmbed('Server Logging Disabled', 'Audit logging is disabled.', COLORS.success)] }); }
      if (sub === 'status') { const cfg = state.serverLogs[interaction.guild.id]; return interaction.reply({ embeds: [baseEmbed('Server Logging Status', cfg ? `Channel: <#${cfg.channelId}>\nEvents: ${cfg.events.join(', ')}` : 'Server logging is disabled.')] }); }
      const channel = interaction.options.getChannel('channel', true); const input = interaction.options.getString('events'); const events = input ? input.split(',').map(s => s.trim()).filter(e => serverLogEvents().includes(e)) : serverLogEvents(); state.serverLogs[interaction.guild.id] = { channelId: channel.id, events }; saveState();
      return interaction.reply({ embeds: [baseEmbed('Server Logging Enabled', `Logs will go to ${channel}.\n**Events:** ${events.join(', ')}`, COLORS.success)] });
    }
    default: return;
  }
}

function chooseWinners(entrants, count) {
  const pool = [...new Set(entrants ?? [])]; const winners = [];
  while (pool.length && winners.length < count) winners.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return winners;
}
async function endGiveaway(client, giveaway, silent = false) {
  if (giveaway.ended) return;
  giveaway.ended = true; giveaway.winners = chooseWinners(giveaway.entrants, giveaway.winnerCount); saveState();
  const guild = client.guilds.cache.get(giveaway.guildId); const channel = guild ? await guild.channels.fetch(giveaway.channelId).catch(() => null) : null;
  if (!channel?.isTextBased()) return;
  const text = giveaway.winners?.length ? giveaway.winners.map(x => `<@${x}>`).join(', ') : 'No valid entrants.';
  if (giveaway.rewardRoleId && giveaway.winners?.length && !(guild.id === MAIN_GUILD_ID && isProtectedSecurityRole(giveaway.rewardRoleId))) { for (const uid of giveaway.winners) { const member = await guild.members.fetch(uid).catch(() => null); if (member) await member.roles.add(giveaway.rewardRoleId, 'Giveaway winner role').catch(() => null); } }
  const msg = await channel.messages.fetch(giveaway.messageId).catch(() => null);
  if (msg) await msg.edit({ embeds: [baseEmbed('Giveaway Ended', `**Prize:** ${giveaway.prize}\n**Winner(s):** ${text}`, COLORS.success)], components: [] }).catch(() => null);
  if (!silent) await channel.send({ embeds: [baseEmbed('Giveaway Concluded', `**Prize:** ${giveaway.prize}\n**Winner(s):** ${text}`, COLORS.success)] }).catch(() => null);
}
function scheduleGiveaway(client, giveaway) {
  const delay = giveaway.endsAt - Date.now(); if (delay <= 0) return endGiveaway(client, giveaway, true);
  setTimeout(() => endGiveaway(client, giveaway, true), Math.min(delay, 2_147_000_000));
}
async function createProofThread(message, request, client) {
  if (!message?.startThread || !request) return;
  const targetUser = await client.users.fetch(request.userId).catch(() => null);
  const requester = await client.users.fetch(request.requestedBy).catch(() => null);
  const targetName = targetUser?.username ? normalizeName(targetUser.username).slice(0, 28) : request.userId.slice(-6);
  const thread = await message.startThread({
    name: `evidence-${targetName}-${request.id.slice(-6)}`.slice(0, 100),
    autoArchiveDuration: 1440,
  }).catch(() => null);
  if (!thread) return;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`proof_remind:${request.requestedBy}`).setLabel('Remind Requester').setStyle(ButtonStyle.Secondary)
  );
  const embed = new EmbedBuilder()
    .setColor(COLORS.neutral)
    .setTitle('Evidence Review Thread')
    .setDescription('Keep all proof for this global action in this thread so the reviewer has one clean evidence trail before approving anything.')
    .addFields(
      { name: 'Target', value: targetUser ? `${targetUser}\n\`${request.userId}\`` : `<@${request.userId}>\n\`${request.userId}\``, inline: true },
      { name: 'Requested By', value: requester ? `${requester}\n\`${request.requestedBy}\`` : `<@${request.requestedBy}>\n\`${request.requestedBy}\``, inline: true },
      { name: 'Request ID', value: `\`${request.id}\``, inline: true },
      { name: 'Accepted Proof', value: 'Screenshots • clips • message links • audit evidence • relevant context', inline: false },
    )
    .setFooter({ text: 'WCRP Utilities • Evidence must be reviewed before approval' })
    .setTimestamp();
  await thread.send({
    content: `<@${request.requestedBy}> add the supporting proof for this request below.`,
    embeds: [embed],
    components: [row],
    allowedMentions: { users: [request.requestedBy] },
  }).catch(() => null);
  return thread;
}

async function handleButton(interaction) {
  const [type, id] = interaction.customId.split(':');
  if (type === 'ticket_select_hub') {
    const panel = getPanel(Number(interaction.values?.[0]), interaction.guild.id);
    if (!panel) return interaction.reply({ content: 'That ticket department is no longer available.', ephemeral: true });
    await interaction.reply({
      embeds: [ticketPanelEmbed(panel)],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`panel_open:${panel.id}`).setLabel((panel.buttonLabel || 'Open Ticket').slice(0, 80)).setStyle(ButtonStyle.Primary))],
      ephemeral: true
    });
    return;
  }
  if (type === 'panel_open') return openTicket(interaction, Number(id));
  if (type.startsWith('ticket_')) {
    const ticket = getTicket(id); if (!ticket || ticket.deleted) return interaction.reply({ content: 'This ticket no longer exists.', ephemeral: true });
    if (type === 'ticket_claim') {
      if (!isStaff(interaction)) return interaction.reply({ content: 'Only staff can claim tickets.', ephemeral: true });
      ticket.claimedBy = interaction.user.id; ticket.claimedAt = Date.now(); await interaction.channel.setName(`ticket-${normalizeName(interaction.user.username)}`.slice(0,95)).catch(()=>null); saveTickets();
      return interaction.reply({ embeds: [baseEmbed('Ticket Claimed', `${interaction.user} is now handling this ticket.`, COLORS.success)] });
    }
    if (type === 'ticket_close') {
      if (!isStaff(interaction) && interaction.user.id !== ticket.openerId) return interaction.reply({ content: 'Only the ticket opener or staff can close this ticket.', ephemeral: true });
      if (ticket.closed) return interaction.reply({ content: 'Ticket already closed.', ephemeral: true });
      ticket.closed = true;
      ticket.closedBy = interaction.user.id;
      ticket.closedAt = Date.now();
      await interaction.channel.permissionOverwrites.edit(ticket.openerId,{SendMessages:false}).catch(()=>null);
      for (const userId of ticket.addedUserIds ?? []) await interaction.channel.permissionOverwrites.edit(userId,{SendMessages:false}).catch(()=>null);
      await createTranscript(interaction.channel,ticket,getPanelForTicket(ticket));
      saveTickets();
      await interaction.update({ embeds: [baseEmbed('Ticket Closed', `Closed by ${interaction.user}.`, COLORS.warning)], components: [] });
      await interaction.channel.send({
        embeds: [baseEmbed('Ticket Controls', 'This ticket is now closed. Use the controls below to reopen it or permanently delete it.', COLORS.primary)],
        components: [ticketButtons(ticket)]
      }).catch(()=>null);
      return;
    }
    if (type === 'ticket_reopen') {
      if (!isStaff(interaction)) return interaction.reply({content:'Only staff can reopen tickets.',ephemeral:true});
      ticket.closed=false;
      ticket.closedBy=null;
      ticket.closedAt=null;
      await interaction.channel.permissionOverwrites.edit(ticket.openerId,{SendMessages:true}).catch(()=>null);
      for (const userId of ticket.addedUserIds ?? []) await interaction.channel.permissionOverwrites.edit(userId,{SendMessages:true}).catch(()=>null);
      saveTickets();
      await interaction.update({embeds:[baseEmbed('Ticket Reopened',`Reopened by ${interaction.user}.`,COLORS.success)],components:[]});
      await interaction.channel.send({
        embeds:[baseEmbed('Ticket Controls','This ticket is open again. Staff can claim it, close it, or delete it using the controls below.',COLORS.primary)],
        components:[ticketButtons(ticket)]
      }).catch(()=>null);
      return;
    }
    if (type === 'ticket_delete') { if (!isStaff(interaction)) return interaction.reply({content:'Only staff can delete tickets.',ephemeral:true}); ticket.deleted=true; saveTickets(); await interaction.update({embeds:[baseEmbed('Deleting Ticket','This ticket will be deleted shortly.',COLORS.danger)],components:[]}); return setTimeout(()=>interaction.channel.delete().catch(()=>null),1500); }
  }
  if (type === 'giveaway_enter') {
    const giveaway = state.giveaways[id]; if (!giveaway || giveaway.ended) return interaction.reply({ content:'This giveaway has ended.', ephemeral:true });
    if (giveaway.entrants.includes(interaction.user.id)) return interaction.reply({ content:'You are already entered.', ephemeral:true }); giveaway.entrants.push(interaction.user.id); saveState();
    return interaction.reply({ content:'You are entered into the giveaway.', ephemeral:true });
  }
  if (type.startsWith('approval_')) {
    const request = state.approvals[id];
    if (!request || request.status !== 'pending') return interaction.reply({ content:'This approval request is no longer active.', ephemeral:true });
    if (interaction.guildId !== MAIN_GUILD_ID || request.guildId !== MAIN_GUILD_ID) {
      await logSecurityIncident(interaction.guild, 'Blocked Foreign Approval Button', `${interaction.user} attempted to use a global approval button outside the main Discord.`, COLORS.danger, { actorId: interaction.user.id, requestId: request.id });
      return interaction.reply({ content: 'Global approvals are locked to the main Discord.', ephemeral: true });
    }
    if (!hasGlobalRole(interaction) && !(request.action === 'ban' && hasActionPermission(interaction, 'ban-approve', false))) {
      await logSecurityIncident(interaction.guild, 'Blocked Unauthorized Approval', `${interaction.user} attempted to review global request \`${request.id}\` without Global Moderation Access.`, COLORS.danger, { actorId: interaction.user.id, requestId: request.id });
      return interaction.reply({ content: 'You do not have Global Moderation Access.', ephemeral: true });
    }
    if (Date.now() - request.createdAt > GLOBAL_APPROVAL_TTL_MS) {
      request.status = 'denied';
      request.resolvedBy = interaction.user.id;
      request.resolvedAt = Date.now();
      request.result = { succeeded: 0, failed: 0, expired: true };
      saveState();
      await interaction.deferUpdate().catch(() => null);
      await refreshApprovalMessage(interaction.client, request, interaction.message);
      await logSecurityIncident(interaction.guild, 'Expired Global Request', `Request \`${request.id}\` expired after 30 minutes and was closed.`, COLORS.warning, { actorId: interaction.user.id, requestId: request.id, targetId: request.userId });
      return;
    }
    if (type === 'approval_ownership') {
      request.stage='ownership';
      request.advancedBy=interaction.user.id;
      request.advancedAt=Date.now();
      saveState();
      await interaction.deferUpdate().catch(()=>null);
      await refreshApprovalMessage(interaction.client,request,interaction.message);
      await logSecurityIncident(interaction.guild, 'Global Request Escalated', `${interaction.user} escalated request \`${request.id}\` to the primary owner.`, COLORS.warning, { actorId: interaction.user.id, requestId: request.id, targetId: request.userId });
      return;
    }
    if (request.stage === 'ownership' && !isOwner(interaction.user.id)) return interaction.reply({content:'This request is at ownership stage. Only the primary security owner can decide it.',ephemeral:true});
    if (type === 'approval_deny') {
      request.status = 'denied';
      request.resolvedBy = interaction.user.id;
      request.resolvedAt = Date.now();
      if (request.action === 'ban' && request.immediateBanAttempted) {
        const reversal = { succeeded: 0, failed: 0, guildResults: [] };
        for (const guildId of request.bannedGuildIds ?? []) {
          const guild = interaction.client.guilds.cache.get(guildId);
          if (!guild) { reversal.failed++; reversal.guildResults.push({ guildId, status: 'failed', error: 'Guild unavailable to bot' }); continue; }
          try {
            await guild.members.unban(request.userId, `[Global Ban Request ${request.id}] Denied by ${interaction.user.tag}`);
            reversal.succeeded++;
            reversal.guildResults.push({ guildId, status: 'unbanned' });
          } catch (err) {
            reversal.failed++;
            reversal.guildResults.push({ guildId, status: 'failed', error: String(err?.message ?? err).slice(0, 180) });
          }
        }
        request.reversalResult = reversal;
        request.result = { succeeded: reversal.succeeded, failed: reversal.failed, reversal: true };
        const target = await interaction.client.users.fetch(request.userId).catch(() => null);
        let inviteUrl = null;
        const inviteChannel = interaction.guild.systemChannel;
        if (inviteChannel?.isTextBased() && inviteChannel.permissionsFor(interaction.guild.members.me)?.has(PermissionFlagsBits.CreateInstantInvite)) {
          const invite = await inviteChannel.createInvite({ maxAge: 86400, maxUses: 1, unique: true, reason: `Denied global ban request ${request.id}` }).catch(() => null);
          if (invite) inviteUrl = invite.url;
        }
        if (!inviteUrl) request.inviteDelivery = 'invite-unavailable';
        else if (!target) request.inviteDelivery = 'target-unavailable';
        else {
          try { await target.send(`Your global ban request was denied by ${interaction.user.tag}. You may rejoin WCRP using this one-use invite: ${inviteUrl}`); request.inviteDelivery = 'dm-sent'; }
          catch { request.inviteDelivery = 'dm-failed'; }
        }
      }
      saveState();
      await interaction.deferUpdate().catch(() => null);
      await refreshApprovalMessage(interaction.client, request, interaction.message);
      if (request.threadId) {
        const thread = await interaction.client.channels.fetch(request.threadId).catch(() => null);
        if (thread?.isTextBased()) await thread.send(`Global ban denied by ${interaction.user.tag} for ${request.reason}. Reversal: ${request.reversalResult?.succeeded ?? 0} unbanned; ${request.reversalResult?.failed ?? 0} failed.`).catch(() => null);
      }
      await logSecurityIncident(interaction.guild, 'Global Request Denied', `Request ${request.id} denied by ${interaction.user.tag}. ${request.reversalResult ? `Reversal: ${request.reversalResult.succeeded} succeeded, ${request.reversalResult.failed} failed.` : ''}`, COLORS.warning, { actorId: interaction.user.id, requestId: request.id, targetId: request.userId, action: request.action, reversalResult: request.reversalResult });
      return;
    }
    if (!isOwner(interaction.user.id) && request.requestedBy === interaction.user.id && !(request.action === 'ban' && hasActionPermission(interaction, 'ban-approve', false))) {
      return interaction.reply({ content: 'You cannot approve your own global moderation request unless you hold the configured ban-approval permission.', ephemeral: true });
    }
    await executeGlobalAction(interaction, request);
    if (request.action === 'ban' && request.threadId) {
      const thread = await interaction.client.channels.fetch(request.threadId).catch(() => null);
      if (thread?.isTextBased()) await thread.send(`Global ban approved by ${interaction.user.tag} for ${request.reason}. Results: ${request.result?.succeeded ?? 0} guilds succeeded; ${request.result?.failed ?? 0} failed.`).catch(() => null);
    }
    return;
  }
  if (type.startsWith('rolereq_')) {
    const request = state.roleRequests[id]; if (!request || request.status !== 'pending') return interaction.reply({content:'This role request is no longer active.',ephemeral:true});
    if (!hasActionPermission(interaction, 'role-request-approve', false)) return interaction.reply({content:'You are not authorized to decide role requests.',ephemeral:true});
    if (type === 'rolereq_deny') { request.status='denied'; request.approvedBy=interaction.user.id; saveState(); await interaction.update({embeds:[baseEmbed('Role Request Denied',`Request from <@${request.userId}> for <@&${request.roleId}> was denied by ${interaction.user}.`,COLORS.danger)],components:[]}); return; }
    const member = await interaction.guild.members.fetch(request.userId).catch(()=>null); const role = interaction.guild.roles.cache.get(request.roleId); if (!member || !role) return interaction.reply({content:'Member or role is unavailable.',ephemeral:true});
    if (interaction.guild.id === MAIN_GUILD_ID && isProtectedSecurityRole(role.id)) { request.status='denied'; request.approvedBy=interaction.user.id; saveState(); return interaction.update({embeds:[baseEmbed('Role Request Denied','Protected security roles cannot be granted through role requests.',COLORS.danger)],components:[]}); }
    if (role.position >= interaction.guild.members.me.roles.highest.position) return interaction.reply({content:'I cannot assign that role due to role hierarchy.',ephemeral:true});
    await member.roles.add(role,`Role request approved by ${interaction.user.tag}`); request.status='approved'; request.approvedBy=interaction.user.id; saveState();
    await interaction.update({embeds:[baseEmbed('Role Request Approved',`${member} was given ${role}.\n**Approved by:** ${interaction.user}`,COLORS.success)],components:[]}); return;
  }
  if (type === 'proof_remind') {
    if (interaction.guildId !== MAIN_GUILD_ID || !hasGlobalRole(interaction)) return interaction.reply({content:'Only authorized global moderators in the main Discord can send proof reminders.',ephemeral:true});
    const thread = interaction.channel; await thread.send({content:`<@${id}> reminder: please provide proof for the global ban request.`,allowedMentions:{users:[id]}}); return interaction.reply({content:'Proof reminder sent.',ephemeral:true});
  }
}

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  await logServerEvent(newMember.guild, 'memberUpdate', `${newMember} was updated.`).catch(() => null);
  if (newMember.guild.id !== MAIN_GUILD_ID) return;

  const protectedAssignments = [
    { roleId: state.security.globalAccessRoleId, kind: 'global-access' },
    { roleId: state.security.globalGrantRoleId, kind: 'grant-authority' },
  ].filter(x => x.roleId && !oldMember.roles.cache.has(x.roleId) && newMember.roles.cache.has(x.roleId));

  for (const item of protectedAssignments) {
    if (consumeInternalRoleGrant(newMember.guild.id, newMember.id, item.roleId)) continue;

    await new Promise(resolve => setTimeout(resolve, 900));
    let actorId = await resolveRoleUpdateExecutor(newMember.guild, newMember.id, item.roleId);
    if (!actorId) {
      await new Promise(resolve => setTimeout(resolve, 1100));
      actorId = await resolveRoleUpdateExecutor(newMember.guild, newMember.id, item.roleId);
    }

    const actorMember = actorId ? await newMember.guild.members.fetch(actorId).catch(() => null) : null;
    const authorized = item.kind === 'grant-authority'
      ? actorId === PRIMARY_OWNER_ID
      : actorId === PRIMARY_OWNER_ID || Boolean(state.security.globalGrantRoleId && actorMember?.roles.cache.has(state.security.globalGrantRoleId));

    if (authorized) {
      await logSecurityIncident(
        newMember.guild,
        item.kind === 'grant-authority' ? 'Grant Authority Assigned' : 'Global Access Assigned',
        `${newMember} received <@&${item.roleId}>.\n**Assigned by:** ${actorId ? `<@${actorId}>` : 'Unknown'}`,
        COLORS.success,
        { actorId, targetId: newMember.id, roleId: item.roleId },
      ).catch(() => null);
      continue;
    }

    await newMember.roles.remove(item.roleId, '[Security] Unauthorized protected-role assignment').catch(() => null);
    // Never automatically quarantine a member from an audit-log guess. Security staff may
    // legitimately hold moderation permissions; remove the unauthorized protected role and log
    // the event for owner review instead of stripping roles or quarantining the grantor.
    const result = { quarantined: [], failed: actorId ? [] : [{ userId: newMember.id, error: 'Grantor could not be attributed; no automatic quarantine performed.' }] };
    await logSecurityIncident(
      newMember.guild,
      'Unauthorized Protected Role Grant',
      [
        `**Protected role:** <@&${item.roleId}> (${item.kind})`,
        `**Receiver:** ${newMember} (\`${newMember.id}\`)`,
        `**Grantor:** ${actorId ? `<@${actorId}> (\`${actorId}\`)` : 'Could not be attributed from audit logs'}`,
        '**Response:** protected role removed and incident logged for owner review. Automatic quarantine is disabled for role-grant events to prevent false positives.',
        `**Quarantined:** ${result.quarantined.length ? result.quarantined.map(id => `<@${id}>`).join(', ') : 'None'}`,
        result.failed.length ? `**Quarantine failures:** ${result.failed.map(x => `<@${x.userId}>`).join(', ')}` : null,
      ].filter(Boolean).join('\n'),
      COLORS.danger,
      { actorId, targetId: newMember.id, roleId: item.roleId, kind: item.kind },
    ).catch(() => null);
  }

  const quarantineRoleId = state.security.quarantineRoleId;
  const quarantineRemoved = quarantineRoleId && oldMember.roles.cache.has(quarantineRoleId) && !newMember.roles.cache.has(quarantineRoleId);
  if (quarantineRemoved && !consumeInternalRoleGrant(newMember.guild.id, newMember.id, quarantineRoleId)) {
    await new Promise(resolve => setTimeout(resolve, 900));
    let actorId = await resolveRoleUpdateExecutor(newMember.guild, newMember.id, quarantineRoleId);
    if (!actorId) {
      await new Promise(resolve => setTimeout(resolve, 1100));
      actorId = await resolveRoleUpdateExecutor(newMember.guild, newMember.id, quarantineRoleId);
    }
    if (actorId !== PRIMARY_OWNER_ID) {
      // Do not silently re-quarantine a member: record the change for owner review.
      await logSecurityIncident(
        newMember.guild,
        'Quarantine Role Removed',
        `**Member:** ${newMember}\n**Removed by:** ${actorId ? `<@${actorId}>` : 'Unknown'}\n**Response:** recorded for owner review; the bot did not re-apply quarantine automatically.`,
        COLORS.warning,
        { actorId, targetId: newMember.id, roleId: quarantineRoleId },
      ).catch(() => null);
    }
  }
});

client.on(Events.GuildMemberAdd, async member => {
  const ban = state.globalBans[member.id];
  if (ban?.requestId && ban?.approvedBy) { await member.ban({ reason: `[Global Ban • ${ban.requestId}] ${ban.reason}` }).catch(()=>null); return; }
  const gt = state.globalTimeouts[member.id]; if (gt?.requestId && gt?.approvedBy && gt.expiresAt > Date.now()) await member.timeout(gt.expiresAt-Date.now(), `[Global Timeout • ${gt.requestId}] ${gt.reason}`).catch(()=>null);
  const auto = state.autoRole[member.guild.id]?.roleId;
  if (auto && !(member.guild.id === MAIN_GUILD_ID && isProtectedSecurityRole(auto))) {
    const role = member.guild.roles.cache.get(auto);
    if (!role) {
      console.warn(`[AutoRole] Configured role ${auto} is missing in guild ${member.guild.id}.`);
      await logServerEvent(member.guild, 'autoRoleFailure', `Auto-role failed for ${member.user.tag}: configured role ${auto} no longer exists.`).catch(() => null);
    } else {
      await member.roles.add(role, 'Configured automatic join role').catch(async err => {
        console.warn(`[AutoRole] Failed for ${member.user.tag} in ${member.guild.id}: ${err?.message ?? err}`);
        await logServerEvent(member.guild, 'autoRoleFailure', `Could not assign ${role} to ${member.user.tag}. Check bot role hierarchy and Manage Roles permission. Error: ${err?.message ?? 'unknown error'}`).catch(() => null);
      });
    }
  }
  if (auto && member.guild.id === MAIN_GUILD_ID && isProtectedSecurityRole(auto)) {
    delete state.autoRole[member.guild.id]; saveState();
    await logSecurityIncident(member.guild, 'Unsafe Auto Role Disabled', `A legacy auto-role configuration attempted to use protected role <@&${auto}> and was automatically disabled.`, COLORS.danger, { targetId: member.id, roleId: auto }).catch(() => null);
  }
  const welcome = state.welcome[member.guild.id]; if (welcome) { const channel=await member.guild.channels.fetch(welcome.channelId).catch(()=>null); if(channel?.isTextBased()) await channel.send({embeds:[baseEmbed('Welcome',replaceWelcome(welcome.message,member),COLORS.success)]}).catch(()=>null); }
  await logServerEvent(member.guild,'memberJoin',`${member} joined the server.`);
});
client.on(Events.GuildMemberRemove, member => void logServerEvent(member.guild,'memberLeave',`${member.user.tag} left the server.`));
// Ban events are deliberately excluded from general server/security logs; global ban review records use /ban-logs.
client.on(Events.MessageCreate, async msg => {
  if (!msg.guild || msg.author?.bot || !msg.channel?.isTextBased()) return;
  const key = `${msg.guild.id}:${msg.channel.id}`;
  const sticky = state.stickyMessages[key];
  if (!sticky || msg.id === sticky.messageId) return;
  const previousId = sticky.messageId;
  // Debounce bursts and avoid repost loops: bot-authored messages are ignored above.
  if (sticky.reposting) return;
  sticky.reposting = true;
  try {
    if (previousId) {
      try { await msg.channel.messages.delete(previousId); }
      catch (err) {
        // Avoid creating duplicate sticky messages if the old message cannot be removed.
        console.warn(`[Sticky] Could not delete previous sticky ${previousId} in ${msg.guild.id}/${msg.channel.id}; refresh skipped: ${err?.message ?? err}`);
        return;
      }
    }
    const posted = await msg.channel.send({ content: sticky.content, allowedMentions: { parse: [] } });
    sticky.messageId = posted.id; sticky.updatedAt = Date.now(); saveState();
  } catch (err) {
    console.warn(`[Sticky] Failed to refresh sticky in ${msg.guild.id}/${msg.channel.id}: ${err?.message ?? err}`);
  } finally {
    sticky.reposting = false;
  }
});
client.on(Events.MessageDelete, msg => { if (msg.guild) void logServerEvent(msg.guild,'messageDelete',`A message was deleted in <#${msg.channelId}>.`, msg.author ? `**Author:** ${msg.author.tag}\n**Content:** ${truncate(msg.content,700)}` : ''); });
client.on(Events.MessageUpdate, (oldMsg,newMsg) => { if(newMsg.guild && oldMsg.content !== newMsg.content) void logServerEvent(newMsg.guild,'messageEdit',`A message was edited in <#${newMsg.channelId}>.`,`**Author:** ${newMsg.author?.tag ?? 'Unknown'}\n**Before:** ${truncate(oldMsg.content,350)}\n**After:** ${truncate(newMsg.content,350)}`); });
client.on(Events.ChannelCreate, channel => { if(channel.guild) void logServerEvent(channel.guild,'channelCreate',`Channel created: <#${channel.id}>.`); });
client.on(Events.ChannelDelete, channel => { if(channel.guild) void logServerEvent(channel.guild,'channelDelete',`Channel deleted: **${channel.name}**.`); });
client.on(Events.RoleCreate, role => void logServerEvent(role.guild,'roleCreate',`Role created: ${role}.`));
client.on(Events.RoleDelete, async role => {
  await logServerEvent(role.guild,'roleDelete',`Role deleted: **${role.name}**.`);
  if (role.guild.id !== MAIN_GUILD_ID) return;
  const protectedField = role.id === state.security.globalAccessRoleId ? 'globalAccessRoleId'
    : role.id === state.security.globalGrantRoleId ? 'globalGrantRoleId'
      : role.id === state.security.quarantineRoleId ? 'quarantineRoleId' : null;
  if (!protectedField) return;
  await new Promise(resolve => setTimeout(resolve, 900));
  const logs = await role.guild.fetchAuditLogs({ type: AuditLogEvent.RoleDelete, limit: 6 }).catch(() => null);
  const entry = logs ? [...logs.entries.values()].find(e => e.targetId === role.id && Date.now() - e.createdTimestamp < 15_000) : null;
  const actorId = entry?.executorId ?? entry?.executor?.id ?? null;
  state.security[protectedField] = null;
  saveState();
  // Protected role deletion is logged and global moderation fails closed; no automatic quarantine.
  await logSecurityIncident(role.guild, 'Protected Security Role Deleted', `**Role:** ${role.name} (\`${role.id}\`)\n**Deleted by:** ${actorId ? `<@${actorId}>` : 'Unknown'}\n**Response:** Global moderation failed closed until the primary owner runs \`/security setup\` again.\n**Automatic quarantine:** disabled; owner review required`, COLORS.danger, { actorId, roleId: role.id, protectedField });
});
client.on(Events.ThreadCreate, thread => void logServerEvent(thread.guild,'threadCreate',`Thread created: **${thread.name}**.`));
client.on(Events.ThreadDelete, thread => void logServerEvent(thread.guild,'threadDelete',`Thread deleted: **${thread.name}**.`));

client.on(Events.ChannelUpdate, (oldChannel, newChannel) => { if (newChannel.guild) void logServerEvent(newChannel.guild, 'channelUpdate', `Channel updated: <#${newChannel.id}>.`, `**Before:** ${oldChannel.name}\n**After:** ${newChannel.name}`); });
client.on(Events.RoleUpdate, async (oldRole, newRole) => {
  await logServerEvent(newRole.guild, 'roleUpdate', `Role updated: ${newRole}.`, `**Before:** ${oldRole.name}\n**After:** ${newRole.name}`);
  if (newRole.guild.id !== MAIN_GUILD_ID || !isProtectedSecurityRole(newRole.id)) return;
  if (consumeInternalRoleEdit(newRole.guild.id, newRole.id)) return;
  const materiallyChanged = oldRole.name !== newRole.name || oldRole.permissions.bitfield !== newRole.permissions.bitfield || oldRole.color !== newRole.color || oldRole.hoist !== newRole.hoist || oldRole.mentionable !== newRole.mentionable;
  if (!materiallyChanged) return;
  await new Promise(resolve => setTimeout(resolve, 900));
  const logs = await newRole.guild.fetchAuditLogs({ type: AuditLogEvent.RoleUpdate, limit: 6 }).catch(() => null);
  const entry = logs ? [...logs.entries.values()].find(e => e.targetId === newRole.id && Date.now() - e.createdTimestamp < 15_000) : null;
  const actorId = entry?.executorId ?? entry?.executor?.id ?? null;
  if (actorId === PRIMARY_OWNER_ID) return;
  markInternalRoleEdit(newRole.guild.id, newRole.id);
  await newRole.edit({ name: oldRole.name, permissions: oldRole.permissions, color: oldRole.color, hoist: oldRole.hoist, mentionable: oldRole.mentionable }, '[Security] Reverting unauthorized protected-role modification').catch(() => null);
  await logSecurityIncident(newRole.guild, 'Protected Security Role Modified', `**Role:** ${newRole}\n**Modified by:** ${actorId ? `<@${actorId}>` : 'Unknown'}\n**Response:** attempted rollback; no automatic quarantine, owner review required`, COLORS.danger, { actorId, roleId: newRole.id });
});
client.on(Events.GuildUpdate, (oldGuild, newGuild) => void logServerEvent(newGuild, 'guildUpdate', 'Server settings were updated.', `**Before:** ${oldGuild.name}\n**After:** ${newGuild.name}`));
client.on(Events.InviteCreate, invite => { if (invite.guild) void logServerEvent(invite.guild, 'inviteCreate', `Invite created: ${invite.code}.`, invite.inviter ? `**Created by:** ${invite.inviter}` : ''); });
client.on(Events.InviteDelete, invite => { if (invite.guild) void logServerEvent(invite.guild, 'inviteDelete', `Invite deleted: ${invite.code}.`); });

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) await handleCommand(interaction);
    else if (interaction.isButton()) await handleButton(interaction);
  } catch (err) {
    console.error('Interaction error:', err);
    await safeReply(interaction, { content: 'Something went wrong while handling that action.', ephemeral: true }).catch(()=>null);
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try { await registerCommands(); } catch (err) { console.error('Command registration failed:', err); }
  for (const item of state.tempRoles ?? []) scheduleTempRole(client, item);
  for (const giveaway of Object.values(state.giveaways ?? {})) if (!giveaway.ended) scheduleGiveaway(client, giveaway);
  console.log(`Loaded ${Object.keys(state.approvals).length} approvals, ${Object.keys(state.giveaways).length} giveaways, ${ticketState.panels.length} ticket panels, ${ticketState.hubs.length} ticket hubs.`);
});

async function main() {
  if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_CLIENT_ID) throw new Error('DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required.');
  state.tempRoles ??= [];
  const closedUnsafeApprovals = applyHardenedSecurityMigration();
  if (closedUnsafeApprovals) console.warn(`[Security] Closed ${closedUnsafeApprovals} pending pre-hardening global approval(s).`);
  saveState(); saveTickets();
  await client.on(Events.GuildCreate, async (guild) => {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
    await registerCommandsForGuild(guild.id, rest);
    console.log(`Registered commands for newly joined guild ${guild.id}.`);
  } catch (err) {
    console.error(`Failed to register commands for newly joined guild ${guild.id}:`, err);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
}

module.exports = { commandData, parseDuration, normalizeName, parseIds };

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });
