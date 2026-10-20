'use strict';

// Builds a clean, self-contained HTML ticket transcript from plain message objects.
// All user supplied text is HTML-escaped before any formatting is applied.

const DEFAULT_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(value) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

function hexColor(value) {
  if (typeof value === 'number' && value > 0) return `#${value.toString(16).padStart(6, '0')}`;
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) && value.toLowerCase() !== '#000000') return value;
  return '';
}

function makeFormatters(timeZone) {
  const safeZone = (() => {
    try { new Intl.DateTimeFormat('en-GB', { timeZone }); return timeZone; } catch { return 'UTC'; }
  })();
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: safeZone, day: '2-digit', month: 'short', year: 'numeric' });
  const dayLong = new Intl.DateTimeFormat('en-GB', { timeZone: safeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: safeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  const full = new Intl.DateTimeFormat('en-GB', { timeZone: safeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' });
  return {
    zone: safeZone,
    date: (ms) => date.format(new Date(ms)),
    dayLong: (ms) => dayLong.format(new Date(ms)),
    time: (ms) => time.format(new Date(ms)),
    full: (ms) => full.format(new Date(ms)),
    dayKey: (ms) => date.format(new Date(ms)),
  };
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Discord-flavoured markdown -> HTML. Input is raw text; output is safe HTML.
function renderMarkdown(raw, ctx = {}) {
  let text = esc(raw);
  const stash = [];
  const hold = (html) => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };

  // Code blocks and inline code first so their contents are never formatted.
  text = text.replace(/```(?:[a-z0-9+-]*\n)?([\s\S]*?)```/gi, (_, code) => hold(`<pre><code>${code.replace(/^\n+|\n+$/g, '')}</code></pre>`));
  text = text.replace(/``([^`]+?)``|`([^`\n]+?)`/g, (_, a, b) => hold(`<code class="inline">${a ?? b}</code>`));

  // Mentions, channels, emoji, timestamps.
  const users = ctx.users || {};
  const roles = ctx.roles || {};
  const channels = ctx.channels || {};
  text = text.replace(/&lt;@!?(\d{15,25})&gt;/g, (_, id) => hold(`<span class="mention">@${esc(users[id] || 'Unknown User')}</span>`));
  text = text.replace(/&lt;@&amp;(\d{15,25})&gt;/g, (_, id) => {
    const role = roles[id];
    const color = hexColor(role?.color);
    const style = color ? ` style="color:${color};background:${color}22"` : '';
    return hold(`<span class="mention"${style}>@${esc(role?.name || 'Unknown Role')}</span>`);
  });
  text = text.replace(/&lt;#(\d{15,25})&gt;/g, (_, id) => hold(`<span class="mention">#${esc(channels[id] || 'unknown-channel')}</span>`));
  text = text.replace(/@(everyone|here)\b/g, (_, name) => hold(`<span class="mention">@${name}</span>`));
  text = text.replace(/&lt;(a?):([a-zA-Z0-9_]{2,32}):(\d{15,25})&gt;/g, (_, animated, name, id) =>
    hold(`<img class="emoji" alt=":${name}:" title=":${name}:" src="https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=48">`));
  text = text.replace(/&lt;t:(-?\d{1,12})(?::([tTdDfFR]))?&gt;/g, (_, seconds, style) => {
    const ms = Number(seconds) * 1000;
    const fmt = ctx.fmt;
    const label = fmt ? (style === 't' || style === 'T' ? fmt.time(ms) : style === 'd' || style === 'D' ? fmt.date(ms) : fmt.full(ms)) : new Date(ms).toISOString();
    return hold(`<span class="timestamp">${esc(label)}</span>`);
  });

  // Links (masked first, then bare).
  text = text.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) =>
    hold(`<a href="${esc(safeUrl(url.replace(/&amp;/g, '&')))}" target="_blank" rel="noopener noreferrer">${label}</a>`));
  text = text.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, (_, lead, url) =>
    `${lead}${hold(`<a href="${esc(safeUrl(url.replace(/&amp;/g, '&')))}" target="_blank" rel="noopener noreferrer">${url}</a>`)}`);

  // Inline formatting.
  text = text
    .replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler">$1</span>')
    .replace(/\*\*\*([\s\S]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([\s\S]+?)__/g, '<u>$1</u>')
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+?)_(?![_\w])/g, '$1<em>$2</em>')
    .replace(/~~([\s\S]+?)~~/g, '<s>$1</s>');

  // Block level helpers (line based).
  const lines = text.split('\n').map((line) => {
    let m;
    if ((m = line.match(/^-#\s+(.*)$/))) return `<div class="subtext">${m[1]}</div>`;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) return `<div class="h h${m[1].length}">${m[2]}</div>`;
    if ((m = line.match(/^&gt;\s?(.*)$/))) return `<div class="quote">${m[1]}</div>`;
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) return `<div class="li">\u2022 ${m[1]}</div>`;
    return `${line}<br>`;
  });
  text = lines.join('').replace(/(<br>)+$/g, '');

  // Restore stashed fragments (may be nested one level deep).
  for (let pass = 0; pass < 3; pass += 1) {
    text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)] ?? '');
  }
  return text;
}

function renderEmbed(embed, ctx) {
  const color = hexColor(embed.color) || '#4f545c';
  const parts = [];
  if (embed.author?.name) parts.push(`<div class="embed-author">${esc(embed.author.name)}</div>`);
  if (embed.title) {
    const url = safeUrl(embed.url);
    parts.push(`<div class="embed-title">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(embed.title)}</a>` : renderMarkdown(embed.title, ctx)}</div>`);
  }
  if (embed.description) parts.push(`<div class="embed-desc">${renderMarkdown(embed.description, ctx)}</div>`);
  if (embed.fields?.length) {
    parts.push(`<div class="embed-fields">${embed.fields.map((f) =>
      `<div class="embed-field${f.inline ? ' inline' : ''}"><div class="embed-field-name">${renderMarkdown(f.name, ctx)}</div><div class="embed-field-value">${renderMarkdown(f.value, ctx)}</div></div>`).join('')}</div>`);
  }
  const image = safeUrl(embed.image || embed.thumbnail);
  if (image) parts.push(`<a href="${esc(image)}" target="_blank" rel="noopener noreferrer"><img class="embed-image" loading="lazy" src="${esc(image)}" alt="Embed image"></a>`);
  const footer = [embed.footer, embed.timestamp ? ctx.fmt.full(embed.timestamp) : ''].filter(Boolean).join(' \u2022 ');
  if (footer) parts.push(`<div class="embed-footer">${esc(footer)}</div>`);
  if (!parts.length) return '';
  return `<div class="embed" style="border-left-color:${color}">${parts.join('')}</div>`;
}

function renderAttachment(att) {
  const url = safeUrl(att.url);
  if (!url) return '';
  const isImage = /^image\/(png|jpe?g|gif|webp)/i.test(att.contentType || '') || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(att.name || url);
  if (isImage) {
    return `<div class="attachment"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer"><img loading="lazy" src="${esc(url)}" alt="${esc(att.name || 'image')}"></a><div class="att-name">${esc(att.name || 'image')}${att.size ? ` \u2022 ${formatBytes(att.size)}` : ''}</div></div>`;
  }
  return `<div class="file"><span class="file-icon">\uD83D\uDCCE</span><div><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(att.name || 'file')}</a><div class="att-name">${att.size ? formatBytes(att.size) : 'Attachment'}</div></div></div>`;
}

function renderMessage(message, ctx, grouped) {
  const ctxFor = { ...ctx, users: { ...ctx.users, ...(message.mentions?.users || {}) }, roles: { ...ctx.roles, ...(message.mentions?.roles || {}) }, channels: { ...ctx.channels, ...(message.mentions?.channels || {}) } };
  if (message.system) {
    return `<div class="system"><span class="system-icon">\u2192</span><span>${esc(message.system)}</span><span class="time">${esc(ctx.fmt.time(message.timestamp))}</span></div>`;
  }
  const author = message.author || {};
  const color = hexColor(author.color);
  const reply = message.replyTo
    ? `<div class="reply"><span class="reply-author">${esc(message.replyTo.authorName || 'Unknown')}</span> <span class="reply-text">${esc(String(message.replyTo.content || 'Click to see attachment').replace(/\s+/g, ' ').slice(0, 120))}</span></div>`
    : '';
  const body = [];
  if (message.content) body.push(`<div class="content">${renderMarkdown(message.content, ctxFor)}${message.editedTimestamp ? '<span class="edited">(edited)</span>' : ''}</div>`);
  for (const embed of message.embeds || []) body.push(renderEmbed(embed, ctxFor));
  for (const att of message.attachments || []) body.push(renderAttachment(att));
  if (message.stickers?.length) body.push(`<div class="content muted">Sticker: ${esc(message.stickers.join(', '))}</div>`);
  if (message.components?.length) body.push(`<div class="components">${message.components.map((label) => `<span class="button">${esc(label)}</span>`).join('')}</div>`);
  if (message.reactions?.length) body.push(`<div class="reactions">${message.reactions.map((r) => `<span class="reaction">${esc(r.emoji)} ${esc(r.count)}</span>`).join('')}</div>`);
  const initial = esc((author.name || '?').trim().charAt(0).toUpperCase() || '?');
  if (grouped) {
    return `<div class="msg grouped" id="m-${esc(message.id)}"><div class="gutter"><span class="hover-time">${esc(ctx.fmt.time(message.timestamp))}</span></div><div class="main">${body.join('')}</div></div>`;
  }
  return `<div class="msg" id="m-${esc(message.id)}"><div class="gutter"><div class="avatar" data-initial="${initial}"><img src="${esc(safeUrl(author.avatarUrl) || DEFAULT_AVATAR)}" alt="" loading="lazy" onerror="this.remove()"></div></div><div class="main">${reply}<div class="head"><span class="author"${color ? ` style="color:${color}"` : ''}>${esc(author.name || 'Unknown')}</span>${author.bot ? '<span class="badge">BOT</span>' : ''}<span class="time">${esc(ctx.fmt.dayKey(message.timestamp))} ${esc(ctx.fmt.time(message.timestamp))}</span></div>${body.join('')}</div></div>`;
}

const CSS = `
:root{--bg:#313338;--panel:#2b2d31;--panel2:#232428;--text:#dbdee1;--muted:#949ba4;--link:#00a8fc;--accent:#5865f2;--line:#3f4147;--mention:#c9cdfb;--mention-bg:#5865f24d;--code:#1e1f22}
@media (prefers-color-scheme:light){:root{--bg:#ffffff;--panel:#f2f3f5;--panel2:#e3e5e8;--text:#313338;--muted:#5c5e66;--link:#0068e0;--line:#d9dbde;--mention:#3c45a5;--mention-bg:#5865f21f;--code:#f2f3f5}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 "gg sans","Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto;padding:24px 16px 64px}
.header{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:24px}
.header-top{padding:20px 24px;border-bottom:1px solid var(--line);border-top:4px solid var(--accent)}
.brand{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:700}
.header h1{margin:4px 0 2px;font-size:22px;line-height:1.25}
.header .sub{color:var(--muted);font-size:14px}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:1px;background:var(--line)}
.meta div{background:var(--panel);padding:12px 24px}
.meta .k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}
.meta .v{margin-top:2px;font-weight:600;word-break:break-word}
.people{padding:14px 24px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
.people b{color:var(--text)}
.day{display:flex;align-items:center;gap:12px;margin:22px 0 8px;color:var(--muted);font-size:12px;font-weight:700}
.day::before,.day::after{content:"";flex:1;height:1px;background:var(--line)}
.msg{display:flex;gap:14px;padding:3px 8px;border-radius:6px}
.msg:hover{background:var(--panel)}
.msg:not(.grouped){margin-top:14px}
.gutter{width:42px;flex:none;position:relative}
.avatar{width:40px;height:40px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;position:relative;overflow:hidden}
.avatar::before{content:attr(data-initial)}
.avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.hover-time{display:none;font-size:11px;color:var(--muted);text-align:right;width:100%;padding-top:3px}
.msg.grouped:hover .hover-time{display:block}
.main{min-width:0;flex:1}
.head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.author{font-weight:600}
.badge{background:var(--accent);color:#fff;font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;transform:translateY(-1px)}
.time{color:var(--muted);font-size:12px}
.reply{font-size:13px;color:var(--muted);margin-bottom:2px;border-left:2px solid var(--line);padding-left:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.reply-author{font-weight:600;color:var(--text)}
.content{word-wrap:break-word;overflow-wrap:anywhere}
.muted{color:var(--muted)}
.edited{color:var(--muted);font-size:11px;margin-left:5px}
.mention{background:var(--mention-bg);color:var(--mention);border-radius:4px;padding:0 3px;font-weight:500}
.timestamp{background:var(--panel2);border-radius:4px;padding:0 4px}
.emoji{height:1.375em;width:1.375em;vertical-align:-0.3em}
.spoiler{background:var(--panel2);color:transparent;border-radius:3px;cursor:pointer}.spoiler:hover{color:inherit}
code.inline{background:var(--code);border-radius:4px;padding:1px 5px;font:13px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
pre{background:var(--code);border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:4px 0;overflow-x:auto;max-width:100%}
pre code{font:13px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.subtext{font-size:12px;color:var(--muted)}.h{font-weight:700}.h1{font-size:1.5em}.h2{font-size:1.25em}.h3{font-size:1.1em}
.quote{border-left:4px solid var(--line);padding-left:10px;color:var(--muted)}.li{padding-left:6px}
.embed{max-width:520px;background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:4px;padding:10px 14px;margin:6px 0}
.embed-author{font-size:13px;font-weight:600;margin-bottom:4px}.embed-title{font-weight:700;margin-bottom:4px}
.embed-desc{font-size:14px}.embed-footer{font-size:12px;color:var(--muted);margin-top:8px}
.embed-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 12px;margin-top:8px}
.embed-field{grid-column:1/-1;min-width:0}.embed-field.inline{grid-column:auto}
.embed-field-name{font-size:13px;font-weight:700;margin-bottom:2px}.embed-field-value{font-size:14px;word-break:break-word}
.embed-image{max-width:100%;max-height:320px;border-radius:4px;margin-top:8px}
.attachment{margin:6px 0}.attachment img{max-width:min(100%,480px);max-height:360px;border-radius:6px;display:block}
.att-name{font-size:12px;color:var(--muted);margin-top:2px}
.file{display:inline-flex;gap:10px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px 12px;margin:6px 0}
.components{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.button{background:var(--panel2);border:1px solid var(--line);border-radius:4px;padding:3px 12px;font-size:13px;font-weight:600}
.reactions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.reaction{background:var(--panel2);border-radius:6px;padding:1px 8px;font-size:13px}
.system{display:flex;gap:10px;align-items:center;color:var(--muted);font-size:13px;padding:6px 8px}
.footer{margin-top:40px;text-align:center;color:var(--muted);font-size:12px}
.thread{margin:10px 0 10px 56px;border-left:3px solid var(--accent);padding-left:12px}
.thread-title{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
@media (max-width:600px){.header-top,.people,.meta div{padding-left:16px;padding-right:16px}.msg{gap:10px}.embed-fields{grid-template-columns:1fr}.thread{margin-left:20px}}
@media print{body{background:#fff;color:#000}.msg:hover{background:none}}
`;

function collectParticipants(messages) {
  const map = new Map();
  const visit = (list) => {
    for (const message of list) {
      if (message.system || !message.author?.id) continue;
      const entry = map.get(message.author.id) || { name: message.author.name, bot: message.author.bot, count: 0 };
      entry.count += 1;
      map.set(message.author.id, entry);
      if (message.thread?.messages) visit(message.thread.messages);
    }
  };
  visit(messages);
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function renderThread(thread, ctx) {
  return `<div class="thread"><div class="thread-title">Thread: ${esc(thread.name)}</div>${renderList(thread.messages || [], ctx, false)}</div>`;
}

function renderList(messages, ctx, withDays = true) {
  const out = [];
  let lastDay = null;
  let previous = null;
  for (const message of messages) {
    const day = ctx.fmt.dayKey(message.timestamp);
    if (withDays && day !== lastDay) {
      out.push(`<div class="day">${esc(ctx.fmt.dayLong(message.timestamp))}</div>`);
      lastDay = day;
      previous = null;
    }
    const grouped = Boolean(
      previous && !previous.system && !message.system && !message.replyTo &&
      previous.author?.id === message.author?.id &&
      message.timestamp - previous.timestamp < 7 * 60 * 1000,
    );
    out.push(renderMessage(message, ctx, grouped));
    if (message.thread?.messages?.length) out.push(renderThread(message.thread, ctx));
    previous = message;
  }
  return out.join('\n');
}

// info: { brand, title, subtitle, details: [[label, value], ...], timeZone, truncated }
function buildTranscriptHtml(info, messages) {
  const fmt = makeFormatters(info.timeZone || 'UTC');
  const ctx = { fmt, users: info.users || {}, roles: info.roles || {}, channels: info.channels || {} };
  const people = collectParticipants(messages);
  const total = people.reduce((sum, p) => sum + p.count, 0);
  const details = (info.details || []).filter(([, v]) => v !== undefined && v !== null && String(v) !== '');
  const metaHtml = details.map(([k, v]) => `<div><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');
  const peopleHtml = people.length
    ? `<div class="people"><b>Participants:</b> ${people.map((p) => `${esc(p.name)}${p.bot ? ' (bot)' : ''} \u2013 ${p.count}`).join(' \u2022 ')}</div>`
    : '';
  const truncated = info.truncated ? '<div class="system"><span class="system-icon">!</span><span>Only the most recent messages could be included in this transcript.</span></div>' : '';
  const body = messages.length ? renderList(messages, ctx) : '<div class="system"><span>No messages were found in this ticket.</span></div>';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><title>${esc(info.title || 'Ticket Transcript')}</title><style>${CSS}</style></head>
<body><div class="wrap">
<div class="header"><div class="header-top"><div class="brand">${esc(info.brand || 'Ticket Transcript')}</div><h1>${esc(info.title || 'Ticket Transcript')}</h1><div class="sub">${esc(info.subtitle || '')}</div></div>
<div class="meta">${metaHtml}<div><div class="k">Messages</div><div class="v">${total}</div></div></div>${peopleHtml}</div>
${truncated}
<div class="messages">${body}</div>
<div class="footer">Generated ${esc(fmt.full(info.generatedAt || Date.now()))} \u2022 All times shown in ${esc(fmt.zone)} \u2022 ${esc(info.brand || 'Ticket Transcript')}</div>
</div></body></html>`;
}

module.exports = { buildTranscriptHtml, renderMarkdown, esc };
