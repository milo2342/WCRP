require('dotenv').config();

const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
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

const COLORS = {
  primary: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  neutral: 0x2b2d31,
};

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
};

const defaultTicketState = {
  nextPanelId: 1,
  panels: [],
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
if (!Array.isArray(ticketState.panels)) ticketState.panels = [];
if (!ticketState.tickets || typeof ticketState.tickets !== 'object') ticketState.tickets = {};
if (!Number.isInteger(ticketState.nextPanelId)) ticketState.nextPanelId = 1;

function saveState() { writeJson(DATA_FILE, state); }
function saveTickets() { writeJson(TICKET_FILE, ticketState); }

function owners() {
  return new Set(String(process.env.OWNER_IDS ?? '').split(',').map(x => x.trim()).filter(Boolean));
}
function isOwner(id) { return owners().has(id); }
function isStaff(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}
function hasGlobalRole(interaction) {
  if (!interaction.guild || !interaction.member) return false;
  if (isOwner(interaction.user.id) || isStaff(interaction)) return true;
  const allowed = state.globalRoles[interaction.guild.id] ?? [];
  const memberRoles = interaction.member.roles?.cache;
  return Boolean(memberRoles && allowed.some(id => memberRoles.has(id)));
}
function hasPermission(interaction, perm) {
  return Boolean(interaction.memberPermissions?.has(perm));
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

function ticketPanelEmbed(panel, mode = 'panel') {
  const embed = new EmbedBuilder()
    .setColor(panel.color ?? COLORS.primary)
    .setTitle(panel.title || panel.name)
    .setDescription(panel.description || 'Choose the support option you need below.')
    .setTimestamp()
    .setFooter({ text: mode === 'hub' ? 'Support Center • Tickets' : 'Support Tickets • Private & Secure' });
  if (mode === 'hub') {
    embed.addFields(
      { name: 'How it works', value: 'Select a department below to open a private ticket with the appropriate support team.', inline: false },
      { name: 'What to include', value: 'Please provide the relevant details, screenshots, order information, or other evidence in your first message.', inline: false }
    );
  } else {
    embed.addFields(
      { name: 'Private Support', value: 'Only you and the configured support team can access this ticket.', inline: true },
      { name: 'Status', value: 'Awaiting a support representative', inline: true }
    );
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
    'Titan Moderation Ticket Transcript',
    `Ticket: ${channel.name}`,
    `Guild: ${ticket.guildId}`,
    `Opened By: ${ticket.openerId}`,
    `Claimed By: ${ticket.claimedBy ?? 'Unclaimed'}`,
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

function serverLogEvents() {
  return [
    'memberJoin', 'memberLeave', 'memberUpdate', 'messageDelete', 'messageEdit', 'messageBulkDelete',
    'banAdd', 'banRemove', 'channelCreate', 'channelDelete', 'channelUpdate', 'roleCreate', 'roleDelete',
    'roleUpdate', 'guildUpdate', 'threadCreate', 'threadDelete', 'inviteCreate', 'inviteDelete',
  ];
}

async function refreshApprovalMessage(client, request) {
  const guild = client.guilds.cache.get(request.guildId);
  const channel = guild ? await guild.channels.fetch(request.channelId).catch(() => null) : null;
  const message = channel?.isTextBased() ? await channel.messages.fetch(request.messageId).catch(() => null) : null;
  if (!message) return;

  const targetMember = guild ? await guild.members.fetch(request.userId).catch(() => null) : null;
  const targetUser = targetMember?.user ?? await client.users.fetch(request.userId).catch(() => null);
  const requester = await client.users.fetch(request.requestedBy).catch(() => null);
  const resolver = request.resolvedBy ? await client.users.fetch(request.resolvedBy).catch(() => null) : null;
  const actionLabel = request.action === 'ban'
    ? 'GLOBAL BAN'
    : request.action === 'kick'
      ? 'GLOBAL KICK'
      : request.action === 'timeout'
        ? 'GLOBAL TIMEOUT'
        : request.action === 'unban'
          ? 'GLOBAL UNBAN'
          : 'GLOBAL UNTIMEOUT';

  let statusTitle = 'WAITING FOR STAFF APPROVAL';
  let statusText = 'This request is awaiting review by an authorised staff member.';
  let color = COLORS.warning;
  let statusIcon = 'PENDING';
  if (request.stage === 'ownership' && request.status === 'pending') {
    statusTitle = 'WAITING FOR OWNERSHIP APPROVAL';
    statusText = 'This request has been escalated to ownership for final review.';
    color = COLORS.primary;
    statusIcon = 'OWNERSHIP REVIEW';
  } else if (request.status === 'denied') {
    statusTitle = 'REQUEST DENIED';
    statusText = 'This moderation request was denied and will not be executed.';
    color = COLORS.danger;
    statusIcon = 'DENIED';
  } else if (request.status === 'approved') {
    statusTitle = 'REQUEST APPROVED';
    const result = request.result ? ` ${request.result.succeeded} server(s) processed, ${request.result.failed} failed.` : '';
    statusText = `This moderation request was approved and the action was executed.${result}`;
    color = COLORS.success;
    statusIcon = 'APPROVED';
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${actionLabel} • MODERATION REQUEST`)
    .setDescription(`> **${statusTitle}**\n${statusText}`)
    .addFields(
      { name: 'Target', value: `${targetUser ? `${targetUser} — ${targetUser.tag}` : `<@${request.userId}>`}\nID: \`${request.userId}\``, inline: true },
      { name: 'Requested By', value: requester ? `${requester}\n${requester.tag}` : `<@${request.requestedBy}>`, inline: true },
      { name: 'Action', value: actionLabel, inline: true },
      { name: 'Reason', value: truncate(request.reason, 1024), inline: false },
      { name: 'Approval Stage', value: request.stage === 'ownership' ? 'Ownership' : 'Staff', inline: true },
      { name: 'Resolution', value: resolver ? `${resolver}\n${request.resolvedAt ? `<t:${Math.floor(request.resolvedAt / 1000)}:F>` : '—'}` : 'Pending', inline: true },
      { name: 'Request ID', value: `\`${request.id}\``, inline: false },
    )
    .setFooter({ text: `Titan Moderation • ${statusIcon}` })
    .setTimestamp(request.resolvedAt ? new Date(request.resolvedAt) : new Date());

  if (request.action === 'timeout' && request.durationMs) {
    embed.addFields({ name: 'Duration', value: formatDuration(request.durationMs), inline: true });
  }
  if (request.result) {
    embed.addFields({ name: 'Execution Result', value: `Successful: **${request.result.succeeded}**\nFailed: **${request.result.failed}**`, inline: true });
  }

  if (request.status !== 'pending') {
    await message.edit({ embeds: [embed], components: [] }).catch(() => null);
    return;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`approval_approve:${request.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`approval_deny:${request.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`approval_ownership:${request.id}`).setLabel('Advance to Ownership').setStyle(ButtonStyle.Secondary),
  );
  await message.edit({ embeds: [embed], components: [row] }).catch(() => null);
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
  await interaction.deferUpdate();
  let succeeded = 0;
  let failed = 0;
  const expiresAt = request.action === 'timeout' ? Date.now() + request.durationMs : null;
  for (const guild of interaction.client.guilds.cache.values()) {
    try {
      if (request.action === 'ban') {
        await guild.members.ban(request.userId, { reason: `[Global Ban] ${request.reason}` });
        succeeded++;
      } else if (request.action === 'kick') {
        const member = await guild.members.fetch(request.userId).catch(() => null);
        if (!member) { failed++; continue; }
        await member.kick(`[Global Kick] ${request.reason}`); succeeded++;
      } else if (request.action === 'timeout') {
        const member = await guild.members.fetch(request.userId).catch(() => null);
        if (!member) { failed++; continue; }
        await member.timeout(request.durationMs, `[Global Timeout] ${request.reason}`); succeeded++;
      } else if (request.action === 'unban') {
        await guild.members.unban(request.userId, '[Global Unban]').then(() => { succeeded++; }).catch(() => { failed++; });
      } else if (request.action === 'untimeout') {
        const member = await guild.members.fetch(request.userId).catch(() => null);
        if (!member) { failed++; continue; }
        await member.timeout(null, '[Global Untimeout]'); succeeded++;
      }
    } catch {
      failed++;
    }
  }
  request.status = 'approved';
  request.resolvedBy = interaction.user.id;
  request.resolvedAt = Date.now();
  request.result = { succeeded, failed };
  if (request.action === 'ban') state.globalBans[request.userId] = { reason: request.reason, approvedBy: interaction.user.id, at: Date.now() };
  if (request.action === 'unban') delete state.globalBans[request.userId];
  if (request.action === 'timeout') state.globalTimeouts[request.userId] = { expiresAt, reason: request.reason };
  if (request.action === 'untimeout') delete state.globalTimeouts[request.userId];
  saveState();
  await refreshApprovalMessage(interaction.client, request);
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

async function openTicket(interaction, panelId) {
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
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers).setDMPermission(false)
    .addSubcommand(sc => sc.setName('user').setDescription('Ban a user in this server.').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(sc => sc.setName('logs').setDescription('Set the global approval log channel.').addChannelOption(o => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand(sc => sc.setName('status').setDescription('Show the approval log channel.')));
  add(new SlashCommandBuilder().setName('kick').setDescription('Kick a member.').setDefaultMemberPermissions(PermissionFlagsBits.KickMembers).setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)));
  add(new SlashCommandBuilder().setName('unban').setDescription('Unban a user from this server.').setDefaultMemberPermissions(PermissionFlagsBits.BanMembers).setDMPermission(false).addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)));
  add(new SlashCommandBuilder().setName('timeout').setDescription('Timeout a member.').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o => o.setName('duration').setDescription('e.g. 10m, 2h, 3d').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)));
  add(new SlashCommandBuilder().setName('untimeout').setDescription('Remove a member timeout.').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)));
  add(new SlashCommandBuilder().setName('warn').setDescription('Warn a member.').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)));
  add(new SlashCommandBuilder().setName('warnings').setDescription('View a member warning history.').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)));
  add(new SlashCommandBuilder().setName('clearwarn').setDescription('Clear all warnings for a member.').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setDMPermission(false).addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)));
  add(new SlashCommandBuilder().setName('purge').setDescription('Delete recent messages.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages).setDMPermission(false).addIntegerOption(o => o.setName('amount').setDescription('1-100').setMinValue(1).setMaxValue(100).setRequired(true)));

  add(new SlashCommandBuilder().setName('global').setDescription('Submit cross-server moderation actions and configure global permissions.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand(sc => sc.setName('ban').setDescription('Global ban request.').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(sc => sc.setName('kick').setDescription('Global kick request.').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(sc => sc.setName('timeout').setDescription('Global timeout request.').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)).addStringOption(o => o.setName('duration').setDescription('e.g. 10m, 2h').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(sc => sc.setName('setup').setDescription('Add a role allowed to submit global moderation requests.').addRoleOption(o => o.setName('role').setDescription('Role allowed to use global moderation').setRequired(true)))
    .addSubcommand(sc => sc.setName('remove-role').setDescription('Remove a role from global moderation permissions.').addRoleOption(o => o.setName('role').setDescription('Role to remove').setRequired(true)))
    .addSubcommand(sc => sc.setName('roles').setDescription('List roles allowed to submit global moderation requests.')));
  add(new SlashCommandBuilder().setName('unglobal').setDescription('Submit a cross-server undo action for approval.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand(sc => sc.setName('ban').setDescription('Global unban request.').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand(sc => sc.setName('timeout').setDescription('Global untimeout request.').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true))));

  add(new SlashCommandBuilder().setName('ticket-panel').setDescription('Create and manage ticket panels.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
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
      .addStringOption(o => o.setName('welcome-message').setDescription('Welcome message shown inside tickets')))
    .addSubcommand(sc => sc.setName('list').setDescription('List ticket panels.'))
    .addSubcommand(sc => sc.setName('hub').setDescription('Post a ticket hub.').addChannelOption(o => o.setName('channel').setDescription('Hub channel').addChannelTypes(ChannelType.GuildText).setRequired(true)).addStringOption(o => o.setName('panel-ids').setDescription('Panel IDs, comma-separated').setRequired(true)).addStringOption(o => o.setName('title').setDescription('Hub title')).addStringOption(o => o.setName('description').setDescription('Hub description')))
    .addSubcommand(sc => sc.setName('delete').setDescription('Delete a ticket panel.').addIntegerOption(o => o.setName('id').setDescription('Panel ID').setMinValue(1).setRequired(true))));
  add(new SlashCommandBuilder().setName('ticket').setDescription('Manage the current ticket.').setDMPermission(false)
    .addSubcommand(sc => sc.setName('claim').setDescription('Claim the current ticket.'))
    .addSubcommand(sc => sc.setName('close').setDescription('Close the current ticket.'))
    .addSubcommand(sc => sc.setName('reopen').setDescription('Reopen the current ticket.'))
    .addSubcommand(sc => sc.setName('rename').setDescription('Rename the current ticket.').addStringOption(o => o.setName('name').setDescription('New name').setRequired(true)))
    .addSubcommand(sc => sc.setName('delete').setDescription('Delete the current ticket.')));

  add(new SlashCommandBuilder().setName('welcome').setDescription('Configure welcome messages.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand(sc => sc.setName('setup').setDescription('Set the welcome channel and message.').addChannelOption(o => o.setName('channel').setDescription('Welcome channel').addChannelTypes(ChannelType.GuildText).setRequired(true)).addStringOption(o => o.setName('message').setDescription('Supports {user}, {username}, {server}, {memberCount}').setRequired(true)))
    .addSubcommand(sc => sc.setName('disable').setDescription('Disable welcome messages.'))
    .addSubcommand(sc => sc.setName('test').setDescription('Send a sample welcome message.'))
    .addSubcommand(sc => sc.setName('status').setDescription('Show welcome configuration.')));
  add(new SlashCommandBuilder().setName('auto-role').setDescription('Configure automatic join roles.').setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles).setDMPermission(false)
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

  add(new SlashCommandBuilder().setName('giveaway').setDescription('Manage giveaways.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand(sc => sc.setName('start').setDescription('Start a giveaway.').addStringOption(o => o.setName('prize').setDescription('Prize').setRequired(true)).addStringOption(o => o.setName('duration').setDescription('e.g. 10m, 2h, 3d').setRequired(true)).addIntegerOption(o => o.setName('winners').setDescription('Winner count').setMinValue(1).setMaxValue(20)).addRoleOption(o => o.setName('role').setDescription('Optional role awarded to each winner')))
    .addSubcommand(sc => sc.setName('end').setDescription('End a giveaway early.').addStringOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true)))
    .addSubcommand(sc => sc.setName('reroll').setDescription('Reroll a giveaway.').addStringOption(o => o.setName('id').setDescription('Giveaway ID').setRequired(true))));

  add(new SlashCommandBuilder().setName('serverlog').setDescription('Configure server audit logging.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false)
    .addSubcommand(sc => sc.setName('setup').setDescription('Set the log channel and tracked events.').addChannelOption(o => o.setName('channel').setDescription('Log channel').addChannelTypes(ChannelType.GuildText).setRequired(true)).addStringOption(o => o.setName('events').setDescription('Comma-separated events; blank = all')))
    .addSubcommand(sc => sc.setName('status').setDescription('Show server log settings.'))
    .addSubcommand(sc => sc.setName('disable').setDescription('Disable server logging.')));

  return commands;
}

const commandList = commandData();
function featuresEmbed() {
  return baseEmbed('Bot Command Directory', [
    '**Moderation:** `/ban` `/unban` `/kick` `/timeout` `/untimeout` `/warn` `/warnings` `/clearwarn` `/purge`',
    '**Global:** `/global ban|kick|timeout` `/global setup` `/global remove-role` `/global roles` `/unglobal ban|timeout`',
    '**Tickets:** `/ticket-panel create|list|hub|delete` `/ticket claim|close|reopen|rename|delete`',
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
  const body = commandList.map(c => c.toJSON());
  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId),
    { body }
  );
  console.log(`Registered ${body.length} slash commands in guild ${guildId}.`);
}

async function registerCommands(client) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  const guildIds = [...client.guilds.cache.keys()];

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
        return interaction.reply({ embeds: [baseEmbed('Ban Approval Logs', `Global approval requests will be posted in ${channel}.`, COLORS.success)] });
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
      await logServerEvent(interaction.guild, 'banAdd', `${target} was banned by ${interaction.user}.`, `**Reason:** ${reason}`);
      return interaction.editReply({ embeds: [baseEmbed('User Banned', `${target} was banned from this server.\n**Reason:** ${reason}`, COLORS.success)] });
    }
    case 'unban': {
      if (!hasPermission(interaction, PermissionFlagsBits.BanMembers)) return interaction.reply({ content: 'Ban Members permission required.', ephemeral: true });
      const target = interaction.options.getUser('user', true); const reason = interaction.options.getString('reason', true);
      await interaction.guild.members.unban(target.id, reason);
      await logServerEvent(interaction.guild, 'banRemove', `${target} was unbanned by ${interaction.user}.`, `**Reason:** ${reason}`);
      return interaction.reply({ embeds: [baseEmbed('User Unbanned', `${target} was unbanned.\n**Reason:** ${reason}`, COLORS.success)] });
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
    case 'global':
    case 'unglobal': {
      const globalCommand = interaction.commandName === 'global';
      const sub = interaction.options.getSubcommand();
      if (globalCommand && sub === 'setup') {
        if (!isStaff(interaction) && !isOwner(interaction.user.id)) return interaction.reply({ content: 'Manage Server permission required.', ephemeral: true });
        const role = interaction.options.getRole('role', true);
        if (role.managed || role.id === interaction.guild.id) return interaction.reply({ content: 'That role cannot be used for global moderation permissions.', ephemeral: true });
        state.globalRoles[interaction.guild.id] ??= [];
        if (!state.globalRoles[interaction.guild.id].includes(role.id)) state.globalRoles[interaction.guild.id].push(role.id);
        saveState();
        return interaction.reply({ embeds: [baseEmbed('Global Moderation Role Added', `${role} can now submit global ban, kick, and timeout requests.`, COLORS.success)] });
      }
      if (globalCommand && sub === 'remove-role') {
        if (!isStaff(interaction) && !isOwner(interaction.user.id)) return interaction.reply({ content: 'Manage Server permission required.', ephemeral: true });
        const role = interaction.options.getRole('role', true);
        state.globalRoles[interaction.guild.id] = (state.globalRoles[interaction.guild.id] ?? []).filter(id => id !== role.id);
        saveState();
        return interaction.reply({ embeds: [baseEmbed('Global Moderation Role Removed', `${role} can no longer submit global moderation requests.`, COLORS.success)] });
      }
      if (globalCommand && sub === 'roles') {
        if (!isStaff(interaction) && !isOwner(interaction.user.id)) return interaction.reply({ content: 'Manage Server permission required.', ephemeral: true });
        const roles = (state.globalRoles[interaction.guild.id] ?? []).map(id => `<@&${id}>`);
        return interaction.reply({ embeds: [baseEmbed('Global Moderation Roles', roles.length ? roles.join(', ') : 'No additional global moderation roles configured. Server managers and owners can still use global moderation.', COLORS.primary)] });
      }
      if (!hasGlobalRole(interaction)) return interaction.reply({ content: 'You do not have a role configured for global moderation. Ask an administrator to run `/global setup` for your role.', ephemeral: true });
      const action = globalCommand ? sub : (sub === 'ban' ? 'unban' : 'untimeout');
      const logId = state.banLogs[interaction.guild.id];
      const logChannel = logId ? await interaction.guild.channels.fetch(logId).catch(() => null) : null;
      if (!logChannel?.isTextBased()) return interaction.reply({ content: 'No ban approval log channel is configured. Run `/ban logs` first.', ephemeral: true });
      const user = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason', true);
      const durationMs = action === 'timeout' ? parseDuration(interaction.options.getString('duration', true)) : null;
      if (action === 'timeout' && !durationMs) return interaction.reply({ content: 'Invalid duration.', ephemeral: true });
      const request = newApproval(interaction, action, user.id, reason, durationMs);
      const actionLabel = action === 'ban' ? 'Global Ban Request' : action === 'kick' ? 'Global Kick Request' : action === 'timeout' ? 'Global Timeout Request' : action === 'unban' ? 'Global Unban Request' : 'Global Untimeout Request';
      const embed = baseEmbed(actionLabel, [`**Target:** ${user}`, `**Reason:** ${reason}`, action === 'timeout' ? `**Duration:** ${interaction.options.getString('duration', true)}` : '', `**Requested by:** ${interaction.user}`, '**Status:** Waiting for staff approval', '', 'Staff can approve, deny, or advance this request to ownership.'].filter(Boolean).join('\n'), COLORS.warning);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approval_approve:${request.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`approval_deny:${request.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`approval_ownership:${request.id}`).setLabel('Advance to Ownership').setStyle(ButtonStyle.Secondary),
      );
      const msg = await logChannel.send({ embeds: [embed], components: [row] });
      request.messageId = msg.id;
      state.approvals[request.id] = request; saveState();
      if (action === 'ban') await createProofThread(msg, interaction.user.id, interaction.client).catch(() => null);
      return interaction.reply({ embeds: [baseEmbed('Request Submitted', `${actionLabel} for ${user} was sent to ${logChannel}.`, COLORS.success)], ephemeral: true });
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
      if (sub === 'hub') {
        const channel = interaction.options.getChannel('channel', true);
        const ids = [...new Set(String(interaction.options.getString('panel-ids', true)).split(',').map(s => Number(s.trim())).filter(Number.isInteger))].slice(0, 5);
        const panels = ids.map(id => getPanel(id, interaction.guild.id)).filter(Boolean);
        if (!panels.length) return interaction.reply({ content: 'No valid panel IDs found.', ephemeral: true });
        const title = interaction.options.getString('title') ?? 'Support Center';
        const description = interaction.options.getString('description') ?? 'Choose the department you need below. Your ticket will be private and routed to the appropriate support team.';
        const embed = new EmbedBuilder()
          .setColor(COLORS.primary)
          .setTitle(title)
          .setDescription(description)
          .addFields(
            { name: 'Open a Ticket', value: 'Select a department from the menu below. A private channel will be created for you and the assigned support team.', inline: false },
            ...panels.slice(0, 5).map(panel => ({ name: panel.name, value: panel.description, inline: true }))
          )
          .setTimestamp()
          .setFooter({ text: 'Support Center • Private Tickets' });
        const menu = new (require('discord.js').StringSelectMenuBuilder)()
          .setCustomId(`ticket_select_hub:${panels.map(p => p.id).join(',')}`)
          .setPlaceholder('Select a support department')
          .addOptions(panels.map(panel => ({ label: panel.name.slice(0, 100), description: (panel.description || 'Open a support ticket').slice(0, 100), value: String(panel.id) })));
        await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
        return interaction.reply({ embeds: [baseEmbed('Ticket Hub Posted', `Hub posted in ${channel}.`, COLORS.success)] });
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
        welcomeMessage: interaction.options.getString('welcome-message') ?? 'Welcome to your ticket. A member of the support team will be with you shortly. Please provide all relevant details so we can assist you quickly.',
        color: COLORS.primary,
        ticketCounter: 0, messageId: null,
      };
      const channel = await interaction.guild.channels.fetch(panel.channelId);
      const msg = await channel.send({
        embeds: [ticketPanelEmbed(panel)],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`panel_open:${panel.id}`).setLabel(panel.buttonLabel.slice(0, 80)).setStyle(ButtonStyle.Primary))]
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
        await interaction.channel.permissionOverwrites.edit(ticket.openerId, { SendMessages: true }).catch(() => null); saveTickets();
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
      if (!hasPermission(interaction, PermissionFlagsBits.ManageRoles)) return interaction.reply({ content: 'Manage Roles permission required.', ephemeral: true });
      const sub = interaction.options.getSubcommand();
      if (sub === 'set') { const role = interaction.options.getRole('role', true); state.autoRole[interaction.guild.id] = { roleId: role.id }; saveState(); return interaction.reply({ embeds: [baseEmbed('Auto Role Enabled', `New members will receive ${role}.`, COLORS.success)] }); }
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
      if (!hasPermission(interaction, PermissionFlagsBits.ManageRoles)) return interaction.reply({ content: 'Manage Roles permission required.', ephemeral: true });
      const user = interaction.options.getUser('user', true); const role = interaction.options.getRole('role', true);
      if (role.managed || role.position >= interaction.guild.members.me.roles.highest.position) return interaction.reply({ content: 'I cannot manage that role. Move my highest role above it.', ephemeral: true });
      const member = await interaction.guild.members.fetch(user.id).catch(() => null); if (!member) return interaction.reply({ content: 'Member not found.', ephemeral: true });
      if (sub === 'add') { await member.roles.add(role, `Role added by ${interaction.user.tag}`); return interaction.reply({ embeds: [baseEmbed('Role Added', `${role} was added to ${member}.`, COLORS.success)] }); }
      await member.roles.remove(role, `Role removed by ${interaction.user.tag}`); return interaction.reply({ embeds: [baseEmbed('Role Removed', `${role} was removed from ${member}.`, COLORS.success)] });
    }
    case 'temp': {
      if (!hasPermission(interaction, PermissionFlagsBits.ManageRoles)) return interaction.reply({ content: 'Manage Roles permission required.', ephemeral: true });
      const role = interaction.options.getRole('role', true); const user = interaction.options.getUser('user', true); const durationMs = parseDuration(interaction.options.getString('duration', true));
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
      const winners = chooseWinners(giveaway.entrants, giveaway.winnerCount); if (giveaway.rewardRoleId) { for (const uid of winners) { const member = await interaction.guild.members.fetch(uid).catch(() => null); if (member) await member.roles.add(giveaway.rewardRoleId, 'Giveaway winner role').catch(() => null); } } const channel = await interaction.guild.channels.fetch(giveaway.channelId).catch(() => null); if (channel?.isTextBased()) await channel.send({ embeds: [baseEmbed('Giveaway Rerolled', winners.length ? winners.map(x => `<@${x}>`).join(', ') : 'No eligible entrants.', COLORS.success)] });
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
  if (giveaway.rewardRoleId && giveaway.winners?.length) { for (const uid of giveaway.winners) { const member = await guild.members.fetch(uid).catch(() => null); if (member) await member.roles.add(giveaway.rewardRoleId, 'Giveaway winner role').catch(() => null); } }
  const msg = await channel.messages.fetch(giveaway.messageId).catch(() => null);
  if (msg) await msg.edit({ embeds: [baseEmbed('Giveaway Ended', `**Prize:** ${giveaway.prize}\n**Winner(s):** ${text}`, COLORS.success)], components: [] }).catch(() => null);
  if (!silent) await channel.send({ embeds: [baseEmbed('Giveaway Concluded', `**Prize:** ${giveaway.prize}\n**Winner(s):** ${text}`, COLORS.success)] }).catch(() => null);
}
function scheduleGiveaway(client, giveaway) {
  const delay = giveaway.endsAt - Date.now(); if (delay <= 0) return endGiveaway(client, giveaway, true);
  setTimeout(() => endGiveaway(client, giveaway, true), Math.min(delay, 2_147_000_000));
}
async function createProofThread(message, requesterId, client) {
  if (!message?.startThread) return;
  const thread = await message.startThread({ name: 'Proof Required', autoArchiveDuration: 1440 }).catch(() => null);
  if (!thread) return;
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`proof_remind:${requesterId}`).setLabel('Remind for Proof').setStyle(ButtonStyle.Secondary));
  await thread.send({ content: `<@${requesterId}> please make sure to provide proof for this global ban request in this thread before approval.`, components: [row], allowedMentions: { users: [requesterId] } }).catch(() => null);
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
    const request = state.approvals[id]; if (!request || request.status !== 'pending') return interaction.reply({ content:'This approval request is no longer active.', ephemeral:true });
    if (type === 'approval_ownership') { if (!isStaff(interaction)) return interaction.reply({content:'Only staff can advance this request.',ephemeral:true}); request.stage='ownership'; saveState(); await interaction.deferUpdate(); return refreshApprovalMessage(interaction.client,request); }
    if (request.stage === 'ownership' && !isOwner(interaction.user.id)) return interaction.reply({content:'This request is at ownership stage. Only an owner can decide it.',ephemeral:true});
    if (request.stage === 'staff' && !isStaff(interaction)) return interaction.reply({content:'Only staff can decide this request.',ephemeral:true});
    if (type === 'approval_deny') { request.status='denied'; request.resolvedBy=interaction.user.id; request.resolvedAt=Date.now(); saveState(); await interaction.deferUpdate(); return refreshApprovalMessage(interaction.client,request); }
    return executeGlobalAction(interaction, request);
  }
  if (type.startsWith('rolereq_')) {
    const request = state.roleRequests[id]; if (!request || request.status !== 'pending') return interaction.reply({content:'This role request is no longer active.',ephemeral:true});
    if (!isStaff(interaction)) return interaction.reply({content:'Only staff can decide role requests.',ephemeral:true});
    if (type === 'rolereq_deny') { request.status='denied'; request.approvedBy=interaction.user.id; saveState(); await interaction.update({embeds:[baseEmbed('Role Request Denied',`Request from <@${request.userId}> for <@&${request.roleId}> was denied by ${interaction.user}.`,COLORS.danger)],components:[]}); return; }
    const member = await interaction.guild.members.fetch(request.userId).catch(()=>null); const role = interaction.guild.roles.cache.get(request.roleId); if (!member || !role) return interaction.reply({content:'Member or role is unavailable.',ephemeral:true});
    if (role.position >= interaction.guild.members.me.roles.highest.position) return interaction.reply({content:'I cannot assign that role due to role hierarchy.',ephemeral:true});
    await member.roles.add(role,`Role request approved by ${interaction.user.tag}`); request.status='approved'; request.approvedBy=interaction.user.id; saveState();
    await interaction.update({embeds:[baseEmbed('Role Request Approved',`${member} was given ${role}.\n**Approved by:** ${interaction.user}`,COLORS.success)],components:[]}); return;
  }
  if (type === 'proof_remind') {
    if (!isStaff(interaction)) return interaction.reply({content:'Only staff can send proof reminders.',ephemeral:true});
    const thread = interaction.channel; await thread.send({content:`<@${id}> reminder: please provide proof for the global ban request.`,allowedMentions:{users:[id]}}); return interaction.reply({content:'Proof reminder sent.',ephemeral:true});
  }
}

client.on(Events.GuildMemberAdd, async member => {
  const ban = state.globalBans[member.id];
  if (ban) { await member.ban({ reason: `[Global Ban] ${ban.reason}` }).catch(()=>null); return; }
  const gt = state.globalTimeouts[member.id]; if (gt && gt.expiresAt > Date.now()) await member.timeout(gt.expiresAt-Date.now(), `[Global Timeout] ${gt.reason}`).catch(()=>null);
  const auto = state.autoRole[member.guild.id]?.roleId; if (auto) await member.roles.add(auto).catch(()=>null);
  const welcome = state.welcome[member.guild.id]; if (welcome) { const channel=await member.guild.channels.fetch(welcome.channelId).catch(()=>null); if(channel?.isTextBased()) await channel.send({embeds:[baseEmbed('Welcome',replaceWelcome(welcome.message,member),COLORS.success)]}).catch(()=>null); }
  await logServerEvent(member.guild,'memberJoin',`${member} joined the server.`);
});
client.on(Events.GuildMemberRemove, member => void logServerEvent(member.guild,'memberLeave',`${member.user.tag} left the server.`));
client.on(Events.GuildBanAdd, ban => void logServerEvent(ban.guild,'banAdd',`<@${ban.user.id}> was banned.`, ban.reason ? `**Reason:** ${ban.reason}` : ''));
client.on(Events.GuildBanRemove, ban => void logServerEvent(ban.guild,'banRemove',`<@${ban.user.id}> was unbanned.`));
client.on(Events.MessageDelete, msg => { if (msg.guild) void logServerEvent(msg.guild,'messageDelete',`A message was deleted in <#${msg.channelId}>.`, msg.author ? `**Author:** ${msg.author.tag}\n**Content:** ${truncate(msg.content,700)}` : ''); });
client.on(Events.MessageUpdate, (oldMsg,newMsg) => { if(newMsg.guild && oldMsg.content !== newMsg.content) void logServerEvent(newMsg.guild,'messageEdit',`A message was edited in <#${newMsg.channelId}>.`,`**Author:** ${newMsg.author?.tag ?? 'Unknown'}\n**Before:** ${truncate(oldMsg.content,350)}\n**After:** ${truncate(newMsg.content,350)}`); });
client.on(Events.ChannelCreate, channel => { if(channel.guild) void logServerEvent(channel.guild,'channelCreate',`Channel created: <#${channel.id}>.`); });
client.on(Events.ChannelDelete, channel => { if(channel.guild) void logServerEvent(channel.guild,'channelDelete',`Channel deleted: **${channel.name}**.`); });
client.on(Events.RoleCreate, role => void logServerEvent(role.guild,'roleCreate',`Role created: ${role}.`));
client.on(Events.RoleDelete, role => void logServerEvent(role.guild,'roleDelete',`Role deleted: **${role.name}**.`));
client.on(Events.ThreadCreate, thread => void logServerEvent(thread.guild,'threadCreate',`Thread created: **${thread.name}**.`));
client.on(Events.ThreadDelete, thread => void logServerEvent(thread.guild,'threadDelete',`Thread deleted: **${thread.name}**.`));

client.on(Events.ChannelUpdate, (oldChannel, newChannel) => { if (newChannel.guild) void logServerEvent(newChannel.guild, 'channelUpdate', `Channel updated: <#${newChannel.id}>.`, `**Before:** ${oldChannel.name}\n**After:** ${newChannel.name}`); });
client.on(Events.RoleUpdate, (oldRole, newRole) => void logServerEvent(newRole.guild, 'roleUpdate', `Role updated: ${newRole}.`, `**Before:** ${oldRole.name}\n**After:** ${newRole.name}`));
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
  console.log(`Loaded ${Object.keys(state.approvals).length} approvals, ${Object.keys(state.giveaways).length} giveaways, ${ticketState.panels.length} ticket panels.`);
});

async function main() {
  if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_CLIENT_ID) throw new Error('DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required.');
  state.tempRoles ??= [];
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
