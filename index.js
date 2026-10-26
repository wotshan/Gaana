#!/usr/bin/env node
/**
 * Gaana — a production-ready Discord music bot (single-file build).
 *
 * Everything lives in this one file: the config loader, logger, formatting
 * helpers, theme/embed builders, JSON stores, Lavalink player logic, the full
 * prefix command registry, slash commands, interactive components and the boot
 * code. There are no folder-based imports — drop this file next to config.json
 * and package.json and run `npm start`.
 *
 * Sections (in order):
 *   logger.js · format.js · theme.js · config.js · store.js · music.js ·
 *   commands.js · slash.js · index.js (boot)
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ApplicationCommandOptionType, SlashCommandBuilder, ActivityType, Client, GatewayIntentBits, Partials } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { LavalinkManager } from "lavalink-client";
import { pathToFileURL } from "node:url";


/* ==========================================================================
 * logger.js
 * ========================================================================== */

/**
 * Tiny dependency-free logger with levels and a consistent timestamp format.
 * Set LOG_LEVEL=debug to see verbose output.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

function stamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function write(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const prefix = `[${stamp()}] ${level.toUpperCase().padEnd(5)} ${scope ? `(${scope}) ` : ""}`;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(prefix, ...args);
}

function createLogger(scope = "") {
  return {
    debug: (...args) => write("debug", scope, args),
    info: (...args) => write("info", scope, args),
    warn: (...args) => write("warn", scope, args),
    error: (...args) => write("error", scope, args),
  };
}

const logger = createLogger();

/* ==========================================================================
 * format.js
 * ========================================================================== */

/**
 * Formatting helpers shared by every embed and command.
 */

/** 245000 -> "4:05" */
function clock(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** 3725000 -> "1h 2m" (used in queue totals). */
function longDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Builds a monospace progress bar: "━━━━━━━◉───────────"
 * `size` is the total character width of the bar.
 */
function progressBar(position, duration, size = 18) {
  const total = Number(duration) || 0;
  if (!total || total <= 0) return "◉" + "─".repeat(Math.max(0, size - 1));
  const ratio = Math.min(1, Math.max(0, (Number(position) || 0) / total));
  const knob = Math.min(size - 1, Math.round(ratio * (size - 1)));
  let out = "";
  for (let i = 0; i < size; i += 1) {
    if (i === knob) out += "◉";
    else if (i < knob) out += "━";
    else out += "─";
  }
  return out;
}

/** One-line progress readout, already padded for a monospace block. */
function progressLine(position, duration, isStream = false) {
  if (isStream) return `LIVE  ${clock(position)} elapsed`;
  const pos = clock(position);
  const dur = clock(duration);
  return `${pos.padStart(5, " ")}  ${progressBar(position, duration)}  ${dur.padStart(5, " ")}`;
}

/** Trims a string to `max` characters, adding an ellipsis when cut. */
function truncate(text, max = 60) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Escapes Discord markdown so user-supplied titles cannot break formatting. */
function escapeMd(text) {
  return String(text ?? "").replace(/([*_`~\\|>])/g, "\\$1");
}

/** "1:23" | "83" | "1:02:05" -> milliseconds */
function parseTimestamp(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const parts = raw.split(":").map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((part) => /^\d+(\.\d+)?$/.test(part))) return null;
  const numbers = parts.map(Number);
  const seconds = numbers.reduce((acc, value) => acc * 60 + value, 0);
  return Math.round(seconds * 1000);
}

/** 1234 -> "1,234" */
function withCommas(value) {
  return Number(value || 0).toLocaleString("en-US");
}

/** Safe URL check used before setURL/setThumbnail (Discord rejects junk). */
function isHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Splits a raw argument string into tokens (keeps quoted groups together). */
function tokenize(input) {
  const tokens = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = regex.exec(String(input ?? ""))) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

/** Clamps a number into [min, max], falling back when the input is not finite. */
function clamp(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** Total duration of a list of tracks, in milliseconds. */
function totalDuration(tracks = []) {
  return tracks.reduce((sum, track) => sum + (Number(track?.info?.duration) || 0), 0);
}

/** Splits an array into pages of `size` items. */
function paginate(items = [], size = 10) {
  const pages = [];
  for (let index = 0; index < items.length; index += size) {
    pages.push(items.slice(index, index + size));
  }
  return pages.length ? pages : [[]];
}

/** Removes duplicate tracks (by identifier, falling back to uri/title). */
function dedupeTracks(tracks = []) {
  const seen = new Set();
  const unique = [];
  for (const track of tracks) {
    const key = track?.info?.identifier || track?.info?.uri || track?.info?.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(track);
  }
  return unique;
}

/** Sorts tracks by a field, returning a new array. */
function sortTracks(tracks = [], by = "title", order = "asc") {
  const direction = order === "desc" ? -1 : 1;
  const value = (track) => {
    if (by === "duration") return Number(track?.info?.duration) || 0;
    if (by === "author") return String(track?.info?.author || "").toLowerCase();
    return String(track?.info?.title || "").toLowerCase();
  };
  return [...tracks].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (left < right) return -1 * direction;
    if (left > right) return 1 * direction;
    return 0;
  });
}

/** A short, human label for a track's source. */
function sourceLabel(track) {
  const raw = String(track?.info?.sourceName || "unknown");
  return raw.replace(/^\w/, (char) => char.toUpperCase());
}

/** True when the string is an http(s) URL. */
function isUrl(value) {
  return isHttpUrl(value);
}

/**
 * Maps a URL to the Lavalink source that should handle it, plus the config key
 * used to enable/disable that source. Returns null for a plain search term.
 *
 * Lavalink resolves most links itself, but naming the source lets a node with
 * the LavaSrc plugin (Spotify / Apple Music / Deezer / Yandex) load them
 * directly instead of falling back to a YouTube search.
 */
function sourceFromUrl(value) {
  if (!isHttpUrl(value)) return null;
  let host;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }

  const table = [
    { match: /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)music\.youtube\.com$/, source: "youtube", key: "youtube" },
    { match: /(^|\.)soundcloud\.com$/, source: "soundcloud", key: "soundcloud" },
    { match: /(^|\.)spotify\.com$/, source: "spotify", key: "spotify" },
    { match: /(^|\.)music\.apple\.com$|(^|\.)itunes\.apple\.com$/, source: "applemusic", key: "applemusic" },
    { match: /(^|\.)deezer\.com$/, source: "deezer", key: "deezer" },
    { match: /(^|\.)music\.yandex\.(ru|com)$|(^|\.)yandex\.(ru|com)$/, source: "yandexmusic", key: "yandexmusic" },
    { match: /(^|\.)twitch\.tv$/, source: "twitch", key: "twitch" },
    { match: /(^|\.)vimeo\.com$/, source: "vimeo", key: "vimeo" },
    { match: /(^|\.)bandcamp\.com$/, source: "bandcamp", key: "bandcamp" },
  ];

  for (const entry of table) {
    if (entry.match.test(host)) return { source: entry.source, key: entry.key };
  }
  return { source: null, key: null };
}

/**
 * Turns a raw query into the `{ query, source }` pair Lavalink expects.
 *
 * - A recognised link uses its own source (Spotify, Apple Music, …) when that
 *   source is enabled in config; otherwise it is passed through untouched so
 *   Lavalink can still auto-detect it.
 * - A plain search term uses the configured default search platform.
 */
function resolveQuery(query, config = {}) {
  const trimmed = String(query ?? "").trim();
  const detected = sourceFromUrl(trimmed);
  const enabled = config.sources ?? {};

  if (detected) {
    const allowed = detected.key ? enabled[detected.key] !== false : true;
    return { query: trimmed, source: allowed ? detected.source ?? undefined : undefined, isUrl: true };
  }

  return { query: trimmed, source: config.defaultSearchSource || "ytsearch", isUrl: false };
}

/**
 * Best-effort text query for a link whose source is unavailable — used to fall
 * back to a YouTube search when a Spotify/Apple link cannot be loaded directly.
 */
function fallbackQueryFromUrl(value) {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] || "";
    const cleaned = decodeURIComponent(last)
      .replace(/[-_+]+/g, " ")
      .replace(/\.(html?|php)$/i, "")
      .trim();
    return cleaned || String(value);
  } catch {
    return String(value);
  }
}

/* ==========================================================================
 * theme.js
 * ========================================================================== */

/**
 * Visual identity for Gaana — one place for colours, icons and embed chrome so
 * every response looks like it came from the same product.
 *
 * Design language: dark, minimalist, premium.
 *   - a single soft-rose accent reserved for the hero (Now Playing) card
 *   - muted semantic colours for success / warning / error
 *   - NO decorative emoji by default: clean typography, small text, no clutter
 *   - every icon is optional and overridable from config.json (`emojis`), so a
 *     server can drop in its own gradient / animated Discord emoji
 *   - every icon is validated at load time, so an invalid one can never reject
 *     a whole payload (this is what used to break the help menu)
 */

/* ------------------------------------------------------------------ colours */

const COLOR = {
  /** Soft rose — the brand accent, used for the hero card and neutral info. */
  accent: 0xf1b2c1,
  brand: 0xf1b2c1,
  playing: 0xf1b2c1,
  /** Muted, dark-theme friendly semantic colours. */
  success: 0x8bd5a0,
  warning: 0xe9c46a,
  danger: 0xe76f7a,
  /** Near-invisible bar for low-key utility embeds. */
  neutral: 0x2b2d31,
  muted: 0x2b2d31,
};

/* -------------------------------------------------------------------- icons */

/**
 * The default icon set is deliberately tiny: a handful of clean, monochrome
 * glyphs used only where they genuinely aid scanning. Everything else is plain
 * text. Override any key from config.json -> "emojis" (e.g. an animated
 * `<a:play:123456789012345678>`), or set it to "" to remove it entirely.
 *
 * Keys used on BUTTONS (previous, pause, play, skip, stop, volume, loop,
 * shuffle, autoplay, first, prevPage, nextPage, last) default to real emoji,
 * because Discord only accepts a valid emoji in a button slot. Keys used in
 * TEXT (check, cross, warn, info, heart, search, clock, list, trash, bolt, dot)
 * default to plain monochrome glyphs — no clutter.
 */
const DEFAULT_ICONS = {
  // text glyphs
  check: "✓",
  cross: "✕",
  warn: "!",
  info: "i",
  heart: "♥",
  search: "⌕",
  clock: "◷",
  list: "≡",
  trash: "⌫",
  bolt: "⚡",
  dot: "•",
  // button emoji (must be valid Discord emoji)
  play: "▶️",
  pause: "⏸️",
  stop: "⏹️",
  skip: "⏭️",
  previous: "⏮️",
  loop: "🔁",
  shuffle: "🔀",
  volume: "🔊",
  autoplay: "♾️",
  first: "⏮️",
  prevPage: "◀️",
  nextPage: "▶️",
  last: "⏭️",
  // source-choice button emoji (must be valid Discord emoji). Discord ships no
  // Spotify/YouTube brand emoji, so the default is a clean, recognisable glyph
  // (never a coloured circle). Drop your own brand emoji in via
  // config.json -> "emojis" (e.g. "spotify": "<:spotify:123456789012345678>").
  spotify: "🎧",
  youtube: "▶️",
  switchNow: "🔁",
};

/**
 * Discord accepts a Unicode emoji (optionally with a U+FE0F variation
 * selector) or a custom `<:name:id>` / `<a:name:id>` mention. Anything else
 * makes the API reject the entire message with "Invalid Form Body".
 *
 * The Unicode-property form is used rather than a broad codepoint range: a
 * range like `[\u203c-\u3299]` wrongly accepts text-default symbols such as
 * U+2726 (✦), which is exactly the glyph that used to break the help menu.
 * `\p{Emoji_Presentation}` matches characters that render as emoji by default;
 * `\p{Emoji}\uFE0F` matches emoji-capable characters explicitly marked as emoji.
 */
const EMOJI_RE = /^(?:<a?:[a-zA-Z0-9_]+:\d{17,20}>|(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)\uFE0F?)$/u;

/** True when Discord will accept this string as an emoji. */
function isEmoji(value) {
  return EMOJI_RE.test(String(value ?? ""));
}

/**
 * Returns the value when Discord will accept it as an emoji, otherwise a safe
 * fallback. Used for any icon that ends up in an emoji slot (buttons, select
 * options) so a bad glyph can never break a payload.
 */
function safeEmoji(value, fallback = "▶️") {
  const text = String(value ?? "");
  return EMOJI_RE.test(text) ? text : fallback;
}

/**
 * Builds the icon set: defaults, overridden by config.emojis. Icons are used in
 * text (titles/descriptions), so any short string is allowed — but a custom
 * emoji override is validated, and an invalid one falls back to the default.
 */
function buildIcons(overrides = {}) {
  const icons = { ...DEFAULT_ICONS };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    // Allow an explicit empty string to remove an icon entirely.
    if (trimmed === "") {
      icons[key] = "";
      continue;
    }
    // A custom emoji mention must be valid; a plain glyph is taken as-is.
    if (trimmed.startsWith("<") && !isEmoji(trimmed)) continue;
    icons[key] = trimmed;
  }
  return icons;
}

/** The default icon set (used when no config is available, e.g. in tests). */
const ICONS = buildIcons();

/** Resolves the icon set for a context, honouring config.emojis overrides. */
function iconsFor(ctx) {
  return ctx?.icons ?? ICONS;
}

/* -------------------------------------------------------------- embed chrome */

/** Zero-width spacer used to keep field grids visually even. */
const BLANK = "\u200b";

/**
 * The single card builder every embed goes through, so the whole bot shares one
 * look: brand footer, optional author line, optional thumbnail, tidy fields.
 */
function card(ctx, {
  color = ctx?.config?.embedColor ?? COLOR.accent,
  author = null,
  title = null,
  description = null,
  thumbnail = null,
  url = null,
  fields = [],
  footer = null,
  timestamp = true,
} = {}) {
  const name = ctx?.config?.botName ?? "Gaana";
  const embed = new EmbedBuilder().setColor(color);

  if (author) embed.setAuthor({ name: String(author).slice(0, 256) });
  if (title) embed.setTitle(String(title).slice(0, 256));
  if (description) embed.setDescription(String(description).slice(0, 4096));
  if (isHttpUrl(url)) embed.setURL(url);
  if (isHttpUrl(thumbnail)) embed.setThumbnail(thumbnail);

  for (const field of fields) {
    if (!field || field.value === undefined || field.value === null) continue;
    embed.addFields({
      name: String(field.name ?? BLANK).slice(0, 256),
      value: String(field.value).slice(0, 1024) || BLANK,
      inline: Boolean(field.inline),
    });
  }

  embed.setFooter({ text: String(footer ?? `${name} • music, simplified`).slice(0, 2048) });
  if (timestamp) embed.setTimestamp();
  return embed;
}

/** Backwards-compatible alias used across the codebase. */
function baseEmbed(ctx, color = ctx?.config?.embedColor ?? COLOR.accent) {
  return card(ctx, { color });
}

function noticeEmbed(ctx, { title, description, color = COLOR.accent, thumbnail = null } = {}) {
  return card(ctx, { title, description, color, thumbnail });
}

/* --------------------------------------------------------- semantic notices */

const ok = (ctx, description, title = "Done") =>
  card(ctx, { title, description, color: COLOR.success });

const err = (ctx, description, title = "Something went wrong") =>
  card(ctx, { title, description, color: COLOR.danger });

const warn = (ctx, description, title = "Heads up") =>
  card(ctx, { title, description, color: COLOR.warning });

const info = (ctx, description, title = "Info") =>
  card(ctx, { title, description, color: COLOR.accent });

/** A compact "label: value" line for descriptions. */
const kv = (label, value) => `**${label}** ${value}`;

/** A thin visual separator that survives Discord's markdown. */
const DIVIDER = "───────────────────────";

/* ==========================================================================
 * config.js
 * ========================================================================== */

/**
 * Config loading + validation.
 *
 * Every secret comes from config.json or environment variables — nothing is
 * hardcoded in the source. Environment variables win so hosts that inject
 * secrets (most panels do) keep working without editing files.
 */

const configLog = logger;

/**
 * Activity types the presence commands accept. Declared here (before DEFAULTS)
 * so config validation can reference the key list without a TDZ error.
 */
const PRESENCE_TYPES = {
  playing: ActivityType.Playing,
  streaming: ActivityType.Streaming,
  listening: ActivityType.Listening,
  watching: ActivityType.Watching,
  competing: ActivityType.Competing,
  custom: ActivityType.Custom,
};

const PRESENCE_TYPE_KEYS = Object.keys(PRESENCE_TYPES);
const ACTIVITY_MAX = 128; // Discord's hard limit for an activity name

const DEFAULTS = {
  prefix: "?",
  botName: "Gaana",
  embedColor: "#f1b2c1",
  defaultVolume: 80,
  maxVolume: 150,
  defaultSearchSource: "ytsearch",
  sourceChoice: "youtube",
  maxQueueSize: 1000,
  stayInVoiceByDefault: false,
  supportServerUrl: "",
  voteUrl: "",
  developerIds: [],
  registerSlashCommands: true,
  slashGuildIds: [],
  activityRotation: ["{prefix}help  •  Gaana", "music for {servers} servers"],
  presence: {
    defaultStreamUrl: "https://www.twitch.tv/gaana",
    defaultStreamText: "Gaana Radio",
    defaultActivityType: "listening",
  },
};

/**
 * Which link sources the bot will hand to Lavalink by name. All are on by
 * default; a source only actually works if the Lavalink node has the matching
 * plugin (LavaSrc for Spotify/Apple/Deezer/Yandex, LavaSearch for others).
 * Turning one off makes the bot pass the raw link through instead, so Lavalink
 * can still auto-detect it.
 */
const DEFAULT_SOURCES = {
  youtube: true,
  soundcloud: true,
  spotify: true,
  applemusic: true,
  deezer: true,
  yandexmusic: true,
  twitch: true,
  vimeo: true,
  bandcamp: true,
};

/** Accepts "#5865F2", "5865F2" or 0x5865F2 and returns a Discord-ready integer. */
function parseColor(value, fallback = 0x5865f2) {
  if (typeof value === "number" && Number.isFinite(value)) return value & 0xffffff;
  const raw = String(value ?? "").trim().replace(/^#/, "").replace(/^0x/i, "");
  if (!/^[0-9a-f]{6}$/i.test(raw)) return fallback;
  return Number.parseInt(raw, 16);
}

function loadConfig(configPath) {
  let raw = {};
  try {
    const text = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
    // Strip // and /* */ comments so users can annotate their config freely.
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    raw = JSON.parse(stripped);
  } catch (error) {
    if (error.code === "ENOENT") {
      configLog.error(`config.json not found at ${configPath}`);
      configLog.error("Copy config.example.json to config.json and fill in your token + Lavalink node.");
    } else {
      configLog.error("config.json could not be parsed:", error.message);
    }
    process.exit(1);
  }

  const env = process.env;

  const token = String(env.DISCORD_TOKEN || raw.token || "").trim();
  const invalidToken =
    !token || token === "YOUR_DISCORD_BOT_TOKEN_HERE" || token.length < 20;

  const nodesRaw = Array.isArray(raw.lavalink?.nodes) ? raw.lavalink.nodes : [];

  // A single URL form is also supported: LAVALINK_URL=lavalink://id:pass@host:port
  const urlNodes = String(env.LAVALINK_URL || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseLavalinkUrl)
    .filter(Boolean);

  // When a LAVALINK_URL is supplied, ignore the file's nodes entirely —
  // otherwise a leftover placeholder in config.json gets merged in beside it.
  const fileNodes = urlNodes.length ? [] : nodesRaw;

  const allNodes = [...urlNodes, ...fileNodes]
    .map((node, index) => normalizeNode(node, index))
    .filter(Boolean);

  const developerIds = [
    ...(Array.isArray(raw.developerIds) ? raw.developerIds : []),
    ...String(env.DEVELOPER_IDS || "").split(","),
  ]
    .map((id) => String(id).trim())
    .filter((id) => /^\d{17,20}$/.test(id));

  const config = {
    token: invalidToken ? "" : token,
    tokenMissing: invalidToken,
    prefix: String(raw.prefix ?? DEFAULTS.prefix).slice(0, 5) || DEFAULTS.prefix,
    botName: String(raw.botName ?? DEFAULTS.botName).trim() || DEFAULTS.botName,
    embedColor: parseColor(raw.embedColor, parseColor(DEFAULTS.embedColor)),
    defaultVolume: clampNumber(raw.defaultVolume, 1, 150, DEFAULTS.defaultVolume),
    maxVolume: clampNumber(raw.maxVolume, 10, 200, DEFAULTS.maxVolume),
    defaultSearchSource: String(raw.defaultSearchSource ?? DEFAULTS.defaultSearchSource).trim(),
    sourceChoice: ["spotify", "youtube"].includes(String(raw.sourceChoice ?? "").toLowerCase())
      ? String(raw.sourceChoice).toLowerCase()
      : DEFAULTS.sourceChoice,
    maxQueueSize: clampNumber(raw.maxQueueSize, 10, 10000, DEFAULTS.maxQueueSize),
    stayInVoiceByDefault: Boolean(raw.stayInVoiceByDefault ?? DEFAULTS.stayInVoiceByDefault),
    supportServerUrl: String(raw.supportServerUrl ?? "").trim(),
    voteUrl: String(raw.voteUrl ?? "").trim(),
    registerSlashCommands: raw.registerSlashCommands === undefined ? DEFAULTS.registerSlashCommands : Boolean(raw.registerSlashCommands),
    slashGuildIds: (Array.isArray(raw.slashGuildIds) ? raw.slashGuildIds : [])
      .map((id) => String(id).trim())
      .filter((id) => /^\d{17,20}$/.test(id)),
    developerIds: [...new Set(developerIds)],
    activityRotation: Array.isArray(raw.activityRotation) && raw.activityRotation.length
      ? raw.activityRotation.map((line) => String(line)).slice(0, 8)
      : DEFAULTS.activityRotation,
    presence: {
      defaultStreamUrl: String(raw.presence?.defaultStreamUrl ?? DEFAULTS.presence.defaultStreamUrl).trim() || DEFAULTS.presence.defaultStreamUrl,
      defaultStreamText: String(raw.presence?.defaultStreamText ?? DEFAULTS.presence.defaultStreamText).trim() || DEFAULTS.presence.defaultStreamText,
      defaultActivityType: PRESENCE_TYPE_KEYS.includes(String(raw.presence?.defaultActivityType ?? "").toLowerCase())
        ? String(raw.presence.defaultActivityType).toLowerCase()
        : DEFAULTS.presence.defaultActivityType,
    },
    sources: { ...DEFAULT_SOURCES, ...(raw.sources && typeof raw.sources === "object" ? raw.sources : {}) },
    emojis: raw.emojis && typeof raw.emojis === "object" ? raw.emojis : {},
    nodes: allNodes,
    maxVolumeFromSource: clampNumber(raw.maxVolume, 10, 200, DEFAULTS.maxVolume),
  };

  // Resolve the icon set once, honouring any config.emojis overrides.
  config.icons = buildIcons(config.emojis);

  if (config.defaultVolume > config.maxVolume) config.defaultVolume = config.maxVolume;

  validateConfig(config, nodesRaw);
  return config;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** lavalink://nodeId:password@host:port -> node object */
function parseLavalinkUrl(value) {
  try {
    const url = new URL(value);
    if (!/^(lavalink|nodelink):$/.test(url.protocol)) return null;
    return {
      id: decodeURIComponent(url.username) || "main",
      password: decodeURIComponent(url.password) || "",
      host: url.hostname,
      port: Number(url.port || (url.protocol === "nodelink:" ? 3000 : 2333)),
      secure: url.protocol === "nodelink:" ? url.port === "443" : false,
    };
  } catch {
    configLog.warn(`Ignoring malformed LAVALINK_URL entry: ${value}`);
    return null;
  }
}

function normalizeNode(node, index) {
  if (!node || typeof node !== "object") return null;
  const host = String(node.host ?? "").trim();
  const password = String(node.password ?? node.authorization ?? "").trim();

  const hostLooksLikePlaceholder = !host || /your[_-]?lavalink/i.test(host);
  const passwordLooksLikePlaceholder = !password || /your[_-]?lavalink/i.test(password);

  if (hostLooksLikePlaceholder && passwordLooksLikePlaceholder) {
    configLog.warn(
      `Lavalink node #${index + 1} is still a placeholder (host/password not filled in) — it has been ignored.`
    );
    return null;
  }

  const secure = Boolean(node.secure);
  let port = Number(node.port);
  if (!Number.isFinite(port) || port <= 0) port = secure ? 443 : 2333;

  return {
    id: String(node.id || `node-${index + 1}`),
    host,
    port,
    password,
    secure,
    retryAmount: Number(node.retryAmount) || 10,
    retryDelay: Number(node.retryDelay) || 5000,
  };
}

function validateConfig(config, rawNodes) {
  if (config.tokenMissing) {
    configLog.error("Discord bot token is missing.");
    configLog.error("Set it in config.json (\"token\") or via the DISCORD_TOKEN environment variable.");
  }
  if (!config.nodes.length) {
    configLog.error("No usable Lavalink node configured.");
    configLog.error("Fill in lavalink.nodes[0] in config.json (host, port, password) or set LAVALINK_URL.");
    if (Array.isArray(rawNodes) && rawNodes.length) {
      configLog.error("The configured node still contains placeholder values.");
    }
  }
  if (config.tokenMissing || !config.nodes.length) {
    configLog.error("Refusing to start with an incomplete configuration. Fill in the values above and restart.");
    process.exit(1);
  }
}

/** Directory that holds the runtime JSON stores. */
function dataDir(rootDir) {
  const dir = path.join(rootDir, "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ==========================================================================
 * store.js
 * ========================================================================== */

/**
 * A small, crash-safe JSON key/value store.
 *
 * Values are written atomically (tmp file + rename) on a short debounce, so a
 * container that is killed at any moment never ends up with a truncated file.
 */

const storeLog = createLogger("store");

class JsonStore {
  constructor(filePath, defaults = {}) {
    this.filePath = filePath;
    this.data = { ...defaults };
    this.timer = null;
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf8").replace(/^\uFEFF/, "").trim();
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.data = parsed;
      }
    } catch (error) {
      // A corrupt store must never stop the bot from booting.
      storeLog.warn(`Could not read ${path.basename(this.filePath)} — starting fresh:`, error.message);
      this.backupBrokenFile();
    }
  }

  backupBrokenFile() {
    try {
      const broken = `${this.filePath}.broken`;
      if (!fs.existsSync(broken)) fs.copyFileSync(this.filePath, broken);
    } catch {
      /* best effort */
    }
  }

  get(key, fallback = undefined) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this.data, key);
  }

  set(key, value) {
    this.data[key] = value;
    this.schedule();
    return value;
  }

  delete(key) {
    if (!this.has(key)) return false;
    delete this.data[key];
    this.schedule();
    return true;
  }

  all() {
    return this.data;
  }

  keys() {
    return Object.keys(this.data);
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 250);
  }

  save() {
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, this.filePath);
      return true;
    } catch (error) {
      storeLog.error(`Could not save ${path.basename(this.filePath)}:`, error.message);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.save();
  }
}

/** Store factories used by the bot. Data lives in ./data so it survives restarts. */
function createStores(dataDir) {
  return {
    prefixes: new JsonStore(path.join(dataDir, "prefixes.json"), {}),
    languages: new JsonStore(path.join(dataDir, "languages.json"), {}),
    stay247: new JsonStore(path.join(dataDir, "stay247.json"), {}),
    favorites: new JsonStore(path.join(dataDir, "favorites.json"), {}),
    playlists: new JsonStore(path.join(dataDir, "playlists.json"), {}),
    queuesaves: new JsonStore(path.join(dataDir, "queuesaves.json"), {}),
    history: new JsonStore(path.join(dataDir, "history.json"), {}),
    settings: new JsonStore(path.join(dataDir, "settings.json"), {}),
  };
}

/* ==========================================================================
 * music.js
 * ========================================================================== */

/**
 * Everything that talks to Lavalink and renders the player UI:
 * guards, player lifecycle, the Now Playing card, the queue pager and filters.
 *
 * The Now Playing card is posted through ONE function (`postNowPlaying`) which
 * either edits the tracked message or sends exactly one new one. That is what
 * keeps a single live card on screen — no stacking, no duplicates.
 */

/** An expected, user-facing failure (bad input, wrong channel, missing perms). */
class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}

function fail(message) {
  throw new UserError(message);
}

/* ------------------------------------------------------- player data access */

/**
 * lavalink-client v2 deprecates `player.set/get` in favour of `setData/getData`.
 * These helpers prefer the modern API and fall back to the old one, so both the
 * real player and the offline test fakes work.
 */
function pget(player, key) {
  if (typeof player?.getData === "function") return player.getData(key);
  return player?.get?.(key);
}

function pset(player, key, value) {
  if (typeof player?.setData === "function") return player.setData(key, value);
  return player?.set?.(key, value);
}

/* ------------------------------------------------------------------ guards */

function getPlayer(ctx, guildId) {
  return ctx.lavalink?.getPlayer(guildId) ?? null;
}

function requirePlayer(ctx, guildId) {
  const player = getPlayer(ctx, guildId);
  if (!player) fail("Nothing is playing right now — start a track with **play** first.");
  return player;
}

function requireCurrentTrack(player) {
  if (!player?.queue?.current) fail("Nothing is playing right now.");
  return player.queue.current;
}

/** Validates the member is in a voice channel the bot can actually use. */
function requireVoiceChannel(member) {
  const channel = member?.voice?.channel;
  if (!channel) fail("Join a voice channel first, then run the command again.");
  const me = member.guild.members.me;
  const perms = channel.permissionsFor(me);
  if (!perms?.has("Connect")) fail(`I can't join **${channel.name}** — I'm missing the **Connect** permission.`);
  if (!perms?.has("Speak")) fail(`I can't speak in **${channel.name}** — I'm missing the **Speak** permission.`);
  return channel;
}

/** Prevents two people fighting over the same player from different channels. */
function requireSameChannel(player, member) {
  if (!player?.voiceChannelId) return;
  const channelId = member?.voice?.channelId;
  if (channelId && player.voiceChannelId !== channelId) {
    fail(`I'm already playing in <#${player.voiceChannelId}>. Join that channel to control the player.`);
  }
}

function is247(ctx, guildId) {
  return Boolean(ctx.stores.stay247.get(guildId, ctx.config.stayInVoiceByDefault));
}

/* --------------------------------------------------------- player lifecycle */

/**
 * Waits until the node confirms the voice connection, retrying the handshake
 * once. Without this the bot can look "connected" locally while the node never
 * received the voice handshake — the classic "card shows but no audio" state.
 * Returns true when the node confirmed, false when it did not (the caller then
 * tells the user instead of failing silently).
 */
async function ensureVoiceConnected(player, { attempts = 2, waitMs = 5000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (player.connected) return true;
    await player.connect().catch(() => {});
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (player.connected) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return Boolean(player.connected);
}

/** Fetches the existing player or creates + connects a fresh one. */
async function getOrCreatePlayer(ctx, guild, voiceChannel, textChannel, requester) {
  let player = getPlayer(ctx, guild.id);

  if (!player) {
    player = ctx.lavalink.createPlayer({
      guildId: guild.id,
      voiceChannelId: voiceChannel.id,
      textChannelId: textChannel.id,
      volume: ctx.config.defaultVolume,
      selfDeaf: true,
      instaUpdateFiltersFix: true,
    });
    pset(player, "autoplay", false);
    pset(player, "requesterId", requester?.id ?? null);
    await player.connect();
    return player;
  }

  if (player.voiceChannelId !== voiceChannel.id) {
    await player.changeVoiceState({ voiceChannelId: voiceChannel.id });
  }
  player.textChannelId = textChannel.id;
  return player;
}

/** Best-effort artwork for a track. */
function artworkOf(track) {
  const info = track?.info ?? {};
  if (isHttpUrl(info.artworkUrl)) return info.artworkUrl;
  if (String(info.sourceName || "").includes("youtube") && info.identifier) {
    return `https://img.youtube.com/vi/${info.identifier}/hqdefault.jpg`;
  }
  return null;
}

function loopLabel(player, ctx = null) {
  const icons = iconsFor(ctx);
  if (player.repeatMode === "track") return `${icons.loop} Track`;
  if (player.repeatMode === "queue") return `${icons.loop} Queue`;
  return "Off";
}

/* ------------------------------------------------------------ now playing */

/**
 * The Now Playing card — deliberately tiny. A compact, dark, minimal card with
 * just the essentials: the track, who asked for it, and how long it runs. No
 * artwork, no progress bar, no field grid — nothing that makes the embed tall.
 */
function nowPlayingEmbed(ctx, player, track, requesterId = null) {
  const info = track?.info ?? {};
  const icons = iconsFor(ctx);
  const requestedBy = requesterId || track?.requester?.id;
  const duration = info.isStream ? "LIVE" : clock(info.duration);

  const meta = [
    escapeMd(truncate(info.author || "Unknown artist", 50)),
    duration,
    requestedBy ? `<@${requestedBy}>` : null,
  ]
    .filter(Boolean)
    .join("  •  ");

  return card(ctx, {
    color: COLOR.playing,
    author: `${ctx.config.botName} • Now Playing`,
    description: `${icons.play} **${escapeMd(truncate(info.title || "Unknown title", 80))}**\n${meta}`,
    url: isHttpUrl(info.uri) ? info.uri : null,
    footer: ctx.config.botName,
  });
}

/** Pause/resume, skip, previous, loop, shuffle, stop, volume, autoplay. */
function playerComponents(ctx, player) {
  const icons = iconsFor(ctx);
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("gaana:prev").setEmoji(safeEmoji(icons.previous)).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("gaana:pause")
      .setEmoji(safeEmoji(player.paused ? icons.play : icons.pause))
      .setStyle(player.paused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("gaana:skip").setEmoji(safeEmoji(icons.skip)).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("gaana:stop").setEmoji(safeEmoji(icons.stop)).setStyle(ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("gaana:vol_down").setEmoji(safeEmoji(icons.volume)).setLabel("-10").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("gaana:vol_up").setEmoji(safeEmoji(icons.volume)).setLabel("+10").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("gaana:loop")
      .setEmoji(safeEmoji(icons.loop))
      .setStyle(player.repeatMode === "off" ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("gaana:shuffle")
      .setEmoji(safeEmoji(icons.shuffle))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("gaana:autoplay")
      .setEmoji(safeEmoji(icons.autoplay))
      .setStyle(pget(player, "autoplay") ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  return [row1, row2];
}

/* ------------------------------------------------------- source choice */

/**
 * The two sources a listener can pick between. `source` is the Lavalink search
 * platform used for plain text searches; `label` is what the button shows.
 */
const SOURCE_CHOICES = [
  { key: "spotify", source: "spsearch", label: "Spotify" },
  { key: "youtube", source: "ytsearch", label: "YouTube" },
];

/**
 * Sources tried, in order, when the requested one returns nothing. SoundCloud
 * is deliberately excluded: it is broken on many shared Lavalink nodes (it
 * answers `loadType: error`), so falling back to it would just fail again.
 */
const SOURCE_FALLBACKS = ["ytsearch", "spsearch", "ytmsearch"];

/** The source key currently selected for a guild (persisted), or null. */
function getSourceChoice(ctx, player) {
  const fromPlayer = pget(player, "sourceChoice");
  if (fromPlayer) return fromPlayer;
  const guildId = player?.guildId;
  if (!guildId) return null;
  const saved = ctx?.stores?.settings?.get(guildId, null);
  const value = saved && typeof saved === "object" ? saved.sourceChoice : null;
  if (SOURCE_CHOICES.some((choice) => choice.key === value)) return value;
  // Fall back to the configured default (config.json -> "sourceChoice").
  const fallback = ctx?.config?.sourceChoice;
  return SOURCE_CHOICES.some((choice) => choice.key === fallback) ? fallback : null;
}

/** Persists the source choice for a guild and mirrors it onto the player. */
function setSourceChoice(ctx, player, key) {
  const valid = SOURCE_CHOICES.some((choice) => choice.key === key) ? key : null;
  pset(player, "sourceChoice", valid);
  const guildId = player?.guildId;
  if (guildId && ctx?.stores?.settings) {
    const current = ctx.stores.settings.get(guildId, {});
    const next = current && typeof current === "object" ? { ...current } : {};
    if (valid) next.sourceChoice = valid;
    else delete next.sourceChoice;
    ctx.stores.settings.set(guildId, next);
  }
  return valid;
}

/** The Lavalink search platform implied by the current choice, or null. */
function sourceChoicePlatform(ctx, player) {
  const key = getSourceChoice(ctx, player);
  return SOURCE_CHOICES.find((choice) => choice.key === key)?.source ?? null;
}

/**
 * The source-choice row: two buttons, one per source. The selected source is
 * highlighted (Success) and disabled; the other is clickable. Sits on its own
 * row below the playback controls so the compact card never grows.
 */
function sourceChoiceComponents(ctx, player) {
  const icons = iconsFor(ctx);
  const selected = getSourceChoice(ctx, player);

  const buttons = SOURCE_CHOICES.map((choice) => {
    const isSelected = selected === choice.key;
    return new ButtonBuilder()
      .setCustomId(`gaana:src:${choice.key}`)
      .setEmoji(safeEmoji(icons[choice.key], choice.key === "spotify" ? "🎧" : "▶️"))
      .setLabel(isSelected ? `${choice.label} ✓` : choice.label)
      .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(isSelected);
  });

  // "Switch now" re-resolves the CURRENT track through the selected source and
  // restarts it immediately. It is only meaningful while something is playing,
  // so it is disabled otherwise. The two source buttons above only steer the
  // NEXT search — this is the explicit opt-in for an instant switch.
  const canSwitchNow = Boolean(player?.queue?.current);
  buttons.push(
    new ButtonBuilder()
      .setCustomId("gaana:srcnow")
      .setEmoji(safeEmoji(icons.switchNow, "🔁"))
      .setLabel("Switch now")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!canSwitchNow)
  );

  return [new ActionRowBuilder().addComponents(...buttons)];
}

/** Payload used for the tracked "now playing" message. */
function nowPlayingPayload(ctx, player, track, requesterId = null) {
  return {
    embeds: [nowPlayingEmbed(ctx, player, track, requesterId)],
    components: [...playerComponents(ctx, player), ...sourceChoiceComponents(ctx, player)],
  };
}

/**
 * Per-player serialisation lock. The `play` command and the `trackStart` event
 * can both call postNowPlaying within the same tick; without this they could
 * each read "no tracked card" and each send one. The lock makes the second call
 * wait for the first, so it sees the tracked message and edits it instead.
 */
const npLocks = new WeakMap();

/**
 * THE single entry point for showing the Now Playing card.
 *
 * If a card is already tracked for this player it is EDITED in place; only when
 * there is no live card does it send a new one. Both the `play` command and the
 * `trackStart` event call this, so a track change can never produce two cards.
 */
async function postNowPlaying(ctx, player, track, requesterId = null) {
  if (!track) return null;
  const previous = npLocks.get(player) ?? Promise.resolve();
  const run = previous.then(() => doPostNowPlaying(ctx, player, track, requesterId)).catch(() => null);
  npLocks.set(player, run);
  return run;
}

async function doPostNowPlaying(ctx, player, track, requesterId = null) {
  const tracked = pget(player, "nowPlaying");
  const channelId = tracked?.channelId ?? player.textChannelId;
  const channel = ctx.client.channels.cache.get(channelId);
  if (!channel?.isTextBased()) return null;

  const payload = nowPlayingPayload(ctx, player, track, requesterId);

  if (tracked?.messageId) {
    const message = await channel.messages.fetch(tracked.messageId).catch(() => null);
    if (message) {
      await message.edit(payload).catch(() => {});
      pset(player, "nowPlaying", { ...tracked, requesterId: requesterId ?? tracked.requesterId });
      return message;
    }
    // The tracked message was deleted — fall through and send a fresh one.
  }

  const sent = await channel.send(payload).catch(() => null);
  if (sent) {
    pset(player, "nowPlaying", { messageId: sent.id, channelId: sent.channelId, requesterId });
  }
  return sent;
}

/**
 * Live progress updates: one interval for the whole process, refreshing only the
 * tracked message of each guild every 15s (well inside Discord rate limits).
 */
function startProgressTicker(ctx) {
  const timer = setInterval(async () => {
    for (const player of ctx.lavalink.players.values()) {
      const tracked = pget(player, "nowPlaying");
      const track = player.queue?.current;
      if (!tracked?.messageId || !track) continue;

      const channel = ctx.client.channels.cache.get(tracked.channelId);
      if (!channel?.isTextBased()) continue;

      try {
        const message = await channel.messages.fetch(tracked.messageId).catch(() => null);
        if (!message) {
          pset(player, "nowPlaying", null);
          continue;
        }
        await message.edit(nowPlayingPayload(ctx, player, track, tracked.requesterId));
      } catch {
        /* a deleted message or a transient API error must never crash the loop */
      }
    }
  }, 15_000);

  timer.unref?.();
  return timer;
}

/** Removes the tracked player message (used on stop / track change / leave). */
async function clearNowPlaying(ctx, player) {
  const tracked = pget(player, "nowPlaying");
  if (!tracked?.messageId) return;
  pset(player, "nowPlaying", null);
  const channel = ctx.client.channels.cache.get(tracked.channelId);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(tracked.messageId).catch(() => null);
  if (message) await message.delete().catch(() => {});
}

/* ------------------------------------------------------------- queue pager */

const QUEUE_PAGE_SIZE = 10;

/**
 * Builds one page of the interactive queue view: totals in the footer, and each
 * track's position, title, duration and requester in the body. Minimal styling —
 * no decorative emoji, just clean lines.
 */
function buildQueuePage(ctx, player, page = 1, pageSize = QUEUE_PAGE_SIZE) {
  const icons = iconsFor(ctx);
  const tracks = player.queue.tracks;
  const current = player.queue.current;
  const totalPages = Math.max(1, Math.ceil(tracks.length / pageSize));
  const safePage = Math.min(totalPages, Math.max(1, Number(page) || 1));
  const slice = tracks.slice((safePage - 1) * pageSize, safePage * pageSize);

  const embed = card(ctx, {
    color: COLOR.accent,
    author: `${ctx.config.botName} • Queue`,
    title: current ? truncate(current.info.title, 80) : "Queue",
    description: current
      ? `Now playing  •  \`${clock(player.position)} / ${clock(current.info.duration)}\`  •  <@${current.requester?.id ?? ctx.client.user.id}>`
      : null,
  });

  if (slice.length) {
    const lines = slice.map((track, index) => {
      const position = (safePage - 1) * pageSize + index + 1;
      const requester = track.requester?.id ? `  •  <@${track.requester.id}>` : "";
      return `\`${String(position).padStart(2, "0")}\`  [${truncate(track.info.title, 48)}](${track.info.uri})  \`${clock(track.info.duration)}\`${requester}`;
    });
    // Discord caps a field value at 1024 characters — split long pages across
    // several fields so a page of long titles never breaks the payload.
    const chunks = [];
    let buffer = "";
    for (const line of lines) {
      if (buffer && buffer.length + line.length + 1 > 1000) {
        chunks.push(buffer);
        buffer = line;
      } else {
        buffer = buffer ? `${buffer}\n${line}` : line;
      }
    }
    if (buffer) chunks.push(buffer);
    chunks.forEach((value, index) => {
      embed.addFields({ name: index === 0 ? "Up next" : "Up next (cont.)", value, inline: false });
    });
  } else {
    embed.addFields({ name: "Up next", value: "Nothing queued — this is the last track.", inline: false });
  }

  embed.setFooter({
    text: `${ctx.config.botName} • ${tracks.length} track${tracks.length === 1 ? "" : "s"} • ${longDuration(totalDuration(tracks))} total • page ${safePage}/${totalPages}`,
  });

  return { embeds: [embed], components: queuePagerComponents(ctx, safePage, totalPages), page: safePage, totalPages };
}

/** First / previous / page-indicator / next / last buttons. */
function queuePagerComponents(ctx, page, totalPages) {
  const icons = iconsFor(ctx);
  const atFirst = page <= 1;
  const atLast = page >= totalPages;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("gaana:q:first").setEmoji(safeEmoji(icons.first)).setStyle(ButtonStyle.Secondary).setDisabled(atFirst),
    new ButtonBuilder().setCustomId("gaana:q:prev").setEmoji(safeEmoji(icons.prevPage)).setStyle(ButtonStyle.Primary).setDisabled(atFirst),
    new ButtonBuilder().setCustomId("gaana:q:page").setLabel(`Page ${page}/${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId("gaana:q:next").setEmoji(safeEmoji(icons.nextPage)).setStyle(ButtonStyle.Primary).setDisabled(atLast),
    new ButtonBuilder().setCustomId("gaana:q:last").setEmoji(safeEmoji(icons.last)).setStyle(ButtonStyle.Secondary).setDisabled(atLast)
  );

  return [row];
}

/** Disables every pager button (used when the collector times out). */
function disabledQueuePager(ctx, page, totalPages) {
  const rows = queuePagerComponents(ctx, page, totalPages);
  for (const component of rows[0].components) component.setDisabled(true);
  return rows;
}

/* ---------------------------------------------------------------- history */

const HISTORY_LIMIT = 25;

/** Records a played track in the guild's recent-history list. */
function pushHistory(ctx, guildId, track) {
  if (!track?.info) return;
  const list = ctx.stores.history.get(guildId, []);
  const entry = {
    title: track.info.title,
    uri: track.info.uri,
    author: track.info.author,
    duration: track.info.duration,
    requesterId: track.requester?.id ?? null,
    at: Date.now(),
  };
  const next = [entry, ...(Array.isArray(list) ? list : [])].slice(0, HISTORY_LIMIT);
  ctx.stores.history.set(guildId, next);
}

function historyOf(ctx, guildId) {
  const list = ctx.stores.history.get(guildId, []);
  return Array.isArray(list) ? list : [];
}

/* ---------------------------------------------------------------- search */

/**
 * Runs a search and returns the result, translating failures into UserError.
 *
 * Multi-source: a recognised link (Spotify, Apple Music, SoundCloud, Deezer, …)
 * is handed to Lavalink with its own source so a node with the matching plugin
 * loads it directly. If that source is unavailable, the bot falls back to a
 * YouTube search built from the link's text, so a Spotify link still plays.
 */
async function search(ctx, player, query, requester) {
  const trimmed = String(query || "").trim();
  if (!trimmed) fail("Give me a song name, a link, or a search term.");

  const resolved = resolveQuery(trimmed, ctx.config);

  // A per-guild source choice overrides the default search platform for plain
  // text searches. Links keep their own source (a Spotify link still goes to
  // Spotify), so the choice only steers "play <song name>".
  if (!resolved.isUrl) {
    const chosen = sourceChoicePlatform(ctx, player);
    if (chosen) resolved.source = chosen;
  }

  let result = null;
  try {
    result = await player.search({ query: resolved.query, source: resolved.source }, requester);
  } catch (error) {
    ctx.log.debug("search failed:", error.message);
    result = null;
  }

  // A source can be missing, rate-limited or simply broken on a node (SoundCloud
  // is a common casualty). Instead of failing silently, walk a fallback chain of
  // sources that are known to work, so a search almost always returns audio.
  const unusable = !result || result.loadType === "error" || result.loadType === "empty" || !result.tracks?.length;
  if (unusable) {
    const tried = new Set([resolved.source].filter(Boolean));
    const chain = resolved.isUrl
      ? [ctx.config.defaultSearchSource || "ytsearch", ...SOURCE_FALLBACKS]
      : SOURCE_FALLBACKS;
    const fallbackQuery = resolved.isUrl ? fallbackQueryFromUrl(trimmed) : trimmed;
    for (const source of chain) {
      if (!source || tried.has(source)) continue;
      tried.add(source);
      try {
        const retry = await player.search({ query: fallbackQuery, source }, requester);
        if (retry?.tracks?.length) {
          ctx.log.debug(`source fallback ${resolved.source ?? "?"} -> ${source} for "${fallbackQuery}"`);
          return retry;
        }
      } catch (error) {
        ctx.log.debug(`source fallback ${source} failed:`, error.message);
      }
    }
  }

  if (!result) fail("I couldn't reach the music server just now. Try again in a moment.");
  if (result.loadType === "error") {
    fail(`The music server couldn't load that track${result.exception?.message ? ` (${truncate(result.exception.message, 100)})` : ""}. Try a different search or source.`);
  }
  if (result.loadType === "empty" || !result.tracks?.length) {
    fail(`No results for **${truncate(trimmed, 80)}** on any available source. Try a different search.`);
  }
  return result;
}

/**
 * Re-resolves the CURRENT track through the guild's selected source and restarts
 * it immediately. Used by the "Switch now" button — the explicit opt-in for a
 * mid-track source change (the plain source buttons only steer the next search).
 */
async function switchCurrentTrack(ctx, player) {
  const current = player?.queue?.current;
  if (!current) fail("Nothing is playing right now.");
  const platform = sourceChoicePlatform(ctx, player) || ctx.config.defaultSearchSource || "ytsearch";
  const query = [current.info?.title, current.info?.author].filter(Boolean).join(" ");
  if (!query) fail("I couldn't work out what to search for.");

  let result = null;
  try {
    result = await player.search({ query, source: platform }, current.requester);
  } catch (error) {
    ctx.log.debug("switch-now search failed:", error.message);
  }
  if (!result?.tracks?.length) {
    fail(`Couldn't find **${truncate(current.info?.title ?? "that track", 60)}** on ${platform}.`);
  }

  const replacement = result.tracks[0];
  replacement.requester = current.requester;
  await player.play({ clientTrack: replacement });
  return replacement;
}

/** Adds a search result to the queue, respecting the configured queue ceiling. */
async function enqueue(ctx, player, result, requester) {
  const tracks = result.loadType === "playlist" ? result.tracks : [result.tracks[0]];
  const room = ctx.config.maxQueueSize - player.queue.tracks.length;
  if (room <= 0) fail(`The queue is full (${ctx.config.maxQueueSize} tracks). Clear it or wait for tracks to finish.`);

  const accepted = tracks.slice(0, room);
  for (const track of accepted) {
    if (requester) track.requester = requester;
    // queue.add() is async (it persists the queue) — always await it.
    await player.queue.add(track);
  }

  if (!player.playing && !player.paused) await player.play();

  return {
    added: accepted.length,
    skipped: tracks.length - accepted.length,
    playlist: result.loadType === "playlist" ? result.playlist?.name ?? "Playlist" : null,
  };
}

/** Keeps music going after the queue empties (per-guild toggle). */
async function autoplayNext(ctx, player, lastTrack) {
  if (!lastTrack) return false;
  const seed = lastTrack.info?.author || lastTrack.info?.title;
  if (!seed) return false;

  try {
    const result = await player.search({ query: `${seed} similar songs`, source: "ytsearch" }, lastTrack.requester);
    if (!result?.tracks?.length) return false;

    const previousIds = new Set(player.queue.previous.map((item) => item.info.identifier));
    const next = result.tracks.find((item) => !previousIds.has(item.info.identifier));
    if (!next) return false;

    await player.queue.add(next);
    await player.play();
    return true;
  } catch (error) {
    ctx.log.debug("autoplay failed:", error.message);
    return false;
  }
}

/* ---------------------------------------------------------------- filters */

/** Every filter preset, with a one-line description for the help output. */
const FILTER_PRESETS = {
  off: "Clear every filter",
  bass: "Slight bass boost",
  bassboost: "Strong bass boost",
  bassboostextreme: "Extreme bass boost (may distort)",
  pop: "Pop equalizer",
  rock: "Rock equalizer",
  electronic: "Electronic equalizer",
  classical: "Classical equalizer",
  gaming: "Gaming equalizer",
  fullsound: "Fuller, louder sound",
  bettermusic: "Subtle clarity boost",
  nightcore: "Faster + higher pitch",
  vaporwave: "Slower + lower pitch",
  daycore: "Slowed, mellow playback",
  "8d": "Rotating 8D audio",
  rotation: "Rotating audio",
  karaoke: "Vocal reduction",
  vibrato: "Vibrato effect",
  tremolo: "Tremolo effect",
  lowpass: "Muffled / low-pass",
  highpass: "Thin / high-pass",
  treble: "Treble boost",
  distortion: "Distortion effect",
  soft: "Gentle low-pass",
  normalization: "Volume normalization",
};

const FILTER_NAMES = Object.keys(FILTER_PRESETS);

/** A treble-boost EQ curve (bands 0-14, gain -0.25..1.0). */
const TREBLE_BANDS = [
  { band: 0, gain: -0.1 }, { band: 1, gain: -0.05 }, { band: 2, gain: 0 },
  { band: 3, gain: 0.05 }, { band: 4, gain: 0.1 }, { band: 5, gain: 0.15 },
  { band: 6, gain: 0.2 }, { band: 7, gain: 0.25 }, { band: 8, gain: 0.3 },
  { band: 9, gain: 0.3 }, { band: 10, gain: 0.3 }, { band: 11, gain: 0.3 },
  { band: 12, gain: 0.3 }, { band: 13, gain: 0.3 }, { band: 14, gain: 0.3 },
];

/**
 * Applies a named preset. Most Lavalink filters are exclusive, so we always
 * start from a clean slate and re-apply the player volume afterwards.
 */
async function applyFilterPreset(player, preset) {
  const fm = player.filterManager;
  const key = String(preset || "").toLowerCase();
  if (!FILTER_NAMES.includes(key)) {
    fail(`Unknown filter **${truncate(preset, 30)}**. Available: ${FILTER_NAMES.join(", ")}.`);
  }

  await fm.resetFilters();
  await player.setVolume(player.volume);

  try {
    switch (key) {
      case "off":
        break;
      case "bass":
        await fm.setEQPreset("BassboostLow");
        break;
      case "bassboost":
        await fm.setEQPreset("BassboostHigh");
        break;
      case "bassboostextreme":
        await fm.setEQPreset("BassboostEarrape");
        break;
      case "pop":
        await fm.setEQPreset("Pop");
        break;
      case "rock":
        await fm.setEQPreset("Rock");
        break;
      case "electronic":
        await fm.setEQPreset("Electronic");
        break;
      case "classical":
        await fm.setEQPreset("Classic");
        break;
      case "gaming":
        await fm.setEQPreset("Gaming");
        break;
      case "fullsound":
        await fm.setEQPreset("FullSound");
        break;
      case "bettermusic":
        await fm.setEQPreset("BetterMusic");
        break;
      case "treble":
        await fm.setEQ(TREBLE_BANDS);
        break;
      case "nightcore":
        await fm.toggleNightcore();
        break;
      case "vaporwave":
        await fm.toggleVaporwave();
        break;
      case "daycore":
        await fm.setSpeed(0.85);
        await fm.setPitch(0.9);
        await fm.setRate(0.9);
        break;
      case "8d":
      case "rotation":
        await fm.toggleRotation(0.2);
        break;
      case "karaoke":
        await fm.toggleKaraoke();
        break;
      case "vibrato":
        await fm.toggleVibrato();
        break;
      case "tremolo":
        await fm.toggleTremolo();
        break;
      case "lowpass":
        await fm.toggleLowPass();
        break;
      case "soft":
        await fm.toggleLowPass(30);
        break;
      case "highpass":
        await fm.lavalinkLavaDspxPlugin.toggleHighPass();
        break;
      case "normalization":
        await fm.lavalinkLavaDspxPlugin.toggleNormalization();
        break;
      case "distortion":
        fm.data.distortion = {
          sinOffset: 0, sinScale: 1, cosOffset: 0, cosScale: 1,
          tanOffset: 0, tanScale: 1, offset: 0, scale: 1,
        };
        await fm.applyPlayerFilters();
        break;
      default:
        break;
    }
  } catch (error) {
    player.log?.debug?.("filter failed:", error.message);
    fail(`The **${key}** filter needs a Lavalink plugin that this node doesn't have. Try another preset.`);
  }

  pset(player, "filter", key);
  return key;
}

/** Sets playback speed / pitch / rate (timescale). Values are multipliers. */
async function applyTimescale(player, { speed, pitch, rate } = {}) {
  const fm = player.filterManager;
  if (speed !== undefined) await fm.setSpeed(speed);
  if (pitch !== undefined) await fm.setPitch(pitch);
  if (rate !== undefined) await fm.setRate(rate);
  pset(player, "filter", "custom");
  return { speed, pitch, rate };
}

/** Applies a raw equalizer band list. */
async function applyEqualizer(player, bands) {
  await player.filterManager.setEQ(bands);
  pset(player, "filter", "equalizer");
  return bands;
}

/** Deduplicates the upcoming queue in place, returning how many were removed. */
async function dedupeQueue(player) {
  const before = player.queue.tracks.length;
  const unique = dedupeTracks(player.queue.tracks);
  const removed = before - unique.length;
  if (removed > 0) {
    await player.queue.splice(0, before, unique);
  }
  return removed;
}

/* ==========================================================================
 * commands.js
 * ========================================================================== */

/**
 * The command registry — every prefix command lives here.
 *
 * Each command is a plain object:
 *   { name, aliases, category, usage, description, run(ctx, message, args) }
 * `run` may throw UserError for expected, user-facing problems; the dispatcher
 * turns those into a clean embed instead of a stack trace.
 *
 * Slash commands reuse these exact `run` functions through an adapter (see
 * src/slash.js), so there is a single source of truth for behaviour.
 *
 * Styling: dark, minimalist, no decorative emoji. Only a handful of clean
 * monochrome glyphs are used, and only where they aid scanning.
 */

/* ------------------------------------------------------------------ helpers */

const PAGE_SIZE = QUEUE_PAGE_SIZE;

/** Resolves the player and asserts the caller may control it. */
async function controlPlayer(ctx, message) {
  const channel = requireVoiceChannel(message.member);
  const player = requirePlayer(ctx, message.guildId);
  requireSameChannel(player, message.member);
  if (player.voiceChannelId && player.voiceChannelId !== channel.id) {
    fail(`I'm playing in <#${player.voiceChannelId}> — join that channel to control me.`);
  }
  return player;
}

/**
 * Shows the Now Playing card through the single-card poster, so a card already
 * on screen is edited instead of duplicated. Falls back to a direct reply when
 * no channel is reachable (e.g. the offline test harness).
 */
async function replyNowPlaying(ctx, message, player, requesterId) {
  const posted = await postNowPlaying(ctx, player, player.queue.current, requesterId);
  if (posted) return posted;
  const sent = await message.reply(nowPlayingPayload(ctx, player, player.queue.current, requesterId));
  pset(player, "nowPlaying", { messageId: sent.id, channelId: sent.channelId, requesterId });
  return sent;
}

function requireIndex(raw, max, label = "position") {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value) || value < 1 || value > max) {
    fail(`Give me a valid ${label} between **1** and **${max}**.`);
  }
  return value;
}

function splitText(text, size) {
  const chunks = [];
  let remaining = String(text);
  while (remaining.length > size) {
    let cut = remaining.lastIndexOf("\n", size);
    if (cut < size * 0.6) cut = remaining.lastIndexOf(" ", size);
    if (cut <= 0) cut = size;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function fetchFromLrclib(title, artist) {
  try {
    const query = new URLSearchParams({ track_name: title });
    if (artist) query.set("artist_name", artist);
    const response = await fetch(`https://lrclib.net/api/search?${query.toString()}`, {
      headers: { "User-Agent": "Gaana-Discord-Bot/4.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const results = await response.json();
    if (!Array.isArray(results) || !results.length) return null;
    const best = results.find((item) => item.plainLyrics) ?? results[0];
    return best?.plainLyrics || best?.syncedLyrics?.replace(/\[[^\]]+\]/g, "") || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------- interactive search state */

/** token -> { tracks, userId, guildId, createdAt } */
const searchSessions = new Map();
const SEARCH_TTL = 120_000;

function pruneSearchSessions() {
  const now = Date.now();
  for (const [token, session] of searchSessions) {
    if (now - session.createdAt > SEARCH_TTL) searchSessions.delete(token);
  }
}

/* ---------------------------------------------------- queue pager sessions */

/** messageId -> { userId, guildId, page, timeout } */
const queueSessions = new Map();
const QUEUE_TIMEOUT = 120_000;

/** Registers a queue view so its buttons can be driven and later disabled. */
function attachQueuePager(ctx, sent, player, userId, page = 1) {
  const session = { userId, guildId: player.guildId, page, timeout: null };
  queueSessions.set(sent.id, session);

  const arm = () => {
    if (session.timeout) clearTimeout(session.timeout);
    session.timeout = setTimeout(async () => {
      queueSessions.delete(sent.id);
      try {
        const channel = ctx.client.channels.cache.get(sent.channelId);
        const message = await channel?.messages?.fetch(sent.id).catch(() => null);
        if (!message) return;
        const totalPages = Math.max(1, Math.ceil((getPlayer(ctx, session.guildId)?.queue?.tracks?.length ?? 0) / PAGE_SIZE));
        await message.edit({ components: disabledQueuePager(ctx, session.page, totalPages) }).catch(() => {});
      } catch {
        /* the message may have been deleted — nothing to do */
      }
    }, QUEUE_TIMEOUT);
    session.timeout.unref?.();
  };

  arm();
  session.arm = arm;
  return session;
}

/** Handles a queue pager button press (called from the interaction handler). */
async function handleQueueButton(ctx, interaction) {
  const session = queueSessions.get(interaction.message.id);
  if (!session) {
    await interaction.reply({ embeds: [warn(ctx, "This queue view has expired — run the queue command again.")], ephemeral: true });
    return;
  }
  if (interaction.user.id !== session.userId) {
    await interaction.reply({ embeds: [warn(ctx, `Only <@${session.userId}> can use these buttons.`)], ephemeral: true });
    return;
  }

  const player = getPlayer(ctx, interaction.guildId);
  if (!player) {
    await interaction.reply({ embeds: [warn(ctx, "Nothing is playing right now.")], ephemeral: true });
    return;
  }

  const action = interaction.customId.split(":")[2];
  const totalPages = Math.max(1, Math.ceil(player.queue.tracks.length / PAGE_SIZE));
  let page = session.page;
  if (action === "first") page = 1;
  else if (action === "last") page = totalPages;
  else if (action === "prev") page = Math.max(1, page - 1);
  else if (action === "next") page = Math.min(totalPages, page + 1);

  session.page = page;
  session.arm?.();
  await interaction.update(buildQueuePage(ctx, player, page));
}

/** Handles a search-result select menu (called from the interaction handler). */
async function handleSearchSelect(ctx, interaction) {
  const token = interaction.customId.split(":")[2];
  const session = searchSessions.get(token);
  if (!session) {
    await interaction.reply({ embeds: [warn(ctx, "That search has expired — run the search command again.")], ephemeral: true });
    return;
  }
  if (interaction.user.id !== session.userId) {
    await interaction.reply({ embeds: [warn(ctx, `Only <@${session.userId}> can pick from these results.`)], ephemeral: true });
    return;
  }

  const index = Number.parseInt(interaction.values[0], 10);
  const track = session.tracks[index];
  if (!track) {
    await interaction.reply({ embeds: [warn(ctx, "That result is no longer available.")], ephemeral: true });
    return;
  }

  const player = getPlayer(ctx, interaction.guildId);
  if (!player) {
    await interaction.reply({ embeds: [warn(ctx, "I'm not connected to a voice channel any more.")], ephemeral: true });
    return;
  }

  track.requester = interaction.user;
  await player.queue.add(track);
  if (!player.playing && !player.paused) await player.play();
  searchSessions.delete(token);

  await interaction.update({
    embeds: [ok(ctx, `Queued **${truncate(track.info.title, 70)}** — position #${player.queue.tracks.length}.`)],
    components: [],
  });
}

/* ------------------------------------------------------------------ registry */

const commands = new Map();

function register(command) {
  commands.set(command.name, command);
  for (const alias of command.aliases || []) commands.set(alias, command);
}

/* --- playback ------------------------------------------------------------ */

register({
  name: "play",
  aliases: ["p"],
  category: "Playback",
  usage: "play <song name | url>",
  description: "Search and queue a track or playlist, then start playing.",
  async run(ctx, message, args) {
    if (!args.length) fail(`Use \`${ctx.prefix}play <song name or link>\` — for example \`${ctx.prefix}play lofi beats\`.`);

    const voiceChannel = requireVoiceChannel(message.member);
    const player = await getOrCreatePlayer(ctx, message.guild, voiceChannel, message.channel, message.author);
    requireSameChannel(player, message.member);

    // Make sure the node actually confirmed the voice handshake before we queue
    // anything — otherwise the card would show while the bot stays mute.
    if (!(await ensureVoiceConnected(player))) {
      fail(`I couldn't join **${voiceChannel.name}** — the music server didn't confirm the voice connection. Check the Lavalink node and try again.`);
    }

    const query = args.join(" ");
    const result = await search(ctx, player, query, message.author);
    const wasIdle = !player.playing && !player.paused;

    const { added, skipped, playlist } = await enqueue(ctx, player, result, message.author);

    if (wasIdle && player.queue.current) {
      await replyNowPlaying(ctx, message, player, message.author.id);
      return null;
    }

    const embed = card(ctx, {
      color: COLOR.success,
      author: `${ctx.config.botName} • Queue Updated`,
      title: `Added ${added} track${added === 1 ? "" : "s"}`,
      description: playlist
        ? `Playlist **${truncate(playlist, 80)}** queued.`
        : `[${truncate(result.tracks[0].info.title, 70)}](${result.tracks[0].info.uri})`,
      fields: [
        { name: "Position in queue", value: `#${player.queue.tracks.length}`, inline: true },
        { name: "Queue length", value: `${player.queue.tracks.length} tracks`, inline: true },
      ],
      footer: skipped > 0 ? `${ctx.config.botName} • ${skipped} track(s) skipped — queue is full` : null,
    });

    await message.reply({ embeds: [embed] });
    return null;
  },
});

register({
  name: "pause",
  category: "Playback",
  usage: "pause",
  description: "Pause the current track.",
  async run(ctx, message) {
    const player = await controlPlayer(ctx, message);
    if (player.paused) fail("Playback is already paused.");
    await player.pause();
    await message.reply({ embeds: [ok(ctx, `Paused **${truncate(player.queue.current?.info?.title, 60)}**.`)] });
    return null;
  },
});

register({
  name: "resume",
  aliases: ["unpause"],
  category: "Playback",
  usage: "resume",
  description: "Resume playback.",
  async run(ctx, message) {
    const player = await controlPlayer(ctx, message);
    if (!player.paused) fail("Playback isn't paused.");
    await player.resume();
    await message.reply({ embeds: [ok(ctx, "Resumed playback.")] });
    return null;
  },
});

register({
  name: "skip",
  aliases: ["s", "next"],
  category: "Playback",
  usage: "skip [amount]",
  description: "Skip the current track, or several at once.",
  async run(ctx, message, args) {
    const player = await controlPlayer(ctx, message);
    if (!player.queue.current) fail("Nothing is playing right now.");

    const amount = args.length ? requireIndex(args[0], Math.max(1, player.queue.tracks.length), "skip amount") : 1;
    const title = truncate(player.queue.current.info.title, 60);

    if (amount > 1 && player.queue.tracks.length >= amount) {
      // skip(skipTo) takes the 1-based index to land on: skip(amount) drops
      // (amount - 1) upcoming tracks and then skips the current one, so the
      // total skipped is exactly `amount`.
      await player.skip(amount);
    } else if (player.queue.tracks.length) {
      await player.skip();
    } else {
      await player.stopPlaying(false, false);
      await clearNowPlaying(ctx, player);
    }

    await message.reply({ embeds: [ok(ctx, `Skipped **${title}**.`)] });
    return null;
  },
});

register({
  name: "previous",
  aliases: ["prev", "back"],
  category: "Playback",
  usage: "previous",
  description: "Play the previous track again.",
  async run(ctx, message) {
    const player = await controlPlayer(ctx, message);
    const previous = await player.queue.shiftPrevious();
    if (!previous) fail("There's no previous track in this session.");
    await player.play({ clientTrack: previous });
    await message.reply({ embeds: [ok(ctx, `Replaying **${truncate(previous.info.title, 60)}**.`)] });
    return null;
  },
});

register({
  name: "replay",
  category: "Playback",
  usage: "replay",
  description: "Restart the current track from the beginning.",
  async run(ctx, message) {
    const player = await controlPlayer(ctx, message);
    const track = requireCurrentTrack(player);
    await player.seek(0);
    await message.reply({ embeds: [ok(ctx, `Replaying **${truncate(track.info.title, 60)}** from the start.`)] });
    return null;
  },
});

register({
  name: "stop",
  category: "Playback",
  usage: "stop",
  description: "Stop playback and clear the queue.",
  async run(ctx, message) {
    const player = await controlPlayer(ctx, message);
    const stay = is247(ctx, message.guildId);
    await player.stopPlaying(true, false);
    await clearNowPlaying(ctx, player);

    if (!stay) {
      await player.destroy();
      await message.reply({ embeds: [ok(ctx, "Stopped playback, cleared the queue and left the channel.")] });
    } else {
      await message.reply({ embeds: [ok(ctx, "Stopped playback and cleared the queue. Staying connected (24/7).")] });
    }
    return null;
  },
});

register({
  name: "disconnect",
  aliases: ["dc", "leave"],
  category: "Playback",
  usage: "disconnect",
  description: "Disconnect the bot from the voice channel.",
  async run(ctx, message) {
    const player = requirePlayer(ctx, message.guildId);
    requireSameChannel(player, message.member);
    ctx.stores.stay247.set(message.guildId, false);
    await clearNowPlaying(ctx, player);
    await player.destroy();
    await message.reply({ embeds: [ok(ctx, "Disconnected and cleared the player. 24/7 mode has been switched off.")] });
    return null;
  },
});

/* --- queue management ---------------------------------------------------- */

register({
  name: "queue",
  aliases: ["q", "list"],
  category: "Queue",
  usage: "queue [page]",
  description: "Show the queue with interactive page buttons.",
  async run(ctx, message, args) {
    const player = requirePlayer(ctx, message.guildId);
    const tracks = player.queue.tracks;
    const current = player.queue.current;

    if (!current && !tracks.length) fail("The queue is empty. Add something with **play**.");

    const page = Math.max(1, Number.parseInt(args[0] ?? "1", 10) || 1);
    const payload = buildQueuePage(ctx, player, page);
    const sent = await message.reply(payload);
    attachQueuePager(ctx, sent, player, message.author.id, payload.page);
    return null;
  },
});

register({
  name: "nowplaying",
  aliases: ["np", "current", "song"],
  category: "Queue",
  usage: "nowplaying",
  description: "Show the compact Now Playing card.",
  async run(ctx, message) {
    const player = requirePlayer(ctx, message.guildId);
    const track = requireCurrentTrack(player);
    // Route through the single-card poster: if a card is already live it is
    // refreshed in place, so `?np` never leaves a second card behind.
    const posted = await postNowPlaying(ctx, player, track, track.requester?.id ?? null);
    if (!posted) {
      const { embeds, components } = nowPlayingPayload(ctx, player, track, track.requester?.id ?? null);
      await message.reply({ embeds, components });
    }
    return null;
  },
});

register({
  name: "loop",
  aliases: ["repeat", "l"],
  category: "Queue",
  usage: "loop [off | track | queue]",
  description: "Cycle or set the repeat mode.",
  async run(ctx, message, args) {
    const player = await controlPlayer(ctx, message);
    const requested = String(args[0] ?? "").toLowerCase();
    const cycle = { off: "track", track: "queue", queue: "off" };
    const next = ["off", "track", "queue"].includes(requested) ? requested : cycle[player.repeatMode] ?? "track";

    await player.setRepeatMode(next);
    const label =
      next === "track"
        ? "repeating the current track"
        : next === "queue"
          ? "repeating the whole queue"
          : "loop disabled";
    await message.reply({ embeds: [ok(ctx, `Loop mode: **${next}** — ${label}.`)] });
    return null;
  },
});

register({
  name: "shuffle",
  aliases: ["sh"],
  category: "Queue",
  usage: "shuffle",
  description: "Shuffle the upcoming queue.",
  async run(ctx, message) {
    const player = await controlPlayer(ctx, message);
    if (player.queue.tracks.length < 2) fail("I need at least two queued tracks to shuffle.");
    const count = await player.queue.shuffle();
    await message.reply({ embeds: [ok(ctx, `Shuffled **${count}** tracks.`)] });
    return null;
  },
});

register({
  name: "remove",
  aliases: ["rm", "delete"],
  category: "Queue",
  usage: "remove <position>",
  description: "Remove one track from the queue by position.",
  async run(ctx, message, args) {
    const player = await controlPlayer(ctx, message);
    if (!player.queue.tracks.length) fail("The queue is empty.");
    const index = requireIndex(args[0], player.queue.tracks.length);
    // queue.splice() is async. NOTE: lavalink-client returns the track ITSELF
    // (not a one-element array) when exactly one track is removed, so normalise
    // before reading it.
    const spliced = await player.queue.splice(index - 1, 1);
    const removed = Array.isArray(spliced) ? spliced[0] : spliced;
    await message.reply({
      embeds: [ok(ctx, `Removed **${truncate(removed?.info?.title ?? "track", 60)}** from position #${index}.`)],
    });
    return null;
  },
});

register({
  name: "removerange",
  aliases: ["rr"],
  category: "Queue",
  usage: "removerange <from> <to>",
  description: "Remove a range of queued tracks.",
  async run(ctx, message, args) {
    const player = await controlPlayer(ctx, message);
    const max = player.queue.tracks.length;
    if (!max) fail("The queue is empty.");
    const from = requireIndex(args[0], max, "from position");
    const to = requireIndex(args[1], max, "to position");
    if (to < from) fail("The **to** position must be greater than or equal to **from**.");
    const spliced = await player.queue.splice(from - 1, to - from + 1);
    // A single removal comes back as the track itself, not an array.
    const removed = Array.isArray(spliced) ? spliced : [spliced].filter(Boolean);
    await message.reply({ embeds: [ok(ctx, `Removed **${removed.length}** track${removed.length === 1 ? "" : "s"} (#${from}–#${to}).`)] });
    return null;
  },
});

register({
  name: "move",
  aliases: ["mv"],
  category: "Queue",
  usage: "move <from> <to>",
  description: "Move a queued track to a different position.",
  async run(ctx, message, args) {
    const player = await controlPlayer(ctx, message);
    const max = player.queue.tracks.length;
    if (max < 2) fail("I need at least two queued tracks to move one.");
    const from = requireIndex(args[0], max, "from position");
    const to = requireIndex(args[1], max, "to position");
    if (from === to) fail("Those are the same position.");

    // A single removal comes back as the track itself, not an array —
    // destructuring it directly would throw "not iterable".
    const spliced = await player.queue.splice(from - 1, 1);
    const track = Array.isArray(spliced) ? spliced[0] : spliced;
    if (!track) fail("That track is no longer in the queue.");
    await player.queue.add(track, to - 1);
    await message.reply({ embeds: [ok(ctx, `Moved **${truncate(track.info.title, 50)}** from #${from} to #${to}.`)] });
    return null;
  },
});

register({
  name: "jump",
  aliases: ["skipto", "j"],
  category: "Queue",
  usage: "jump <position>",
  description: "Skip straight to a queued track.",
  async run(ctx, message, args) {
    const player = await controlPlayer(ctx, message);
    const max = player.queue.tracks.length;
    if (!max) fail("There's nothing queued to jump to.");
    const index = requireIndex(args[0], max);
    const target = player.queue.tracks[index - 1];
    await player.skip(index);
    await message.reply({ embeds: [ok(ctx, `Jumped to **${truncate(target.info.title, 60)}**.`)] });
    return null;
  },
});

register({
  name: "clear",
  aliases: ["clearqueue", "cq"],
  category: "Queue",
  usage: "clear",
  description: "Clear every upcoming track (keeps the current one playing).",
  async run(ctx, message) {
    const player = await controlPlayer(ctx, message);
    const count = player.queue.tracks.length;
    if (!count) fail("The queue is already empty.");
    await player.queue.splice(0, count);
    await message.reply({ embeds: [ok(ctx, `Cleared **${count}** queued track${count === 1 ? "" : "s"}.`)] });
    return null;
  },
});

register({
  name: "dedupe",
  aliases: ["dedup", "unique"],
  category: "Queue",
  usage: "dedupe",
  description: "Remove duplicate tracks from the queue.",
  async run(ctx, message) {
    const player = await controlPlayer(ctx, message);
    if (player.queue.tracks.length < 2) fail("I need at least two queued tracks to dedupe.");
    const removed = await dedupeQueue(player);
    if (!removed) fail("No duplicates found — the queue is already clean.");
    await message.reply({ embeds: [ok(ctx, `Removed **${removed}** duplicate track${removed === 1 ? "" : "s"}.`)] });
    return null;
  },
});

register({
  name: "sort",
  aliases: ["order"],
  category: "Queue",
  usage: "sort <title | duration | author> [asc | desc]",
  description: "Sort the upcoming queue.",
  async run(ctx, message, args) {
    const player = await controlPlayer(ctx, message);
    const max = player.queue.tracks.length;
    if (max < 2) fail("I need at least two queued tracks to sort.");

    const by = String(args[0] ?? "title").toLowerCase();
    if (!["title", "duration", "author"].includes(by)) fail("Sort by **title**, **duration** or **author**.");
    const order = String(args[1] ?? "asc").toLowerCase() === "desc" ? "desc" : "asc";

    const sorted = sortTracks(player.queue.tracks, by, order);
    await player.queue.splice(0, max, sorted);
    await message.reply({ embeds: [ok(ctx, `Sorted **${max}** tracks by **${by}** (${order}).`)] });
    return null;
  },
});

register({
  name: "autoplay",
  aliases: ["ap"],
  category: "Queue",
  usage: "autoplay",
  description: "Toggle autoplay of similar tracks when the queue runs out.",
  async run(ctx, message) {
    const player = requirePlayer(ctx, message.guildId);
    const next = !pget(player, "autoplay");
    pset(player, "autoplay", next);
    await message.reply({
      embeds: [
        next
          ? ok(ctx, "Autoplay **enabled** — I'll keep the music going with similar tracks.")
          : ok(ctx, "Autoplay **disabled** — playback stops when the queue ends."),
      ],
    });
    return null;
  },
});

register({
  name: "queuesave",
  aliases: ["qsave"],
  category: "Queue",
  usage: "queuesave [name]",
  description: "Save the current queue so it can be restored later.",
  async run(ctx, message, args) {
    const player = requirePlayer(ctx, message.guildId);
    const tracks = [player.queue.current, ...player.queue.tracks].filter(Boolean);
    if (!tracks.length) fail("There's nothing to save.");

    const name = truncate(String(args.join(" ") || "default").trim(), 40);
    const saved = ctx.stores.queuesaves.get(message.guildId, {});
    saved[name] = {
      at: Date.now(),
      tracks: tracks.map((track) => ({
        title: track.info.title,
        uri: track.info.uri,
        author: track.info.author,
        duration: track.info.duration,
      })),
    };
    ctx.stores.queuesaves.set(message.guildId, saved);
    await message.reply({ embeds: [ok(ctx, `Saved **${tracks.length}** tracks as \`${name}\`. Restore with \`${ctx.prefix}queuerestore ${name}\`.`)] });
    return null;
  },
});

register({
  name: "queuerestore",
  aliases: ["qrestore"],
  category: "Queue",
  usage: "queuerestore [name]",
  description: "Restore a previously saved queue.",
  async run(ctx, message, args) {
    const saved = ctx.stores.queuesaves.get(message.guildId, {});
    const name = truncate(String(args.join(" ") || "default").trim(), 40);
    const entry = saved[name];
    if (!entry?.tracks?.length) fail(`No saved queue called \`${name}\`. Save one with \`${ctx.prefix}queuesave ${name}\`.`);

    const voiceChannel = requireVoiceChannel(message.member);
    const player = await getOrCreatePlayer(ctx, message.guild, voiceChannel, message.channel, message.author);

    let added = 0;
    for (const item of entry.tracks) {
      try {
        const result = await player.search({ query: item.uri, source: ctx.config.defaultSearchSource }, message.author);
        if (result?.tracks?.length) {
          result.tracks[0].requester = message.author;
          await player.queue.add(result.tracks[0]);
          added += 1;
        }
      } catch {
        /* skip a track the node can't resolve */
      }
    }

    if (!added) fail("None of the saved tracks could be resolved right now.");
    if (!player.playing && !player.paused) await player.play();
    await message.reply({ embeds: [ok(ctx, `Restored **${added}** tracks from \`${name}\`.`)] });
    return null;
  },
});

/* --- audio --------------------------------------------------------------- */

register({
  name: "seek",
  aliases: ["ss"],
  category: "Audio",
  usage: "seek <mm:ss | seconds>",
  description: "Jump to a timestamp in the current track.",
  async run(ctx, message, args) {
    const player = await controlPlayer(ctx, message);
    const track = requireCurrentTrack(player);
    if (track.info.isStream) fail("Live streams can't be seeked.");

    const target = parseTimestamp(args[0]);
    if (target === null) fail(`Give me a timestamp like \`1:23\` or \`83\` — e.g. \`${ctx.prefix}seek 1:23\`.`);
    if (target >= track.info.duration) fail(`That's past the end of the track (${clock(track.info.duration)}).`);

    await player.seek(target);
    await message.reply({ embeds: [ok(ctx, `Seeked to **${clock(target)}** / ${clock(track.info.duration)}.`)] });
    return null;
  },
});

register({
  name: "forward",
  aliases: ["ff"],
  category: "Audio",
  usage: "forward [seconds]",
  description: "Skip forward in the current track.",
  async run(ctx, message, args) {
    const player = await controlPlayer(ctx, message);
    const track = requireCurrentTrack(player);
    if (track.info.isStream) fail("Live streams can't be seeked.");
    const delta = (Number.parseInt(args[0] ?? "10", 10) || 10) * 1000;
    const target = Math.min(track.info.duration, player.position + delta);
    await player.seek(target);
    await message.reply({ embeds: [ok(ctx, `Forward to **${clock(target)}**.`)] });
    return null;
  },
});

register({
  name: "rewind",
  aliases: ["rw"],
  category: "Audio",
  usage: "rewind [seconds]",
  description: "Go back in the current track.",
  async run(ctx, message, args) {
    const player = await controlPlayer(ctx, message);
    requireCurrentTrack(player);
    const delta = (Number.parseInt(args[0] ?? "10", 10) || 10) * 1000;
    const target = Math.max(0, player.position - delta);
    await player.seek(target);
    await message.reply({ embeds: [ok(ctx, `Rewound to **${clock(target)}**.`)] });
    return null;
  },
});

register({
  name: "volume",
  aliases: ["vol", "v"],
  category: "Audio",
  usage: "volume [0-100]",
  description: "Show or set the playback volume.",
  async run(ctx, message, args) {
    const player = await controlPlayer(ctx, message);

    if (!args.length) {
      await message.reply({ embeds: [info(ctx, `Volume is **${player.volume}%** (max ${ctx.config.maxVolume}%).`)] });
      return null;
    }

    const value = Number.parseInt(String(args[0]).replace("%", ""), 10);
    if (!Number.isFinite(value)) fail("Volume must be a number between 0 and 100.");

    const capped = Math.min(ctx.config.maxVolume, Math.max(0, value));
    await player.setVolume(capped);
    const note = capped !== value ? `\nCapped at the server maximum of **${ctx.config.maxVolume}%**.` : "";
    await message.reply({
      embeds: [
        capped === 0
          ? warn(ctx, "Volume set to **0%** — muted.")
          : ok(ctx, `Volume set to **${capped}%**.${note}`),
      ],
    });
    return null;
  },
});

register({
  name: "speed",
  category: "Audio",
  usage: "speed <0.5-2.0>",
  description: "Change the playback speed.",
  async run(ctx, message, args) {
    const player = await controlPlayer(ctx, message);
    requireCurrentTrack(player);
    const value = Number(args[0]);
    if (!Number.isFinite(value) || value < 0.5 || value > 2) fail("Give me a speed between **0.5** and **2.0**.");
    await applyTimescale(player, { speed: value });
    await message.reply({ embeds: [ok(ctx, `Speed set to **${value}x**.`)] });
    return null;
  },
});

register({
  name: "pitch",
  category: "Audio",
  usage: "pitch <0.5-2.0>",
  description: "Change the playback pitch.",
  async run(ctx, message, args) {
    const player = await controlPlayer(ctx, message);
    requireCurrentTrack(player);
    const value = Number(args[0]);
    if (!Number.isFinite(value) || value < 0.5 || value > 2) fail("Give me a pitch between **0.5** and **2.0**.");
    await applyTimescale(player, { pitch: value });
    await message.reply({ embeds: [ok(ctx, `Pitch set to **${value}x**.`)] });
    return null;
  },
});

register({
  name: "rate",
  category: "Audio",
  usage: "rate <0.5-2.0>",
  description: "Change the playback rate.",
  async run(ctx, message, args) {
    const player = await controlPlayer(ctx, message);
    requireCurrentTrack(player);
    const value = Number(args[0]);
    if (!Number.isFinite(value) || value < 0.5 || value > 2) fail("Give me a rate between **0.5** and **2.0**.");
    await applyTimescale(player, { rate: value });
    await message.reply({ embeds: [ok(ctx, `Rate set to **${value}x**.`)] });
    return null;
  },
});

register({
  name: "equalizer",
  aliases: ["eq"],
  category: "Audio",
  usage: "equalizer <preset | band gain | off>",
  description: "Apply an equalizer preset, or set one band's gain.",
  async run(ctx, message, args) {
    const player = await controlPlayer(ctx, message);
    requireCurrentTrack(player);

    if (!args.length) {
      await message.reply({
        embeds: [
          info(
            ctx,
            `**Equalizer presets**\n\`\`\`\nbass, bassboost, bassboostextreme, pop, rock,\nelectronic, classical, gaming, fullsound,\nbettermusic, treble, off\n\`\`\`\n` +
              `Or set a single band: \`${ctx.prefix}equalizer <0-14> <gain -0.25..1.0>\`.`
          ),
        ],
      });
      return null;
    }

    const first = String(args[0]).toLowerCase();
    if (first === "off") {
      await applyFilterPreset(player, "off");
      await message.reply({ embeds: [ok(ctx, "Equalizer cleared.")] });
      return null;
    }

    // Single-band mode: "equalizer 5 0.3"
    if (/^\d+$/.test(first) && args.length >= 2) {
      const band = Number.parseInt(first, 10);
      const gain = clamp(args[1], -0.25, 1, NaN);
      if (band < 0 || band > 14) fail("Band must be between **0** and **14**.");
      if (!Number.isFinite(gain)) fail("Gain must be between **-0.25** and **1.0**.");
      await applyEqualizer(player, [{ band, gain }]);
      await message.reply({ embeds: [ok(ctx, `Band **${band}** set to gain **${gain}**.`)] });
      return null;
    }

    const applied = await applyFilterPreset(player, first);
    await message.reply({ embeds: [ok(ctx, `Applied **${applied}** equalizer.`)] });
    return null;
  },
});

register({
  name: "filter",
  aliases: ["filters", "fx"],
  category: "Filters",
  usage: "filter [preset]",
  description: "Apply an audio filter preset, or list them.",
  async run(ctx, message, args) {
    const player = await controlPlayer(ctx, message);

    if (!args.length) {
      const active = pget(player, "filter") || "off";
      const lines = FILTER_NAMES.map((name) => `\`${name.padEnd(18)}\` ${FILTER_PRESETS[name]}`);
      const chunks = splitText(lines.join("\n"), 3800);
      const embed = card(ctx, {
        color: COLOR.accent,
        author: `${ctx.config.botName} • Filters`,
        title: `Active: ${active}`,
        description: chunks[0],
        footer: `${ctx.config.botName} • ${FILTER_NAMES.length} presets`,
      });
      await message.reply({ embeds: [embed] });
      for (const extra of chunks.slice(1, 2)) await message.channel.send({ embeds: [card(ctx, { description: extra })] });
      return null;
    }

    const applied = await applyFilterPreset(player, args[0]);
    await message.reply({
      embeds: [applied === "off" ? ok(ctx, "Filters cleared.") : ok(ctx, `Applied **${applied}** preset.`)],
    });
    return null;
  },
});

register({
  name: "lyrics",
  aliases: ["ly"],
  category: "Audio",
  usage: "lyrics [query]",
  description: "Fetch lyrics for the current track (or a search).",
  async run(ctx, message, args) {
    let title;
    let author;

    if (args.length) {
      title = args.join(" ");
    } else {
      const player = requirePlayer(ctx, message.guildId);
      const track = requireCurrentTrack(player);
      title = track.info.title;
      author = track.info.author;
    }

    await message.channel.sendTyping?.();

    let text = null;
    if (!args.length) {
      try {
        const player = getPlayer(ctx, message.guildId);
        const result = await player?.getCurrentLyrics();
        if (result?.text) text = result.text;
        if (!text && result?.lines?.length) text = result.lines.map((line) => line.line).join("\n");
      } catch {
        /* the lyrics plugin may not be installed — fall back below */
      }
    }

    if (!text) text = await fetchFromLrclib(title, author);

    if (!text) {
      await message.reply({ embeds: [warn(ctx, `I couldn't find lyrics for **${truncate(title, 70)}**.`)] });
      return null;
    }

    const chunks = splitText(text.trim(), 3800);
    const embed = card(ctx, {
      color: COLOR.accent,
      author: `${ctx.config.botName} • Lyrics`,
      title: truncate(title, 90),
      description: chunks[0],
    });

    await message.reply({ embeds: [embed] });
    for (const extra of chunks.slice(1, 3)) await message.channel.send({ embeds: [card(ctx, { description: extra })] });
    return null;
  },
});

/* --- favorites ----------------------------------------------------------- */

function favoritesOf(ctx, userId) {
  const list = ctx.stores.favorites.get(userId, []);
  return Array.isArray(list) ? list : [];
}

function addFavorite(ctx, userId, track) {
  const list = favoritesOf(ctx, userId);
  if (list.some((item) => item.uri === track.info.uri)) return false;
  list.push({ title: track.info.title, uri: track.info.uri, author: track.info.author, duration: track.info.duration });
  ctx.stores.favorites.set(userId, list.slice(-200));
  return true;
}

register({
  name: "like",
  // NOTE: "grab" is deliberately NOT an alias here — it is its own command
  // (DM the current track). Sharing the name would make one shadow the other.
  aliases: ["save", "bookmark"],
  category: "Favorites",
  usage: "like",
  description: "Save the current track to your favorites.",
  async run(ctx, message) {
    const player = requirePlayer(ctx, message.guildId);
    const track = requireCurrentTrack(player);
    const added = addFavorite(ctx, message.author.id, track);
    await message.reply({
      embeds: [
        added
          ? ok(ctx, `Saved **${truncate(track.info.title, 60)}** to your favorites.`)
          : warn(ctx, "That track is already in your favorites."),
      ],
    });
    return null;
  },
});

register({
  name: "likeall",
  aliases: ["saveall"],
  category: "Favorites",
  usage: "likeall",
  description: "Save the current track and the whole queue to your favorites.",
  async run(ctx, message) {
    const player = requirePlayer(ctx, message.guildId);
    let count = 0;
    if (player.queue.current && addFavorite(ctx, message.author.id, player.queue.current)) count += 1;
    for (const track of player.queue.tracks) if (addFavorite(ctx, message.author.id, track)) count += 1;
    if (!count) fail("Everything playing is already in your favorites.");
    await message.reply({ embeds: [ok(ctx, `Added **${count}** track${count === 1 ? "" : "s"} to your favorites.`)] });
    return null;
  },
});

register({
  name: "favorites",
  aliases: ["favs", "showliked", "liked"],
  category: "Favorites",
  usage: "favorites",
  description: "List your saved tracks.",
  async run(ctx, message) {
    const list = favoritesOf(ctx, message.author.id);
    if (!list.length) fail(`You haven't saved anything yet — use \`${ctx.prefix}like\` while a track is playing.`);

    const max = 15;
    const lines = list
      .slice(-max)
      .reverse()
      .map((item, index) => `\`${String(index + 1).padStart(2, "0")}\`  [${truncate(item.title, 55)}](${item.uri})  \`${clock(item.duration)}\`  — ${truncate(item.author, 30)}`);

    const embed = card(ctx, {
      color: COLOR.accent,
      author: `${ctx.config.botName} • Favorites`,
      title: `${truncate(message.author.username, 40)}'s saved tracks`,
      description: lines.join("\n"),
      footer: `${ctx.config.botName} • ${list.length} saved • play them with ${ctx.prefix}playfavorites`,
    });

    await message.reply({ embeds: [embed] });
    return null;
  },
});

register({
  name: "playfavorites",
  aliases: ["playfavs", "playliked"],
  category: "Favorites",
  usage: "playfavorites [count]",
  description: "Queue your saved tracks.",
  async run(ctx, message, args) {
    const list = favoritesOf(ctx, message.author.id);
    if (!list.length) fail("You have no saved tracks yet.");

    const limit = Math.min(list.length, Math.max(1, Number.parseInt(args[0] ?? "10", 10) || 10));
    const voiceChannel = requireVoiceChannel(message.member);
    const player = await getOrCreatePlayer(ctx, message.guild, voiceChannel, message.channel, message.author);

    let added = 0;
    for (const item of list.slice(-limit).reverse()) {
      try {
        const result = await player.search({ query: item.uri, source: ctx.config.defaultSearchSource }, message.author);
        if (result?.tracks?.length) {
          result.tracks[0].requester = message.author;
          await player.queue.add(result.tracks[0]);
          added += 1;
        }
      } catch {
        /* skip a track the server can't resolve */
      }
    }

    if (!added) fail("None of your saved tracks could be resolved right now.");
    if (!player.playing && !player.paused) await player.play();

    await message.reply({ embeds: [ok(ctx, `Queued **${added}** of your favorites.`)] });
    return null;
  },
});

register({
  name: "unlike",
  aliases: ["clearfavorites", "clearfavs"],
  category: "Favorites",
  usage: "unlike",
  description: "Clear your favorites list.",
  async run(ctx, message) {
    const list = favoritesOf(ctx, message.author.id);
    if (!list.length) fail("Your favorites list is already empty.");
    ctx.stores.favorites.delete(message.author.id);
    await message.reply({ embeds: [ok(ctx, `Cleared **${list.length}** saved track${list.length === 1 ? "" : "s"}.`)] });
    return null;
  },
});

/* --- playlists ----------------------------------------------------------- */

function playlistsOf(ctx, userId) {
  const data = ctx.stores.playlists.get(userId, {});
  return data && typeof data === "object" ? data : {};
}

register({
  name: "playlist",
  aliases: ["pl"],
  category: "Playlist",
  usage: "playlist <save|load|delete|list|show> [name]",
  description: "Save, load, list and manage your personal playlists.",
  async run(ctx, message, args) {
    const sub = String(args[0] ?? "").toLowerCase();
    const name = truncate(String(args.slice(1).join(" ") || "").trim(), 40);
    const all = playlistsOf(ctx, message.author.id);

    if (!sub || sub === "list") {
      const names = Object.keys(all);
      if (!names.length) fail(`You have no playlists yet — save one with \`${ctx.prefix}playlist save <name>\`.`);
      const lines = names.map((key) => `**${truncate(key, 40)}** — ${all[key].tracks.length} tracks`);
      await message.reply({
        embeds: [
          card(ctx, {
            color: COLOR.accent,
            author: `${ctx.config.botName} • Playlists`,
            title: "Your playlists",
            description: lines.join("\n"),
            footer: `${ctx.config.botName} • ${names.length} playlist${names.length === 1 ? "" : "s"}`,
          }),
        ],
      });
      return null;
    }

    if (sub === "save") {
      if (!name) fail(`Give the playlist a name: \`${ctx.prefix}playlist save <name>\`.`);
      const player = requirePlayer(ctx, message.guildId);
      const tracks = [player.queue.current, ...player.queue.tracks].filter(Boolean);
      if (!tracks.length) fail("There's nothing playing to save.");
      all[name] = {
        at: Date.now(),
        tracks: tracks.map((track) => ({
          title: track.info.title,
          uri: track.info.uri,
          author: track.info.author,
          duration: track.info.duration,
        })),
      };
      ctx.stores.playlists.set(message.author.id, all);
      await message.reply({ embeds: [ok(ctx, `Saved **${tracks.length}** tracks to playlist \`${name}\`.`)] });
      return null;
    }

    if (sub === "load" || sub === "play") {
      if (!name) fail(`Which playlist? \`${ctx.prefix}playlist load <name>\`.`);
      const entry = all[name];
      if (!entry?.tracks?.length) fail(`No playlist called \`${name}\`.`);
      const voiceChannel = requireVoiceChannel(message.member);
      const player = await getOrCreatePlayer(ctx, message.guild, voiceChannel, message.channel, message.author);
      let added = 0;
      for (const item of entry.tracks) {
        try {
          const result = await player.search({ query: item.uri, source: ctx.config.defaultSearchSource }, message.author);
          if (result?.tracks?.length) {
            result.tracks[0].requester = message.author;
            await player.queue.add(result.tracks[0]);
            added += 1;
          }
        } catch {
          /* skip unresolvable */
        }
      }
      if (!added) fail("None of the playlist's tracks could be resolved right now.");
      if (!player.playing && !player.paused) await player.play();
      await message.reply({ embeds: [ok(ctx, `Loaded **${added}** tracks from \`${name}\`.`)] });
      return null;
    }

    if (sub === "show") {
      if (!name) fail(`Which playlist? \`${ctx.prefix}playlist show <name>\`.`);
      const entry = all[name];
      if (!entry?.tracks?.length) fail(`No playlist called \`${name}\`.`);
      const lines = entry.tracks
        .slice(0, 20)
        .map((item, index) => `\`${String(index + 1).padStart(2, "0")}\`  [${truncate(item.title, 55)}](${item.uri})  \`${clock(item.duration)}\``);
      await message.reply({
        embeds: [
          card(ctx, {
            color: COLOR.accent,
            author: `${ctx.config.botName} • Playlist`,
            title: truncate(name, 60),
            description: lines.join("\n"),
            footer: `${ctx.config.botName} • ${entry.tracks.length} tracks`,
          }),
        ],
      });
      return null;
    }

    if (sub === "delete" || sub === "remove") {
      if (!name) fail(`Which playlist? \`${ctx.prefix}playlist delete <name>\`.`);
      if (!all[name]) fail(`No playlist called \`${name}\`.`);
      delete all[name];
      ctx.stores.playlists.set(message.author.id, all);
      await message.reply({ embeds: [ok(ctx, `Deleted playlist \`${name}\`.`)] });
      return null;
    }

    fail(`Unknown subcommand **${truncate(sub, 20)}**. Use \`save\`, \`load\`, \`show\`, \`list\` or \`delete\`.`);
  },
});

/* --- settings ------------------------------------------------------------ */

register({
  name: "247",
  aliases: ["stay", "24-7"],
  category: "Settings",
  usage: "247",
  description: "Toggle 24/7 mode — stay in voice when the queue empties.",
  async run(ctx, message) {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      fail("You need the **Manage Server** permission to toggle 24/7 mode.");
    }

    const enabled = !is247(ctx, message.guildId);
    ctx.stores.stay247.set(message.guildId, enabled);

    if (enabled) {
      const channel = message.member.voice?.channel;
      if (channel) {
        const player = await getOrCreatePlayer(ctx, message.guild, channel, message.channel, message.author);
        pset(player, "stay247", true);
      }
      await message.reply({ embeds: [ok(ctx, "24/7 mode **enabled** — I'll stay connected even when the queue is empty.")] });
    } else {
      await message.reply({ embeds: [ok(ctx, "24/7 mode **disabled** — I'll leave when the queue ends.")] });
    }
    return null;
  },
});

register({
  name: "prefix",
  category: "Settings",
  usage: "prefix [new prefix]",
  description: "Show or change this server's command prefix.",
  async run(ctx, message, args) {
    if (!args.length) {
      await message.reply({
        embeds: [info(ctx, `This server's prefix is \`${ctx.prefixFor(message.guildId)}\`.\nChange it with \`${ctx.prefixFor(message.guildId)}prefix <new prefix>\`.`)],
      });
      return null;
    }
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      fail("You need the **Manage Server** permission to change the prefix.");
    }
    const next = String(args[0]).trim();
    if (next.length > 3) fail("Keep the prefix to 3 characters or fewer.");
    if (/\s/.test(next)) fail("The prefix can't contain spaces.");

    ctx.setPrefix(message.guildId, next);
    await message.reply({ embeds: [ok(ctx, `Prefix updated to \`${next}\`. Try \`${next}help\`.`)] });
    return null;
  },
});

register({
  name: "join",
  aliases: ["summon"],
  category: "Settings",
  usage: "join",
  description: "Make the bot join your voice channel without playing.",
  async run(ctx, message) {
    const channel = requireVoiceChannel(message.member);
    await getOrCreatePlayer(ctx, message.guild, channel, message.channel, message.author);
    await message.reply({ embeds: [ok(ctx, `Joined **${channel.name}**.`)] });
    return null;
  },
});

/* --- presence ------------------------------------------------------------ */

/* ------------------------------------------------------- presence control */

/**
 * Manual presence override. While set, the rotating status is paused so the
 * user's choice sticks; `clear` removes it and rotation resumes. This is the
 * bot's OWN presence (client.user.setPresence) — never a user account.
 *
 * The client and the rotation function live inside boot(); these hooks are
 * wired up there so the commands (module scope) can drive them without
 * reaching into boot's scope.
 */
let presenceOverride = null; // { type, key, text, url } | null
let rotationPaused = false;
const presenceHooks = {
  setPresence: () => {},
  rotate: () => {},
  isOwner: () => false,
};

/** Validates + normalises a presence request. Throws UserError on bad input. */
function normalizePresence({ type, text, url }, ctx) {
  const key = String(type ?? "").toLowerCase();
  if (!PRESENCE_TYPE_KEYS.includes(key)) {
    fail(`Unknown activity type **${truncate(type, 20)}**. Pick one of: ${PRESENCE_TYPE_KEYS.map((k) => `\`${k}\``).join(", ")}.`);
  }
  const clean = String(text ?? "").trim();
  if (!clean) fail("Give me some text for the status.");
  if (clean.length > ACTIVITY_MAX) {
    fail(`Keep the status to ${ACTIVITY_MAX} characters or fewer (you sent ${clean.length}).`);
  }
  let streamUrl = null;
  if (key === "streaming") {
    const fallbackUrl = ctx?.config?.presence?.defaultStreamUrl ?? "https://www.twitch.tv/gaana";
    streamUrl = String(url ?? "").trim() || fallbackUrl;
    if (!isHttpUrl(streamUrl)) fail("A streaming status needs a valid http(s) URL (Twitch or YouTube).");
  }
  return { type: PRESENCE_TYPES[key], key, text: clean, url: streamUrl };
}

/** Applies a presence to the bot's own client and pauses rotation. */
function applyPresence(presence) {
  presenceOverride = presence;
  rotationPaused = true;
  const activity = { name: presence.text, type: presence.type };
  if (presence.type === ActivityType.Streaming) activity.url = presence.url;
  if (presence.type === ActivityType.Custom) activity.state = presence.text;
  presenceHooks.setPresence({ activities: [activity], status: "online" });
  return presence;
}

/** Clears the manual presence and resumes the rotating status. */
function clearPresence() {
  presenceOverride = null;
  rotationPaused = false;
  presenceHooks.rotate();
}

/** Human-readable description of the current manual presence, or null. */
function describePresence() {
  if (!presenceOverride) return null;
  const label = presenceOverride.key.charAt(0).toUpperCase() + presenceOverride.key.slice(1);
  return { label, key: presenceOverride.key, text: presenceOverride.text, url: presenceOverride.url };
}

/** Only server managers or configured developers may change the bot presence. */
function requirePresencePermission(message) {
  const member = message?.member;
  const allowed =
    presenceHooks.isOwner(message?.author?.id) ||
    member?.permissions?.has?.(PermissionFlagsBits.ManageGuild) ||
    member?.permissions?.has?.(PermissionFlagsBits.Administrator);
  if (!allowed) {
    fail("You need the **Manage Server** permission (or be a configured developer) to change the bot's status.");
  }
}

/** Shared renderer for the three presence commands' "current status" view. */
function presenceStatusEmbed(ctx, message) {
  const current = describePresence();
  const lines = PRESENCE_TYPE_KEYS.map((key) => `\`${key.padEnd(10)}\`${key === current?.key ? "  \u2190 active" : ""}`);
  const prefix = ctx.prefixFor(message.guildId);
  return card(ctx, {
    color: COLOR.accent,
    author: `${ctx.config.botName} \u2022 Presence`,
    title: current ? `Status: ${current.label} \u2014 ${truncate(current.text, 60)}` : "Status: rotating (default)",
    description:
      (current
        ? `**${current.label}** \u2014 ${truncate(current.text, 100)}${current.url ? `\n> ${current.url}` : ""}\n\n`
        : `No manual status set \u2014 the rotating status is running.\n\n`) +
      `${lines.join("\n")}\n\n` +
      `Set one with \`${prefix}status <text>\`, \`${prefix}stream <text> [url]\` or \`${prefix}activity <type> <text>\`.\n` +
      `Clear it with \`${prefix}status clear\` \u2014 rotation resumes.`,
    footer: `${ctx.config.botName} \u2022 bot presence \u2022 Manage Server required`,
  });
}

register({
  name: "status",
  aliases: ["setstatus"],
  category: "Settings",
  usage: "status [text | clear]",
  description: "Set the bot's custom status, or show the current one.",
  async run(ctx, message, args) {
    if (!args.length) {
      await message.reply({ embeds: [presenceStatusEmbed(ctx, message)] });
      return null;
    }
    requirePresencePermission(message);

    if (String(args[0]).toLowerCase() === "clear") {
      clearPresence();
      await message.reply({ embeds: [ok(ctx, "Status cleared \u2014 the rotating status is back.")] });
      return null;
    }

    const presence = normalizePresence({ type: "custom", text: args.join(" ") }, ctx);
    applyPresence(presence);
    await message.reply({ embeds: [ok(ctx, `Status set to **${truncate(presence.text, 80)}**.`)] });
    return null;
  },
});

register({
  name: "stream",
  aliases: ["setstream"],
  category: "Settings",
  usage: "stream [text] [url]",
  description: "Set a STREAMING status (purple LIVE badge), or show the current one.",
  async run(ctx, message, args) {
    if (!args.length) {
      await message.reply({ embeds: [presenceStatusEmbed(ctx, message)] });
      return null;
    }
    requirePresencePermission(message);

    if (String(args[0]).toLowerCase() === "clear") {
      clearPresence();
      await message.reply({ embeds: [ok(ctx, "Stream status cleared \u2014 the rotating status is back.")] });
      return null;
    }

    // A trailing http(s) token is the stream URL; everything before it is text.
    const urlIndex = args.findIndex((arg) => isHttpUrl(arg));
    const url = urlIndex >= 0 ? args[urlIndex] : undefined;
    const text = (urlIndex >= 0 ? args.slice(0, urlIndex) : args).join(" ").trim() || ctx.config.presence.defaultStreamText;

    // If the user clearly tried to give a URL (contains "://" or starts with
    // "www.") but it isn't a valid http(s) URL, say so instead of silently
    // falling back to the default.
    const looksLikeUrl = args.find((arg) => /:\/\/|^www\./i.test(arg));
    if (looksLikeUrl && !isHttpUrl(looksLikeUrl)) {
      fail("That stream URL isn't valid \u2014 it must start with `http://` or `https://`.");
    }

    const presence = normalizePresence({ type: "streaming", text, url }, ctx);
    applyPresence(presence);
    await message.reply({
      embeds: [ok(ctx, `Streaming status set to **${truncate(presence.text, 80)}**.\n> ${presence.url}`)],
    });
    return null;
  },
});

register({
  name: "activity",
  aliases: ["setactivity", "presence"],
  category: "Settings",
  usage: "activity [type] [text]",
  description: "Set the bot's activity type and text, or show the current one.",
  async run(ctx, message, args) {
    if (!args.length) {
      await message.reply({ embeds: [presenceStatusEmbed(ctx, message)] });
      return null;
    }
    requirePresencePermission(message);

    if (String(args[0]).toLowerCase() === "clear") {
      clearPresence();
      await message.reply({ embeds: [ok(ctx, "Activity cleared \u2014 the rotating status is back.")] });
      return null;
    }

    const type = String(args[0]).toLowerCase();
    if (!PRESENCE_TYPE_KEYS.includes(type)) {
      fail(`Pick an activity type: ${PRESENCE_TYPE_KEYS.map((k) => `\`${k}\``).join(", ")}.`);
    }
    const rest = args.slice(1);
    const urlIndex = rest.findIndex((arg) => isHttpUrl(arg));
    const url = urlIndex >= 0 ? rest[urlIndex] : undefined;
    const text = (urlIndex >= 0 ? rest.slice(0, urlIndex) : rest).join(" ").trim();
    if (!text) fail(`Use \`${ctx.prefixFor(message.guildId)}activity ${type} <text>\`.`);

    const presence = normalizePresence({ type, text, url }, ctx);
    applyPresence(presence);
    await message.reply({
      embeds: [ok(ctx, `Activity set to **${presence.key}** \u2014 ${truncate(presence.text, 80)}.`)],
    });
    return null;
  },
});

/* --- utility ------------------------------------------------------------- */

register({
  name: "ping",
  aliases: ["latency"],
  category: "Utility",
  usage: "ping",
  description: "Check gateway, REST and Lavalink latency.",
  async run(ctx, message) {
    const sent = await message.reply({ embeds: [info(ctx, "Measuring latency…")] });
    const player = getPlayer(ctx, message.guildId);
    const node = player?.node ?? ctx.lavalink.nodeManager.leastUsedNodes()[0];

    const roundtrip = sent.createdTimestamp - message.createdTimestamp;
    const ws = Math.max(0, Math.round(ctx.client.ws.ping));
    const lavalink = node?.stats ? `${Math.round(node.stats.playingPlayers)} players` : "no node";

    const embed = card(ctx, {
      color: ws < 200 ? COLOR.success : ws < 500 ? COLOR.warning : COLOR.danger,
      author: `${ctx.config.botName} • Diagnostics`,
      title: "All systems measured",
      fields: [
        { name: "Gateway", value: `\`${ws}ms\``, inline: true },
        { name: "Round trip", value: `\`${roundtrip}ms\``, inline: true },
        { name: "Lavalink", value: `\`${lavalink}\``, inline: true },
      ],
    });

    await sent.edit({ embeds: [embed] });
    return null;
  },
});

register({
  name: "stats",
  aliases: ["botinfo"],
  category: "Utility",
  usage: "stats",
  description: "Bot statistics and node health.",
  async run(ctx, message) {
    const players = [...ctx.lavalink.players.values()];
    const nodes = ctx.lavalink.nodeManager.leastUsedNodes();
    const mem = process.memoryUsage();

    const nodeLines = nodes.length
      ? nodes
          .map((node) => {
            const playing = Number(node.stats?.playingPlayers) || 0;
            const load = Number(node.stats?.cpu?.lavalinkLoad);
            const loadLabel = Number.isFinite(load) ? `${(load * 100).toFixed(1)}%` : "n/a";
            return `\`${node.options.id}\` — ${playing} playing • CPU ${loadLabel}`;
          })
          .join("\n")
      : "No Lavalink node connected";

    const embed = card(ctx, {
      color: COLOR.accent,
      author: ctx.config.botName,
      title: `${ctx.config.botName} — statistics`,
      thumbnail: ctx.client.user.displayAvatarURL({ size: 256 }),
    }).addFields(
        { name: "Servers", value: `\`${withCommas(ctx.client.guilds.cache.size)}\``, inline: true },
        { name: "Active players", value: `\`${players.length}\``, inline: true },
        { name: "Uptime", value: `\`${longDuration(process.uptime() * 1000)}\``, inline: true },
        { name: "Memory", value: `\`${(mem.heapUsed / 1024 / 1024).toFixed(0)} MB\``, inline: true },
        { name: "Prefix", value: `\`${ctx.prefixFor(message.guildId)}\``, inline: true },
        { name: "Commands", value: `\`${uniqueCommands().length}\``, inline: true },
        { name: "Lavalink nodes", value: nodeLines, inline: false }
      );

    if (ctx.config.supportServerUrl) embed.setURL(ctx.config.supportServerUrl);
    await message.reply({ embeds: [embed] });
    return null;
  },
});

register({
  name: "search",
  aliases: ["find"],
  category: "Utility",
  usage: "search <query>",
  description: "Search and pick a result from an interactive menu.",
  async run(ctx, message, args) {
    if (!args.length) fail(`Use \`${ctx.prefix}search <query>\`.`);
    const voiceChannel = requireVoiceChannel(message.member);
    const player = await getOrCreatePlayer(ctx, message.guild, voiceChannel, message.channel, message.author);

    const result = await search(ctx, player, args.join(" "), message.author);
    const tracks = result.tracks.slice(0, 10);

    if (tracks.length === 1) {
      tracks[0].requester = message.author;
      await player.queue.add(tracks[0]);
      if (!player.playing && !player.paused) await player.play();
      await message.reply({ embeds: [ok(ctx, `Queued **${truncate(tracks[0].info.title, 70)}**.`)] });
      return null;
    }

    pruneSearchSessions();
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    searchSessions.set(token, { tracks, userId: message.author.id, guildId: message.guildId, createdAt: Date.now() });

    const menu = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`gaana:search:${token}`)
        .setPlaceholder("Pick a track to queue…")
        .addOptions(
          tracks.map((track, index) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(truncate(track.info.title, 95))
              .setValue(String(index))
              .setDescription(truncate(`${track.info.author || "Unknown"} • ${clock(track.info.duration)}`, 95))
          )
        )
    );

    const embed = card(ctx, {
      color: COLOR.accent,
      author: `${ctx.config.botName} • Search`,
      title: `Results for "${truncate(args.join(" "), 60)}"`,
      description: "Choose a track from the menu below to queue it.",
      footer: `${ctx.config.botName} • only you can use this menu`,
    });

    await message.reply({ embeds: [embed], components: [menu] });
    return null;
  },
});

/* --- info ---------------------------------------------------------------- */

register({
  name: "source",
  aliases: ["src", "provider"],
  category: "Settings",
  usage: "source [spotify | youtube]",
  description: "Show or set which source plain-text searches use.",
  async run(ctx, message, args) {
    const player = getPlayer(ctx, message.guildId);
    const requested = String(args[0] ?? "").toLowerCase();

    if (!requested) {
      const current = player ? getSourceChoice(ctx, player) : null;
      const label = SOURCE_CHOICES.find((choice) => choice.key === current)?.label ?? "Default (YouTube)";
      const lines = SOURCE_CHOICES.map(
        (choice) => `\`${choice.key.padEnd(8)}\` ${choice.label}${choice.key === current ? "  \u2190 active" : ""}`
      );
      await message.reply({
        embeds: [
          card(ctx, {
            color: COLOR.accent,
            author: `${ctx.config.botName} \u2022 Source`,
            title: `Search source: ${label}`,
            description:
              `${lines.join("\n")}\n\n` +
              `Set it with \`${ctx.prefixFor(message.guildId)}source spotify\` or \`${ctx.prefixFor(message.guildId)}source youtube\`.\n` +
              "The choice applies to plain-text searches; pasted links always use their own source.\n" +
              "Use the **Switch now** button on the Now Playing card to re-resolve the current track immediately.",
            footer: `${ctx.config.botName} \u2022 also switchable from the Now Playing card`,
          }),
        ],
      });
      return null;
    }

    const choice = SOURCE_CHOICES.find((entry) => entry.key === requested);
    if (!choice) fail(`Pick a source: ${SOURCE_CHOICES.map((entry) => `\`${entry.key}\``).join(" or ")}.`);

    if (!player) {
      // No active player: persist the choice for the guild so the next play uses it.
      const current = ctx.stores.settings.get(message.guildId, {});
      const next = current && typeof current === "object" ? { ...current } : {};
      next.sourceChoice = choice.key;
      ctx.stores.settings.set(message.guildId, next);
    } else {
      setSourceChoice(ctx, player, choice.key);
      // Refresh the live card so the selected button highlights immediately.
      await postNowPlaying(ctx, player, player.queue.current, player.queue.current?.requester?.id ?? null).catch(() => {});
    }

    await message.reply({ embeds: [ok(ctx, `Search source set to **${choice.label}**.`)] });
    return null;
  },
});

register({
  name: "trackinfo",
  aliases: ["ti"],
  category: "Info",
  usage: "trackinfo [position]",
  description: "Show detailed information about a track.",
  async run(ctx, message, args) {
    const player = requirePlayer(ctx, message.guildId);
    let track;
    if (args.length) {
      const max = player.queue.tracks.length;
      if (!max) fail("The queue is empty.");
      const index = requireIndex(args[0], max);
      track = player.queue.tracks[index - 1];
    } else {
      track = requireCurrentTrack(player);
    }

    const info = track.info;
    const embed = card(ctx, {
      color: COLOR.accent,
      author: `${ctx.config.botName} • Track info`,
      title: truncate(info.title, 90),
      url: info.uri || null,
      thumbnail: artworkOf(track),
      fields: [
        { name: "Artist", value: truncate(info.author || "Unknown", 60), inline: true },
        { name: "Duration", value: info.isStream ? "Live" : clock(info.duration), inline: true },
        { name: "Source", value: sourceLabel(track), inline: true },
        { name: "Requester", value: track.requester?.id ? `<@${track.requester.id}>` : "Unknown", inline: true },
        { name: "Identifier", value: `\`${truncate(info.identifier || "n/a", 40)}\``, inline: true },
        { name: "Seekable", value: info.isSeekable ? "Yes" : "No", inline: true },
      ],
    });

    await message.reply({ embeds: [embed] });
    return null;
  },
});

register({
  name: "artistinfo",
  aliases: ["ai"],
  category: "Info",
  usage: "artistinfo",
  description: "Show information about the current track's artist.",
  async run(ctx, message) {
    const player = requirePlayer(ctx, message.guildId);
    const track = requireCurrentTrack(player);
    const author = track.info.author || "Unknown artist";

    const embed = card(ctx, {
      color: COLOR.accent,
      author: `${ctx.config.botName} • Artist`,
      title: truncate(author, 80),
      description: `Currently playing: [${truncate(track.info.title, 70)}](${track.info.uri})`,
      thumbnail: artworkOf(track),
      fields: [{ name: "More from this artist", value: `\`${ctx.prefix}play ${truncate(author, 60)}\``, inline: false }],
    });

    await message.reply({ embeds: [embed] });
    return null;
  },
});

register({
  name: "grab",
  aliases: ["dm"],
  category: "Info",
  usage: "grab",
  description: "Send the current track's details to your DMs.",
  async run(ctx, message) {
    const player = requirePlayer(ctx, message.guildId);
    const track = requireCurrentTrack(player);

    const embed = card(ctx, {
      color: COLOR.accent,
      author: `${ctx.config.botName} • Grabbed track`,
      title: truncate(track.info.title, 90),
      description: `[Open in ${sourceLabel(track)}](${track.info.uri})`,
    }).addFields(
        { name: "Artist", value: truncate(track.info.author || "Unknown", 60), inline: true },
        { name: "Duration", value: track.info.isStream ? "Live" : clock(track.info.duration), inline: true }
      );

    const art = artworkOf(track);
    if (art) embed.setThumbnail(art);

    try {
      const user = await ctx.client.users.fetch(message.author.id);
      await user.send({ embeds: [embed] });
      await message.reply({ embeds: [ok(ctx, "Sent the track details to your DMs.")] });
    } catch {
      fail("I couldn't DM you — check that your privacy settings allow direct messages.");
    }
    return null;
  },
});

register({
  name: "history",
  aliases: ["recent", "played"],
  category: "Info",
  usage: "history",
  description: "Show recently played tracks in this server.",
  async run(ctx, message) {
    const list = historyOf(ctx, message.guildId);
    if (!list.length) fail("Nothing has been played yet in this server.");

    const lines = list
      .slice(0, 15)
      .map((item, index) => `\`${String(index + 1).padStart(2, "0")}\`  [${truncate(item.title, 55)}](${item.uri})  \`${clock(item.duration)}\`${item.requesterId ? `  — <@${item.requesterId}>` : ""}`);

    await message.reply({
      embeds: [
        card(ctx, {
          color: COLOR.accent,
          author: `${ctx.config.botName} • History`,
          title: "Recently played",
          description: lines.join("\n"),
          footer: `${ctx.config.botName} • last ${Math.min(list.length, 15)} tracks`,
        }),
      ],
    });
    return null;
  },
});

register({
  name: "uptime",
  category: "Info",
  usage: "uptime",
  description: "Show how long the bot has been online.",
  async run(ctx, message) {
    await message.reply({
      embeds: [
        card(ctx, {
          color: COLOR.accent,
          author: `${ctx.config.botName} • Uptime`,
          title: `Online for ${longDuration(process.uptime() * 1000)}`,
          description: `Started <t:${Math.floor((Date.now() - process.uptime() * 1000) / 1000)}:R>`,
        }),
      ],
    });
    return null;
  },
});

register({
  name: "invite",
  category: "Info",
  usage: "invite",
  description: "Get the bot's invite link.",
  async run(ctx, message) {
    const permissions =
      PermissionFlagsBits.ViewChannel |
      PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.EmbedLinks |
      PermissionFlagsBits.ReadMessageHistory |
      PermissionFlagsBits.Connect |
      PermissionFlagsBits.Speak;
    const url = `https://discord.com/api/oauth2/authorize?client_id=${ctx.client.user.id}&permissions=${permissions}&scope=bot%20applications.commands`;

    await message.reply({
      embeds: [
        card(ctx, {
          color: COLOR.accent,
          author: `${ctx.config.botName} • Invite`,
          title: `Add ${ctx.config.botName} to your server`,
          description: `[Click here to invite me](${url})`,
          url,
        }),
      ],
    });
    return null;
  },
});

register({
  name: "support",
  category: "Info",
  usage: "support",
  description: "Get the support server link.",
  async run(ctx, message) {
    const url = ctx.config.supportServerUrl;
    await message.reply({
      embeds: [
        card(ctx, {
          color: COLOR.accent,
          author: `${ctx.config.botName} • Support`,
          title: "Need help?",
          description: url ? `Join the support server: ${url}` : "No support server is configured. Set `supportServerUrl` in config.json.",
        }),
      ],
    });
    return null;
  },
});

register({
  name: "vote",
  category: "Info",
  usage: "vote",
  description: "Get the bot's vote link.",
  async run(ctx, message) {
    const url = ctx.config.voteUrl;
    await message.reply({
      embeds: [
        card(ctx, {
          color: COLOR.accent,
          author: `${ctx.config.botName} • Vote`,
          title: `Enjoying ${ctx.config.botName}?`,
          description: url ? `Vote for me here: ${url}` : "No vote link is configured. Set `voteUrl` in config.json.",
        }),
      ],
    });
    return null;
  },
});

register({
  name: "nodeinfo",
  aliases: ["nodes"],
  category: "Info",
  usage: "nodeinfo",
  description: "Show Lavalink node details.",
  async run(ctx, message) {
    const nodes = ctx.lavalink.nodeManager.leastUsedNodes();
    if (!nodes.length) fail("No Lavalink node is connected right now.");

    const embed = card(ctx, {
      color: COLOR.accent,
      author: `${ctx.config.botName} • Nodes`,
      title: "Lavalink nodes",
    });

    for (const node of nodes) {
      const stats = node.stats || {};
      const cpu = Number(stats.cpu?.lavalinkLoad);
      embed.addFields({
        name: `\`${node.options.id}\` — ${node.isAlive ? "online" : "offline"}`,
        value:
          `Players: \`${Number(stats.playingPlayers) || 0}\` • Uptime: \`${longDuration(Number(stats.uptime) || 0)}\`\n` +
          `CPU: \`${Number.isFinite(cpu) ? `${(cpu * 100).toFixed(1)}%` : "n/a"}\` • Memory: \`${((Number(stats.memory?.used) || 0) / 1024 / 1024).toFixed(0)} MB\``,
        inline: false,
      });
    }

    await message.reply({ embeds: [embed] });
    return null;
  },
});

register({
  name: "shardinfo",
  aliases: ["shards"],
  category: "Info",
  usage: "shardinfo",
  description: "Show shard information.",
  async run(ctx, message) {
    const shards = [...(ctx.client.ws.shards?.values?.() ?? [])];
    const embed = card(ctx, {
      color: COLOR.accent,
      author: `${ctx.config.botName} • Shards`,
      title: "Shard information",
    });

    if (!shards.length) {
      embed.setDescription(`Running on a single shard (id \`0\`) • gateway ping \`${Math.round(ctx.client.ws.ping)}ms\``);
    } else {
      embed.setDescription(
        shards
          .map((shard) => `Shard \`${shard.id}\` — ${shard.status === 0 ? "ready" : `status ${shard.status}`} • ping \`${Math.round(shard.ping)}ms\``)
          .join("\n")
      );
    }

    await message.reply({ embeds: [embed] });
    return null;
  },
});

/* --- help ---------------------------------------------------------------- */

const HELP_CATEGORIES = ["Playback", "Queue", "Audio", "Filters", "Favorites", "Playlist", "Settings", "Utility", "Info"];

function uniqueCommands() {
  return [...new Set(commands.values())].sort((a, b) => a.name.localeCompare(b.name));
}

function buildHelpPage(ctx, guildId, category = "Overview") {
  const prefix = ctx.prefixFor(guildId);
  const list = uniqueCommands();
  const name = ctx.config.botName;

  let embed;
  if (category === "Overview") {
    const byCategory = new Map();
    for (const command of list) {
      if (!byCategory.has(command.category)) byCategory.set(command.category, []);
      byCategory.get(command.category).push(command);
    }

    embed = card(ctx, {
      color: COLOR.accent,
      author: `${name} • Help`,
      title: `${name} — command centre`,
      thumbnail: ctx.client.user.displayAvatarURL({ size: 256 }),
      url: ctx.config.supportServerUrl || null,
      description:
        `Prefix on this server: \`${prefix}\`  •  **${list.length}** commands\n` +
        `Slash commands work too — just type \`/\`.\n\n` +
        "```\n" +
        `${prefix}play <song|url>   start the music\n` +
        `${prefix}np                now playing card\n` +
        `${prefix}q                 interactive queue\n` +
        `${prefix}help <command>    details for one command\n` +
        "```",
      fields: [...byCategory].map(([group, items]) => ({
        name: `${group} • ${items.length}`,
        value: items.map((item) => `\`${item.name}\``).join(" · "),
        inline: false,
      })),
      footer: `${name} • pick a category below`,
    });
  } else {
    const items = list.filter((command) => command.category === category);
    embed = card(ctx, {
      color: COLOR.accent,
      author: `${name} • Help`,
      title: `${category} commands`,
      description: items
        .map(
          (command) =>
            `**\`${prefix}${command.usage}\`** — ${command.description}` +
            (command.aliases?.length ? `\n> aliases: ${command.aliases.map((a) => `\`${a}\``).join(", ")}` : "")
        )
        .join("\n\n"),
      footer: `${name} • ${items.length} command${items.length === 1 ? "" : "s"} in ${category}`,
    });
  }

  // NOTE: select-menu options carry NO emoji. An invalid emoji here makes
  // Discord reject the whole message ("Invalid Form Body"), which is exactly
  // what used to break both ?help and /help. Plain labels are also cleaner.
  const menu = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("gaana:help")
      .setPlaceholder("Choose a category…")
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel("Overview")
          .setValue("Overview")
          .setDescription(`${list.length} commands`),
        ...HELP_CATEGORIES.map((group) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(group)
            .setValue(group)
            .setDescription(`${list.filter((command) => command.category === group).length} commands`)
        )
      )
  );

  return { embeds: [embed], components: [menu] };
}

register({
  name: "help",
  aliases: ["h", "commands", "cmds"],
  category: "Utility",
  usage: "help [command]",
  description: "Show the command menu, or details for one command.",
  async run(ctx, message, args) {
    if (args.length) {
      const target = commands.get(String(args[0]).toLowerCase());
      if (!target) fail(`No command called **${truncate(args[0], 30)}**. Run \`${ctx.prefixFor(message.guildId)}help\` for the full list.`);

      const prefix = ctx.prefixFor(message.guildId);
      const embed = card(ctx, {
        color: COLOR.accent,
        author: `${ctx.config.botName} • Help`,
        title: `${prefix}${target.usage}`,
        description: target.description,
        fields: [
          { name: "Category", value: target.category, inline: true },
          { name: "Aliases", value: target.aliases?.length ? target.aliases.map((a) => `\`${a}\``).join(", ") : "none", inline: true },
        ],
      });
      await message.reply({ embeds: [embed] });
      return null;
    }

    await message.reply(buildHelpPage(ctx, message.guildId, "Overview"));
    return null;
  },
});

/* --- exported API -------------------------------------------------------- */

function getCommand(name) {
  return commands.get(String(name || "").toLowerCase()) ?? null;
}

function commandNames() {
  return uniqueCommands().map((command) => command.name);
}

async function runAutoplay(ctx, player, lastTrack) {
  return autoplayNext(ctx, player, lastTrack);
}

/* ==========================================================================
 * slash.js
 * ========================================================================== */

/**
 * Slash commands.
 *
 * Every slash command is a thin wrapper: it declares its options, then reuses
 * the exact same `run(ctx, message, args)` function as the prefix command. That
 * keeps behaviour identical between `?play x` and `/play query:x` — one source
 * of truth, no duplicated logic.
 */

const S = ApplicationCommandOptionType.String;
const I = ApplicationCommandOptionType.Integer;
const N = ApplicationCommandOptionType.Number;

/* --------------------------------------------------------------- builders */

function applyOption(builder, option) {
  const common = (opt) => {
    opt.setName(option.name).setDescription(option.description);
    if (option.required) opt.setRequired(true);
    return opt;
  };

  switch (option.type) {
    case S:
      return builder.addStringOption((opt) => {
        common(opt);
        if (option.choices) opt.addChoices(...option.choices.map((value) => ({ name: value, value })));
        return opt;
      });
    case I:
      return builder.addIntegerOption((opt) => {
        common(opt);
        if (option.min !== undefined) opt.setMinValue(option.min);
        if (option.max !== undefined) opt.setMaxValue(option.max);
        return opt;
      });
    case N:
      return builder.addNumberOption((opt) => {
        common(opt);
        if (option.min !== undefined) opt.setMinValue(option.min);
        if (option.max !== undefined) opt.setMaxValue(option.max);
        return opt;
      });
    default:
      return builder;
  }
}

/**
 * The slash command table. `toArgs` turns the interaction's options into the
 * positional argument array the prefix command expects.
 */
const DEFS = [
  { name: "play", description: "Search and queue a track or playlist.", options: [{ name: "query", type: S, description: "Song name or URL", required: true }], toArgs: (o) => [o.getString("query")] },
  { name: "pause", description: "Pause the current track.", toArgs: () => [] },
  { name: "resume", description: "Resume playback.", toArgs: () => [] },
  { name: "skip", description: "Skip the current track, or several.", options: [{ name: "amount", type: I, description: "How many tracks to skip", min: 1, max: 100 }], toArgs: (o) => (o.getInteger("amount") ? [String(o.getInteger("amount"))] : []) },
  { name: "previous", description: "Play the previous track again.", toArgs: () => [] },
  { name: "replay", description: "Restart the current track.", toArgs: () => [] },
  { name: "stop", description: "Stop playback and clear the queue.", toArgs: () => [] },
  { name: "disconnect", description: "Disconnect the bot from voice.", toArgs: () => [] },
  { name: "queue", description: "Show the interactive queue.", options: [{ name: "page", type: I, description: "Page number", min: 1 }], toArgs: (o) => (o.getInteger("page") ? [String(o.getInteger("page"))] : []) },
  { name: "nowplaying", description: "Show the Now Playing card.", toArgs: () => [] },
  { name: "loop", description: "Set the repeat mode.", options: [{ name: "mode", type: S, description: "Repeat mode", choices: ["off", "track", "queue"] }], toArgs: (o) => (o.getString("mode") ? [o.getString("mode")] : []) },
  { name: "shuffle", description: "Shuffle the upcoming queue.", toArgs: () => [] },
  { name: "remove", description: "Remove a track by position.", options: [{ name: "position", type: I, description: "Queue position", required: true, min: 1 }], toArgs: (o) => [String(o.getInteger("position"))] },
  { name: "removerange", description: "Remove a range of queued tracks.", options: [{ name: "from", type: I, description: "First position", required: true, min: 1 }, { name: "to", type: I, description: "Last position", required: true, min: 1 }], toArgs: (o) => [String(o.getInteger("from")), String(o.getInteger("to"))] },
  { name: "move", description: "Move a queued track.", options: [{ name: "from", type: I, description: "Current position", required: true, min: 1 }, { name: "to", type: I, description: "New position", required: true, min: 1 }], toArgs: (o) => [String(o.getInteger("from")), String(o.getInteger("to"))] },
  { name: "jump", description: "Jump to a queued track.", options: [{ name: "position", type: I, description: "Queue position", required: true, min: 1 }], toArgs: (o) => [String(o.getInteger("position"))] },
  { name: "clear", description: "Clear every upcoming track.", toArgs: () => [] },
  { name: "dedupe", description: "Remove duplicate tracks.", toArgs: () => [] },
  { name: "sort", description: "Sort the queue.", options: [{ name: "by", type: S, description: "Sort field", choices: ["title", "duration", "author"] }, { name: "order", type: S, description: "Sort order", choices: ["asc", "desc"] }], toArgs: (o) => [o.getString("by") ?? "title", o.getString("order") ?? "asc"] },
  { name: "autoplay", description: "Toggle autoplay.", toArgs: () => [] },
  { name: "queuesave", description: "Save the current queue.", options: [{ name: "name", type: S, description: "Save name" }], toArgs: (o) => (o.getString("name") ? [o.getString("name")] : []) },
  { name: "queuerestore", description: "Restore a saved queue.", options: [{ name: "name", type: S, description: "Save name" }], toArgs: (o) => (o.getString("name") ? [o.getString("name")] : []) },
  { name: "seek", description: "Jump to a timestamp.", options: [{ name: "time", type: S, description: "mm:ss or seconds", required: true }], toArgs: (o) => [o.getString("time")] },
  { name: "forward", description: "Skip forward in the track.", options: [{ name: "seconds", type: I, description: "Seconds to skip", min: 1, max: 600 }], toArgs: (o) => (o.getInteger("seconds") ? [String(o.getInteger("seconds"))] : []) },
  { name: "rewind", description: "Go back in the track.", options: [{ name: "seconds", type: I, description: "Seconds to rewind", min: 1, max: 600 }], toArgs: (o) => (o.getInteger("seconds") ? [String(o.getInteger("seconds"))] : []) },
  { name: "volume", description: "Show or set the volume.", options: [{ name: "level", type: I, description: "Volume 0-100", min: 0, max: 200 }], toArgs: (o) => (o.getInteger("level") !== null ? [String(o.getInteger("level"))] : []) },
  { name: "speed", description: "Change playback speed.", options: [{ name: "value", type: N, description: "0.5 - 2.0", required: true, min: 0.5, max: 2 }], toArgs: (o) => [String(o.getNumber("value"))] },
  { name: "pitch", description: "Change playback pitch.", options: [{ name: "value", type: N, description: "0.5 - 2.0", required: true, min: 0.5, max: 2 }], toArgs: (o) => [String(o.getNumber("value"))] },
  { name: "rate", description: "Change playback rate.", options: [{ name: "value", type: N, description: "0.5 - 2.0", required: true, min: 0.5, max: 2 }], toArgs: (o) => [String(o.getNumber("value"))] },
  { name: "equalizer", description: "Apply an equalizer preset or band.", options: [{ name: "preset", type: S, description: "Preset name or band number" }, { name: "gain", type: N, description: "Band gain (-0.25 - 1.0)", min: -0.25, max: 1 }], toArgs: (o) => { const args = []; if (o.getString("preset")) args.push(o.getString("preset")); if (o.getNumber("gain") !== null) args.push(String(o.getNumber("gain"))); return args; } },
  { name: "filter", description: "Apply an audio filter preset.", options: [{ name: "preset", type: S, description: "Filter preset", choices: FILTER_NAMES }], toArgs: (o) => (o.getString("preset") ? [o.getString("preset")] : []) },
  { name: "lyrics", description: "Fetch lyrics.", options: [{ name: "query", type: S, description: "Song to look up" }], toArgs: (o) => (o.getString("query") ? [o.getString("query")] : []) },
  { name: "search", description: "Search and pick a result.", options: [{ name: "query", type: S, description: "Search term", required: true }], toArgs: (o) => [o.getString("query")] },
  { name: "like", description: "Save the current track to favorites.", toArgs: () => [] },
  { name: "likeall", description: "Save the current track and queue.", toArgs: () => [] },
  { name: "favorites", description: "List your saved tracks.", toArgs: () => [] },
  { name: "playfavorites", description: "Queue your saved tracks.", options: [{ name: "count", type: I, description: "How many to queue", min: 1, max: 50 }], toArgs: (o) => (o.getInteger("count") ? [String(o.getInteger("count"))] : []) },
  { name: "unlike", description: "Clear your favorites.", toArgs: () => [] },
  { name: "playlist", description: "Manage your playlists.", options: [{ name: "action", type: S, description: "What to do", choices: ["save", "load", "show", "list", "delete"] }, { name: "name", type: S, description: "Playlist name" }], toArgs: (o) => { const args = []; if (o.getString("action")) args.push(o.getString("action")); if (o.getString("name")) args.push(o.getString("name")); return args; } },
  { name: "trackinfo", description: "Show track details.", options: [{ name: "position", type: I, description: "Queue position", min: 1 }], toArgs: (o) => (o.getInteger("position") ? [String(o.getInteger("position"))] : []) },
  { name: "artistinfo", description: "Show the current artist.", toArgs: () => [] },
  { name: "grab", description: "DM the current track to you.", toArgs: () => [] },
  { name: "history", description: "Show recently played tracks.", toArgs: () => [] },
  { name: "247", description: "Toggle 24/7 mode.", toArgs: () => [] },
  { name: "source", description: "Show or set the search source (Spotify / YouTube).", options: [{ name: "provider", type: S, description: "Which source to use", choices: ["spotify", "youtube"] }], toArgs: (o) => (o.getString("provider") ? [o.getString("provider")] : []) },
  { name: "status", description: "Set the bot's custom status, or show the current one.", options: [{ name: "text", type: S, description: "Status text, or 'clear' to reset" }], toArgs: (o) => (o.getString("text") ? [o.getString("text")] : []) },
  { name: "stream", description: "Set a STREAMING status (LIVE badge), or show the current one.", options: [{ name: "text", type: S, description: "Stream title, or 'clear' to reset" }, { name: "url", type: S, description: "Twitch/YouTube URL (optional)" }], toArgs: (o) => { const a = []; if (o.getString("text")) a.push(o.getString("text")); if (o.getString("url")) a.push(o.getString("url")); return a; } },
  { name: "activity", description: "Set the bot's activity type and text, or show the current one.", options: [{ name: "type", type: S, description: "Activity type", choices: ["playing", "streaming", "listening", "watching", "competing", "custom"] }, { name: "text", type: S, description: "Activity text, or 'clear' to reset" }, { name: "url", type: S, description: "Stream URL (streaming only)" }], toArgs: (o) => { const a = []; if (o.getString("type")) a.push(o.getString("type")); if (o.getString("text")) a.push(o.getString("text")); if (o.getString("url")) a.push(o.getString("url")); return a; } },
  { name: "prefix", description: "Show or change the prefix.", options: [{ name: "value", type: S, description: "New prefix" }], toArgs: (o) => (o.getString("value") ? [o.getString("value")] : []) },
  { name: "join", description: "Join your voice channel.", toArgs: () => [] },
  { name: "ping", description: "Check latency.", toArgs: () => [] },
  { name: "stats", description: "Bot statistics.", toArgs: () => [] },
  { name: "uptime", description: "Show bot uptime.", toArgs: () => [] },
  { name: "invite", description: "Get the invite link.", toArgs: () => [] },
  { name: "support", description: "Get the support link.", toArgs: () => [] },
  { name: "vote", description: "Get the vote link.", toArgs: () => [] },
  { name: "nodeinfo", description: "Show Lavalink node details.", toArgs: () => [] },
  { name: "shardinfo", description: "Show shard information.", toArgs: () => [] },
  { name: "help", description: "Show the command menu.", options: [{ name: "command", type: S, description: "Command to explain" }], toArgs: (o) => (o.getString("command") ? [o.getString("command")] : []) },
];

/** Builds the JSON payload Discord expects. */
function buildSlashCommands() {
  return DEFS.map((def) => {
    const builder = new SlashCommandBuilder().setName(def.name).setDescription(def.description);
    for (const option of def.options || []) applyOption(builder, option);
    return builder.toJSON();
  });
}

function slashCommandNames() {
  return DEFS.map((def) => def.name);
}

/* --------------------------------------------------------------- adapter */

/**
 * Wraps an interaction so the prefix command's `run(ctx, message, args)` works
 * unchanged. The interaction must already be deferred before this is called.
 */
function makeSlashMessage(interaction) {
  let first = true;
  const send = (payload) => {
    if (first) {
      first = false;
      return interaction.editReply(payload);
    }
    return interaction.followUp(payload);
  };

  return {
    guildId: interaction.guildId,
    guild: interaction.guild,
    member: interaction.member,
    author: interaction.user,
    createdTimestamp: interaction.createdTimestamp,
    channel: {
      id: interaction.channelId,
      isTextBased: () => true,
      send: (payload) => interaction.followUp(payload),
      sendTyping: async () => {},
    },
    reply: (payload) => send(payload),
  };
}

/** Dispatches a chat-input interaction to the matching prefix command. */
async function handleSlashCommand(ctx, interaction) {
  const def = DEFS.find((entry) => entry.name === interaction.commandName);
  const command = getCommand(interaction.commandName);
  if (!def || !command) {
    await interaction.editReply({ embeds: [warn(ctx, "That command isn't available right now.")] });
    return;
  }

  const args = def.toArgs(interaction.options);
  const message = makeSlashMessage(interaction);

  try {
    await command.run(ctx, message, args);
  } catch (error) {
    if (error instanceof UserError) {
      await interaction.editReply({ embeds: [warn(ctx, error.message)] }).catch(() => {});
      return;
    }
    ctx.log.error(`Slash /${interaction.commandName} failed:`, error?.stack || error);
    await interaction.editReply({ embeds: [err(ctx, "Something unexpected broke while running that command. It's been logged.")] }).catch(() => {});
  }
}

/* ------------------------------------------------------------ registration */

/**
 * Registers the slash commands globally and per-guild. Guild registration is
 * instant (useful while testing); global registration can take up to an hour to
 * propagate but works everywhere.
 */
/**
 * Registers the slash commands in EXACTLY ONE scope.
 *
 * Registering the same command both globally and per-guild makes Discord show
 * it TWICE in the picker (the global copy and the guild copy are separate
 * entries) — that is the duplicate-slash-command bug. So we pick one scope:
 *
 *   - `slashGuildIds` set  -> register ONLY in those guilds (instant, and the
 *     global set is cleared so no duplicate lingers from an earlier run)
 *   - otherwise            -> register globally only (works everywhere; can
 *     take up to an hour to propagate)
 *
 * A module-level guard makes this idempotent, so a reconnect or a second call
 * can never double-register.
 */
let slashRegistrationDone = false;

async function registerSlashCommands(client, ctx) {
  if (slashRegistrationDone) return;
  slashRegistrationDone = true;

  const data = buildSlashCommands();
  const log = ctx.log;
  const guildIds = (ctx.config.slashGuildIds || []).filter((id) => /^\d{17,20}$/.test(String(id)));

  if (guildIds.length) {
    // Guild scope only. Clear the global set first so a previous global
    // registration cannot show up as a duplicate beside the guild copy.
    try {
      await client.application.commands.set([]);
    } catch (error) {
      log.debug("Could not clear global slash commands:", error.message);
    }

    let registered = 0;
    for (const guildId of guildIds) {
      try {
        const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
        if (!guild) continue;
        await guild.commands.set(data);
        registered += 1;
      } catch (error) {
        log.debug(`Guild slash registration failed for ${guildId}:`, error.message);
      }
    }
    log.info(`Registered ${data.length} slash commands in ${registered} guild(s) (guild scope).`);
    return;
  }

  try {
    await client.application.commands.set(data);
    log.info(`Registered ${data.length} global slash commands (global scope).`);
  } catch (error) {
    log.error("Global slash registration failed:", error.message);
  }
}

/* ==========================================================================
 * index.js (boot)
 * ========================================================================== */

function boot() {
  if (process.argv.includes("--check")) {
    runSelfTest().then(() => process.exit(0)).catch(() => process.exit(1));
    return;
  }
  if (process.argv.includes("--deploy-commands")) {
    deployCommands().then(() => process.exit(0)).catch((error) => { console.error("Deploy failed:", error.message); process.exit(1); });
    return;
  }
/**
 * Gaana — a production-ready Discord music bot.
 *
 * Entry point: loads config, boots the Discord client + Lavalink manager,
 * wires the prefix dispatcher, slash commands, player controls and the
 * interactive queue pager, and serves a keep-alive HTTP endpoint for hosting
 * panels that require a bound port.
 */


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bootLog = createLogger("boot");

/* ----------------------------------------------------------- crash guards */

process.on("unhandledRejection", (reason) => {
  bootLog.error("Unhandled rejection:", reason instanceof Error ? reason.stack : reason);
});
process.on("uncaughtException", (error) => {
  bootLog.error("Uncaught exception:", error?.stack || error);
});

/* ------------------------------------------------------------------ config */

const config = loadConfig(path.join(__dirname, "config.json"));
const stores = createStores(dataDir(__dirname));

bootLog.info(`Starting ${config.botName} v7.0.0`);
bootLog.info(`Lavalink node(s): ${config.nodes.map((node) => `${node.id}@${node.host}:${node.port}`).join(", ")}`);

/* -------------------------------------------------------- keep-alive web */

const app = express();
const port = Number.parseInt(process.env.PORT || "3000", 10) || 3000;

app.get("/", (_req, res) => {
  res.type("text/plain").send(`${config.botName} is online.`);
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    bot: config.botName,
    uptime: Math.floor(process.uptime()),
    guilds: client.guilds.cache.size,
    players: lavalink.players.size,
    nodes: [...lavalink.nodeManager.leastUsedNodes()].map((node) => ({
      id: node.options.id,
      connected: Boolean(node.isAlive),
      playingPlayers: Number(node.stats?.playingPlayers) || 0,
    })),
  });
});

const server = app.listen(port, () => bootLog.info(`Keep-alive server listening on port ${port}`));
server.on("error", (error) => bootLog.error("Keep-alive server error:", error.message));

/* ------------------------------------------------------------------ client */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
  allowedMentions: { parse: ["users"], repliedUser: false },
});

const lavalink = new LavalinkManager({
  nodes: config.nodes.map((node) => ({
    id: node.id,
    host: node.host,
    port: node.port,
    authorization: node.password,
    secure: node.secure,
    retryAmount: node.retryAmount,
    retryDelay: node.retryDelay,
  })),
  sendToShard: (guildId, payload) => {
    const guild = client.guilds.cache.get(guildId);
    guild?.shard?.send(payload);
  },
  client: {
    id: process.env.CLIENT_ID || "",
    username: config.botName,
  },
  autoSkip: true,
  playerOptions: {
    defaultSearchPlatform: config.defaultSearchSource,
    volumeDecrementer: 0.75,
    clientBasedPositionUpdateInterval: 150,
    onDisconnect: {
      autoReconnect: true,
      destroyPlayer: false,
    },
    onEmptyQueue: {
      destroyAfterMs: 30_000,
      autoPlayFunction: async (player, lastTrack) => {
        if (pget(player, "autoplay")) await runAutoplay(ctx, player, lastTrack);
      },
    },
  },
  queueOptions: {
    maxPreviousTracks: 25,
  },
});

/** Shared context object passed to every command. */
const ctx = {
  client,
  lavalink,
  config,
  stores,
  icons: config.icons,
  log: createLogger("cmd"),
  prefixFor(guildId) {
    return stores.prefixes.get(guildId, config.prefix) || config.prefix;
  },
  setPrefix(guildId, value) {
    if (value === config.prefix) stores.prefixes.delete(guildId);
    else stores.prefixes.set(guildId, value);
    return value;
  },
};

/* --------------------------------------------------------------- helpers */

function commandPrefixFor(message) {
  // Mentions work as a prefix too: "@Gaana play …"
  const mention = `<@${client.user.id}>`;
  const mentionNick = `<@!${client.user.id}>`;
  if (message.content.startsWith(mention)) return mention;
  if (message.content.startsWith(mentionNick)) return mentionNick;
  return ctx.prefixFor(message.guildId);
}

function parseCommand(message) {
  if (!message.content) return null;
  const prefix = commandPrefixFor(message);
  if (!message.content.startsWith(prefix)) return null;

  const rest = message.content.slice(prefix.length).trim();
  if (!rest) return null;

  const [rawName, ...args] = tokenize(rest);
  if (!rawName) return null;

  return { name: rawName.toLowerCase(), args, prefix };
}

function isOwner(userId) {
  return config.developerIds.includes(userId);
}

/** Cooldown guard so a spammed prefix cannot flood the music server. */
const cooldowns = new Map();
const COOLDOWN_MS = 700;

function onCooldown(userId, commandName) {
  if (commandName === "np" || commandName === "nowplaying" || commandName === "queue") return false;
  const key = `${userId}:${commandName}`;
  const now = Date.now();
  const last = cooldowns.get(key) || 0;
  if (now - last < COOLDOWN_MS) return true;
  cooldowns.set(key, now);
  if (cooldowns.size > 5000) cooldowns.clear();
  return false;
}

/* -------------------------------------------------------------- messaging */

client.on("messageCreate", async (message) => {
  try {
    if (!message.inGuild() || message.author.bot || message.system) return;

    const parsed = parseCommand(message);
    if (!parsed) return;

    const { name, args } = parsed;

    // Owner-only surface: intentionally small and non-destructive.
    if (name === "eval" || name === "reload") {
      if (!isOwner(message.author.id)) return;
      if (name === "reload") {
        await message.reply({ embeds: [ok(ctx, "Config is read at boot — restart the process to apply changes.")] });
        return;
      }
      return;
    }

    const command = getCommand(name);
    if (!command) return; // unknown commands are ignored, not error-spammed

    if (onCooldown(message.author.id, command.name)) return;

    const started = Date.now();
    await command.run(ctx, message, args);
    ctx.log.debug(`${command.name} by ${message.author.tag} in ${message.guild.name} (${Date.now() - started}ms)`);
  } catch (error) {
    await handleCommandError(error, message);
  }
});

async function handleCommandError(error, message) {
  if (error instanceof UserError) {
    await message.reply({ embeds: [warn(ctx, error.message, "Can't do that")] }).catch(() => {});
    return;
  }

  ctx.log.error(`Command failed in ${message.guild?.name}:`, error?.stack || error);

  // Lavalink/voice failures are common and worth a friendly message.
  const message4006 = String(error?.message || "");
  const reason = /voice|connect|channel|node/i.test(message4006)
    ? "I couldn't reach the voice channel or the music server. Try again in a moment."
    : "Something unexpected broke while running that command. It's been logged.";

  await message
    .reply({ embeds: [err(ctx, reason)] })
    .catch(() => {});
}

/* --------------------------------------------------------------- buttons */

client.on("interactionCreate", async (interaction) => {
  try {
    // --- slash commands -------------------------------------------------
    if (interaction.isChatInputCommand()) {
      if (!interaction.inGuild()) {
        await interaction.reply({ embeds: [warn(ctx, "Use me inside a server.")], ephemeral: true });
        return;
      }
      await interaction.deferReply();
      await handleSlashCommand(ctx, interaction);
      return;
    }

    // --- help category dropdown ----------------------------------------
    if (interaction.isStringSelectMenu() && interaction.customId === "gaana:help") {
      await interaction.update(buildHelpPage(ctx, interaction.guildId, interaction.values[0]));
      return;
    }

    // --- interactive search results ------------------------------------
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("gaana:search:")) {
      await handleSearchSelect(ctx, interaction);
      return;
    }

    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("gaana:")) return;

    // --- queue pager buttons -------------------------------------------
    if (interaction.customId.startsWith("gaana:q:")) {
      await handleQueueButton(ctx, interaction);
      return;
    }

    // --- switch the CURRENT track to the selected source, right now -----
    if (interaction.customId === "gaana:srcnow") {
      const nowPlayer = getPlayer(ctx, interaction.guildId);
      if (!nowPlayer) {
        await interaction.reply({ embeds: [warn(ctx, "Nothing is playing right now.")], ephemeral: true });
        return;
      }
      const nowMember = interaction.member;
      if (nowMember?.voice?.channelId && nowPlayer.voiceChannelId && nowMember.voice.channelId !== nowPlayer.voiceChannelId) {
        await interaction.reply({ embeds: [warn(ctx, `Join <#${nowPlayer.voiceChannelId}> to control the player.`)], ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      try {
        const replacement = await switchCurrentTrack(ctx, nowPlayer);
        await interaction.editReply({
          embeds: [ok(ctx, `Switched to **${truncate(replacement.info?.title ?? "the track", 70)}** from the selected source.`)],
        });
      } catch (error) {
        const message = error instanceof UserError ? error.message : "That switch didn't go through. Try again.";
        await interaction.editReply({ embeds: [warn(ctx, message)] });
      }
      return;
    }

    // --- source choice (Spotify / YouTube) -----------------------------
    if (interaction.customId.startsWith("gaana:src:")) {
      const key = interaction.customId.slice("gaana:src:".length);
      const choice = SOURCE_CHOICES.find((entry) => entry.key === key);
      const sourcePlayer = getPlayer(ctx, interaction.guildId);

      if (!choice || !sourcePlayer) {
        await interaction.reply({ embeds: [warn(ctx, "Nothing is playing right now.")], ephemeral: true });
        return;
      }

      // Same-channel guard: only listeners of the player's channel may switch.
      const srcMember = interaction.member;
      if (srcMember?.voice?.channelId && sourcePlayer.voiceChannelId && srcMember.voice.channelId !== sourcePlayer.voiceChannelId) {
        await interaction.reply({
          embeds: [warn(ctx, `Join <#${sourcePlayer.voiceChannelId}> to control the player.`)],
          ephemeral: true,
        });
        return;
      }

      setSourceChoice(ctx, sourcePlayer, choice.key);
      // Refresh the card so the selected button highlights immediately. The
      // current track keeps playing; the choice applies to the NEXT search.
      await refreshTrackedMessage(sourcePlayer);
      await interaction.reply({
        embeds: [ok(ctx, `Source set to **${choice.label}** \u2014 upcoming searches will use it.`)],
        ephemeral: true,
      });
      return;
    }

    // --- player control buttons ----------------------------------------
    const player = getPlayer(ctx, interaction.guildId);
    const action = interaction.customId.slice("gaana:".length);
    const member = interaction.member;

    if (!player) {
      await interaction.reply({ embeds: [warn(ctx, "Nothing is playing right now.")], ephemeral: true });
      return;
    }

    // Same-channel guard: only listeners of the player's channel may drive it.
    if (member?.voice?.channelId && player.voiceChannelId && member.voice.channelId !== player.voiceChannelId) {
      await interaction.reply({
        embeds: [warn(ctx, `Join <#${player.voiceChannelId}> to control the player.`)],
        ephemeral: true,
      });
      return;
    }

    switch (action) {
      case "pause":
        if (player.paused) await player.resume();
        else await player.pause();
        await refreshTrackedMessage(player);
        await interaction.reply({
          embeds: [ok(ctx, player.paused ? "Paused." : "Resumed.")],
          ephemeral: true,
        });
        break;

      case "skip":
        if (!player.queue.tracks.length) {
          await player.stopPlaying(false, false);
          await clearNowPlaying(ctx, player);
          await interaction.reply({ embeds: [ok(ctx, "Queue finished.")], ephemeral: true });
        } else {
          await player.skip();
          await interaction.reply({ embeds: [ok(ctx, "Skipped.")], ephemeral: true });
        }
        break;

      case "prev":
        {
          const previous = await player.queue.shiftPrevious();
          if (!previous) {
            await interaction.reply({ embeds: [warn(ctx, "No previous track available.")], ephemeral: true });
          } else {
            await player.play({ clientTrack: previous });
            await interaction.reply({ embeds: [ok(ctx, "Replaying the previous track.")], ephemeral: true });
          }
        }
        break;

      case "stop":
        await player.stopPlaying(true, false);
        await clearNowPlaying(ctx, player);
        if (!is247(ctx, interaction.guildId)) await player.destroy();
        await interaction.reply({ embeds: [ok(ctx, "Stopped and cleared the queue.")], ephemeral: true });
        break;

      case "vol_down":
      case "vol_up":
        {
          const delta = action === "vol_up" ? 10 : -10;
          const next = Math.min(config.maxVolume, Math.max(0, player.volume + delta));
          await player.setVolume(next);
          await refreshTrackedMessage(player);
          await interaction.reply({ embeds: [ok(ctx, `Volume: **${next}%**`)], ephemeral: true });
        }
        break;

      case "loop":
        {
          const cycle = { off: "track", track: "queue", queue: "off" };
          await player.setRepeatMode(cycle[player.repeatMode] ?? "track");
          await refreshTrackedMessage(player);
          await interaction.reply({ embeds: [ok(ctx, `Loop: **${player.repeatMode}**.`)], ephemeral: true });
        }
        break;

      case "shuffle":
        if (player.queue.tracks.length < 2) {
          await interaction.reply({ embeds: [warn(ctx, "Need at least two tracks to shuffle.")], ephemeral: true });
        } else {
          await player.queue.shuffle();
          await interaction.reply({ embeds: [ok(ctx, "Queue shuffled.")], ephemeral: true });
        }
        break;

      case "autoplay":
        {
          const next = !pget(player, "autoplay");
          pset(player, "autoplay", next);
          await refreshTrackedMessage(player);
          await interaction.reply({
            embeds: [ok(ctx, `Autoplay **${next ? "enabled" : "disabled"}**.`)],
            ephemeral: true,
          });
        }
        break;

      default:
        await interaction.reply({ embeds: [info(ctx, "That control isn't wired up.")], ephemeral: true });
    }
  } catch (error) {
    ctx.log.debug("interaction failed:", error?.message);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ embeds: [err(ctx, "That control didn't go through. Try again.")], ephemeral: true })
        .catch(() => {});
    } else if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ embeds: [err(ctx, "That control didn't go through. Try again.")] }).catch(() => {});
    }
  }
});

/** Re-renders the tracked now-playing message after a button press. */
async function refreshTrackedMessage(player) {
  const tracked = pget(player, "nowPlaying");
  const track = player.queue?.current;
  if (!tracked?.messageId || !track) return;
  await postNowPlaying(ctx, player, track, tracked.requesterId ?? null).catch(() => {});
}

/* ---------------------------------------------------------------- events */

client.on("raw", (packet) => lavalink.sendRawData(packet));

lavalink.on("trackStart", async (player, track) => {
  pushHistory(ctx, player.guildId, track);
  // Exactly one card, always: postNowPlaying edits the tracked message when one
  // exists and only sends a new one when there is none. This is what stops the
  // play command and this event from each posting their own card.
  await postNowPlaying(ctx, player, track, track?.requester?.id ?? null).catch((error) =>
    bootLog.debug("could not post now-playing card:", error.message)
  );
});

lavalink.on("trackEnd", async (player) => {
  if (!player.queue.current && !player.queue.tracks.length) {
    await clearNowPlaying(ctx, player).catch(() => {});
  }
});

lavalink.on("trackError", async (player, track, payload) => {
  bootLog.warn(`Track error in ${player.guildId}: ${payload?.exception?.message ?? "unknown"}`);
  const channel = client.channels.cache.get(player.textChannelId);
  if (channel?.isTextBased()) {
    await channel
      .send({ embeds: [warn(ctx, `Couldn't play **${track?.info?.title ?? "that track"}** — skipping it.`)] })
      .catch(() => {});
  }
});

lavalink.on("trackStuck", async (player, track) => {
  bootLog.warn(`Track stuck in ${player.guildId}: ${track?.info?.title ?? "unknown"}`);
  await player.skip().catch(() => {});
});

lavalink.on("queueEnd", async (player) => {
  // Autoplay is handled by onEmptyQueue.autoPlayFunction (configured on the
  // manager). Doing it here as well would queue TWO tracks per empty queue, so
  // this handler only cleans up the card and the idle player.
  await clearNowPlaying(ctx, player).catch(() => {});

  const channel = client.channels.cache.get(player.textChannelId);
  if (channel?.isTextBased() && !is247(ctx, player.guildId)) {
    await channel.send({ embeds: [info(ctx, `Queue finished — add more with \`${ctx.prefixFor(player.guildId)}play\`.`)] }).catch(() => {});
  }

  if (!is247(ctx, player.guildId)) {
    setTimeout(() => {
      const active = getPlayer(ctx, player.guildId);
      if (active && !active.playing && !active.paused && !active.queue.tracks.length) {
        active.destroy().catch(() => {});
      }
    }, 20_000).unref?.();
  }
});

lavalink.on("playerDisconnect", async (player) => {
  await clearNowPlaying(ctx, player).catch(() => {});
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  const guildId = newState.guild?.id;
  if (!guildId) return;

  const player = getPlayer(ctx, guildId);
  if (!player) return;

  // The bot itself was disconnected — drop the player unless 24/7 is on.
  if (oldState.id === client.user.id && !newState.channelId) {
    if (!is247(ctx, guildId)) await player.destroy().catch(() => {});
    return;
  }

  // Everyone left: pause/leave depending on 24/7 mode.
  const channel = oldState.channel;
  if (!channel || channel.id !== player.voiceChannelId) return;

  const humans = channel.members.filter((member) => !member.user.bot).size;
  if (humans > 0) return;

  if (is247(ctx, guildId)) {
    if (!player.paused) await player.pause().catch(() => {});
  } else {
    setTimeout(async () => {
      const stillAlone = channel.members.filter((member) => !member.user.bot).size === 0;
      const active = getPlayer(ctx, guildId);
      if (stillAlone && active) await active.destroy().catch(() => {});
    }, 30_000).unref?.();
  }
});

/* ------------------------------------------------------------- startup UI */

const statusLines = config.activityRotation;
let statusIndex = 0;

/**
 * Premium presence: a rotating activity that alternates between "Listening"
 * (music) and "Watching" (reach), so the bot looks alive and professional
 * without ever spamming the member list. No emoji — clean text only.
 *
 * Rotation pauses while a manual presence is set (see `applyPresence`), so a
 * user's chosen status is never overwritten a minute later.
 */
function rotateStatus() {
  if (rotationPaused) return;
  const line = statusLines[statusIndex % statusLines.length]
    .replaceAll("{prefix}", config.prefix)
    .replaceAll("{servers}", String(client.guilds.cache.size))
    .replaceAll("{commands}", String(commandNames().length))
    .replaceAll("{bot}", config.botName);
  const type = statusIndex % 2 === 0 ? ActivityType.Listening : ActivityType.Watching;
  statusIndex += 1;
  client.user?.setPresence({
    activities: [{ name: line, type }],
    status: "online",
  });
}

// Wire the module-scope presence commands to this boot's client + rotation.
presenceHooks.setPresence = (payload) => client.user?.setPresence(payload);
presenceHooks.rotate = () => rotateStatus();
presenceHooks.isOwner = (userId) => isOwner(userId);

client.once("clientReady", async () => {
  bootLog.info(`Logged in as ${client.user.tag} — ${commandNames().length} prefix commands loaded`);

  const maintenance = client.guilds.cache.filter((guild) =>
    guild.members.me?.permissions.has(PermissionFlagsBits.Connect) === false
  );
  if (maintenance.size) bootLog.warn(`${maintenance.size} guild(s) are missing the Connect permission.`);

  try {
    await lavalink.init({ id: client.user.id, username: config.botName });
    bootLog.info("Lavalink manager initialised.");
  } catch (error) {
    bootLog.error("Lavalink init failed:", error.message);
  }

  if (config.registerSlashCommands) {
    try {
      await registerSlashCommands(client, ctx);
      bootLog.info(`${slashCommandNames().length} slash commands available.`);
    } catch (error) {
      bootLog.error("Slash command registration failed:", error.message);
    }
  }

  rotateStatus();
  setInterval(rotateStatus, 60_000).unref?.();
  startProgressTicker(ctx);

  // Reconnect any 24/7 players after a restart.
  for (const guild of client.guilds.cache.values()) {
    if (!is247(ctx, guild.id)) continue;
    const me = guild.members.me;
    if (me?.voice?.channelId) {
      const player = getPlayer(ctx, guild.id) ?? (await getOrCreatePlayer(ctx, guild, me.voice.channel, null, client.user).catch(() => null));
      if (player && !player.connected) await player.connect().catch(() => {});
    }
  }
});

client.on("guildCreate", async (guild) => {
  // Welcome message to the owner's DM, falling back to a usable channel.
  try {
    const embed = card(ctx, {
      color: COLOR.accent,
      author: `${config.botName} • Welcome`,
      title: `Thanks for adding ${config.botName}`,
      description:
        `A premium music experience — prefix **and** slash commands.\n\n` +
        `\`\`\`\n${config.prefix}play <song>   start the music\n${config.prefix}queue         interactive queue\n${config.prefix}help          every command\n\`\`\`\n` +
        `Join a voice channel, then run \`${config.prefix}play\`. Slash commands work too — just type \`/\`.`,
      thumbnail: client.user.displayAvatarURL({ size: 256 }),
      url: config.supportServerUrl || null,
      footer: `${config.botName} • ${commandNames().length} commands • prefix ${config.prefix}`,
    });

    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) {
      const sent = await owner.send({ embeds: [embed] }).catch(() => null);
      if (sent) return;
    }

    const channel = guild.channels.cache.find(
      (candidate) =>
        candidate.isTextBased() &&
        candidate.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)
    );
    if (channel) await channel.send({ embeds: [embed] }).catch(() => {});
  } catch (error) {
    bootLog.debug("welcome message failed:", error.message);
  }
});

/* ------------------------------------------------------------------- boot */

client.login(config.token).catch((error) => {
  bootLog.error("Discord login failed:", error.message);
  bootLog.error("Check that config.json \"token\" holds a valid, non-expired bot token.");
  process.exit(1);
});

/* -------------------------------------------------- graceful shutdown */

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    bootLog.info(`${signal} received — shutting down.`);
    for (const store of Object.values(stores)) store.flush();
    await lavalink.nodeManager.disconnectAll(false, true).catch(() => {});
    client.destroy();
    server.close();
    process.exit(0);
  });
}
}

/* ==========================================================================
 * deploy-commands (single-file)
 * ========================================================================== */

async function deployCommands() {
  const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "config.json");
  const cfg = loadConfig(configPath);
  const data = buildSlashCommands();
  const explicitGuild = process.argv.find((arg) => /^\d{17,20}$/.test(arg));
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  await new Promise((resolve, reject) => {
    client.once("clientReady", async () => {
      try {
        if (explicitGuild) {
          await client.application.commands.set([]).catch(() => {});
          const guild = await client.guilds.fetch(explicitGuild);
          await guild.commands.set(data);
          console.log(`Registered ${data.length} commands in guild ${guild.name} (${explicitGuild}) — guild scope only.`);
        } else {
          for (const guild of client.guilds.cache.values()) await guild.commands.set([]).catch(() => {});
          await client.application.commands.set(data);
          console.log(`Registered ${data.length} global commands (may take up to 1 hour to appear) — global scope only.`);
        }
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        client.destroy();
      }
    });
    client.login(cfg.token).catch(reject);
  });
}

/* ==========================================================================
 * self-test (node index.js --check)
 * ========================================================================== */

async function runSelfTest() {
  const assert = (await import("node:assert/strict")).default;
  let passed = 0;
  const failures = [];
  const test = async (name, fn) => {
    try { await fn(); passed += 1; }
    catch (error) { failures.push(name + "\n    " + String(error.stack || error.message).split("\n").slice(0, 3).join("\n    ")); }
  };

  const fakeTrack = (o = {}) => ({
    info: { identifier: "dQw4w9WgXcQ", title: "Never Gonna Give You Up", author: "Rick Astley", duration: 213000,
      artworkUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      sourceName: "youtube", isSeekable: true, isStream: false, ...(o.info || {}) },
    requester: { id: "111111111111111111", username: "tester" }, ...o,
  });
  const makeQueue = (tracks = [fakeTrack()], current = fakeTrack()) => {
    const list = [...tracks];
    return { tracks: list, previous: [], current,
      async add(t, i) { typeof i === "number" ? list.splice(i, 0, t) : list.push(t); return list.length; },
      async splice(i, n, r) { if (r) { const it = Array.isArray(r) ? r : [r]; return list.splice(i, n, ...it); }
        const s = list.splice(i, n); return s.length === 1 ? s[0] : s; },
      async shuffle() { list.reverse(); return list.length; }, async shiftPrevious() { return null; } };
  };
  const makeFilterManager = () => ({ data: {}, async resetFilters() {}, async applyPlayerFilters() {}, async setEQPreset() {},
    async setEQ() {}, async setSpeed() {}, async setPitch() {}, async setRate() {}, async toggleNightcore() {}, async toggleVaporwave() {},
    async toggleRotation() {}, async toggleKaraoke() {}, async toggleVibrato() {}, async toggleTremolo() {}, async toggleLowPass() {},
    lavalinkLavaDspxPlugin: { async toggleHighPass() {}, async toggleNormalization() {} } });
  const makePlayer = (o = {}) => {
    const store = new Map();
    const p = { guildId: "999999999999999999", voiceChannelId: "222222222222222222", textChannelId: "333333333333333333",
      playing: true, paused: false, connected: true, volume: 80, repeatMode: "off", position: 30000, queue: makeQueue(), filterManager: makeFilterManager(),
      setData(k, v) { store.set(k, v); return this; }, getData(k) { return store.get(k); },
      async connect() { return this; }, async play() { this.playing = true; return this; }, async pause() { this.paused = true; return this; },
      async resume() { this.paused = false; return this; }, async seek(ms) { this.position = ms; return this; },
      async skip() { this.queue.current = this.queue.tracks.shift() ?? null; return this; }, async setRepeatMode(m) { this.repeatMode = m; return this; },
      async setVolume(v) { this.volume = v; return this; }, async stopPlaying() { this.playing = false; return this; },
      async destroy() { this.destroyed = true; return this; }, async changeVoiceState() { return this; },
      async search() { return { loadType: "track", exception: null, playlist: null, tracks: [fakeTrack(), fakeTrack({ info: { ...fakeTrack().info, title: "Second", identifier: "abc" } })] }; },
      async getCurrentLyrics() { return { text: "Never gonna give you up", lines: [] }; }, ...o };
    return p;
  };
  const makeStores = (seed = {}) => {
    const map = (init) => { const d = { ...init }; return { get: (k, f) => (k in d ? d[k] : f), set: (k, v) => { d[k] = v; return v; },
      delete: (k) => { delete d[k]; return true; }, flush: () => true, all: () => d, keys: () => Object.keys(d) }; };
    return { prefixes: map(seed.prefixes || {}), languages: map({}), stay247: map(seed.stay247 || {}), favorites: map(seed.favorites || {}),
      playlists: map(seed.playlists || {}), queuesaves: map(seed.queuesaves || {}), history: map(seed.history || {}), settings: map({}) };
  };
  const makeMessage = ({ member = {}, guild = {}, channel = {} } = {}) => {
    const replies = [];
    const g = { id: "999999999999999999", name: "Test Guild", members: { me: { id: "bot" } }, ...guild };
    return { content: "", guildId: "999999999999999999", guild: g,
      member: { id: "111111111111111111", guild: g, permissions: { has: () => true },
        voice: { channel: { id: "222222222222222222", name: "Music", permissionsFor: () => ({ has: () => true }) }, channelId: "222222222222222222" }, ...member },
      author: { id: "111111111111111111", username: "tester", tag: "tester#0001", bot: false },
      channel: { id: "333333333333333333", isTextBased: () => true,
        send: async (p) => { replies.push(p); return { id: "msg", channelId: "333333333333333333", edit: async () => {} }; },
        sendTyping: async () => {}, ...channel },
      createdTimestamp: Date.now() - 25,
      async reply(p) { replies.push(p); return { id: "reply", channelId: "333333333333333333", createdTimestamp: Date.now(), edit: async () => {} }; },
      replies };
  };
  const makeCtx = (player = makePlayer(), stores = makeStores()) => {
    const players = new Map(); if (player) players.set("999999999999999999", player);
    const presenceCalls = [];
    return { client: { user: { id: "bot", username: "Gaana", displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png",
          setPresence: (p) => { presenceCalls.push(p); return p; } },
        ws: { ping: 42 }, users: { fetch: async () => ({ send: async () => {} }) },
        guilds: { cache: new Map([["999999999999999999", { id: "999999999999999999" }]]) }, channels: { cache: new Map() } },
      presenceCalls,
      lavalink: { players, getPlayer: (id) => players.get(id), createPlayer: () => player,
        nodeManager: { leastUsedNodes: () => [{ options: { id: "main" }, isAlive: true, stats: { playingPlayers: 3, uptime: 3600000, cpu: { lavalinkLoad: 0.12 }, memory: { used: 128 * 1024 * 1024 } } }] } },
      config: { botName: "Gaana", prefix: "?", embedColor: parseColor("#f1b2c1"), defaultVolume: 80, maxVolume: 150, maxQueueSize: 1000,
        defaultSearchSource: "ytsearch", sourceChoice: "youtube", sources: { youtube: true, soundcloud: true, spotify: true, applemusic: true, deezer: true }, emojis: {},
        presence: { defaultStreamUrl: "https://www.twitch.tv/gaana", defaultStreamText: "Gaana Radio", defaultActivityType: "listening" },
        stayInVoiceByDefault: false, supportServerUrl: "https://discord.gg/example", voteUrl: "https://top.gg/bot/example", developerIds: [], slashGuildIds: [] },
      icons: buildIcons(), stores, log: { debug() {}, info() {}, warn() {}, error() {} },
      prefixFor: (g) => stores.prefixes.get(g, "?") || "?", setPrefix: (g, v) => stores.prefixes.set(g, v) };
  };
  const run = async (name, ctx, message, args = []) => {
    const command = getCommand(name); assert.ok(command, "command " + name + " is not registered");
    try { await command.run(ctx, message, args); return { status: "ok", replies: message.replies }; }
    catch (error) { if (error instanceof UserError) return { status: "usererror", message: error.message, replies: message.replies }; throw error; }
  };

  await test("clock / parseTimestamp / truncate / clamp", () => {
    assert.equal(clock(65000), "1:05"); assert.equal(clock(3725000), "1:02:05");
    assert.equal(parseTimestamp("83"), 83000); assert.equal(parseTimestamp("1:23"), 83000); assert.equal(parseTimestamp("bogus"), null);
    assert.ok(truncate("x".repeat(100), 20).length <= 20); assert.equal(clamp(5, 0, 3, 0), 3);
  });
  await test("parseColor handles hex and invalid input", () => {
    assert.equal(parseColor("#5865F2"), 0x5865f2); assert.equal(parseColor("nope", 0x111111), 0x111111);
  });
  await test("sourceFromUrl + resolveQuery map links to sources", () => {
    assert.equal(sourceFromUrl("https://open.spotify.com/track/abc").source, "spotify");
    assert.equal(sourceFromUrl("https://youtu.be/abc").source, "youtube");
    assert.equal(sourceFromUrl("lofi beats"), null);
    const cfg = { defaultSearchSource: "ytsearch", sources: { spotify: true } };
    assert.equal(resolveQuery("https://open.spotify.com/track/abc", cfg).source, "spotify");
    assert.equal(resolveQuery("kesariya", cfg).source, "ytsearch");
  });
  await test("every default button icon is a valid Discord emoji", () => {
    const icons = buildIcons();
    for (const k of ["play", "pause", "stop", "skip", "previous", "loop", "shuffle", "volume", "autoplay", "first", "prevPage", "nextPage", "last", "spotify", "youtube", "switchNow"])
      assert.equal(isEmoji(icons[k]), true, "button icon " + k + " is not a valid emoji");
    assert.equal(isEmoji("\u2726"), false);
    // No cheap coloured-circle emoji anywhere in the default icon set.
    for (const v of Object.values(icons)) assert.ok(!["\u{1F7E2}", "\u{1F534}", "\u{1F7E1}", "\u{1F535}"].includes(v), "coloured circle emoji leaked: " + v);
  });
  await test("registry loads every required command", () => {
    const required = ["play","pause","resume","skip","stop","queue","loop","shuffle","seek","volume","nowplaying","lyrics","filter","autoplay","jump","remove","move","clear","disconnect","247","help","search","playlist","favorites","like","unlike","likeall","playfavorites","trackinfo","artistinfo","grab","history","queuesave","queuerestore","dedupe","sort","removerange","equalizer","speed","pitch","rate","forward","rewind","replay","previous","join","prefix","source","ping","stats","uptime","invite","support","vote","nodeinfo","shardinfo"];
    for (const n of required) assert.ok(getCommand(n), "missing command: " + n);
    assert.ok(commandNames().length >= 50, "only " + commandNames().length + " commands");
  });
  await test("every command has metadata and aliases resolve", () => {
    for (const c of new Set(commands.values())) { assert.ok(c.name && c.category && c.usage && c.description, c.name + " missing metadata"); assert.equal(typeof c.run, "function"); }
    assert.equal(getCommand("p").name, "play"); assert.equal(getCommand("np").name, "nowplaying"); assert.equal(getCommand("grab").name, "grab");
  });
  await test("slash names are unique and map to prefix commands", () => {
    const names = slashCommandNames(); const seen = new Set();
    for (const n of names) { assert.ok(!seen.has(n), "duplicate slash command: " + n); seen.add(n); assert.ok(getCommand(n), "slash /" + n + " has no prefix command"); }
    const data = buildSlashCommands();
    for (const e of data) { assert.ok(/^[a-z0-9_-]{1,32}$/.test(e.name)); assert.ok(e.description && e.description.length <= 100); assert.equal(e.type, 1); }
    assert.equal(data.find((e) => e.name === "play").options[0].type, 3);
    assert.equal(data.find((e) => e.name === "volume").options[0].type, 4);
  });
  await test("registerSlashCommands registers in exactly ONE scope", async () => {
    const globalSets = []; const guildSets = [];
    const client = { application: { commands: { set: async (d) => { globalSets.push(d); } } },
      guilds: { cache: new Map([["999999999999999999", { id: "999999999999999999", commands: { set: async (d) => { guildSets.push(d); } } }]]), fetch: async () => null } };
    const ctx = makeCtx(); ctx.config.slashGuildIds = [];
    await registerSlashCommands(client, ctx);
    assert.equal(globalSets.length, 1); assert.equal(guildSets.length, 0);
    await registerSlashCommands(client, ctx);
    assert.equal(globalSets.length, 1);
  });
  await test("help renders every category and its menu carries no emoji", () => {
    const ctx = makeCtx();
    for (const cat of ["Overview","Playback","Queue","Audio","Filters","Favorites","Playlist","Settings","Utility","Info"]) {
      const page = buildHelpPage(ctx, "999999999999999999", cat);
      assert.ok(page.embeds[0].toJSON().title, cat + " page has no title");
    }
    const row = buildHelpPage(ctx, "999999999999999999", "Overview").components[0].toJSON();
    for (const o of row.components[0].options) assert.equal(o.emoji, undefined);
  });
  await test("postNowPlaying never stacks a second card", async () => {
    const ctx = makeCtx(); const player = ctx.lavalink.getPlayer("999999999999999999");
    const sent = []; const edits = [];
    ctx.client.channels.cache.set("333333333333333333", { id: "333333333333333333", isTextBased: () => true,
      send: async (p) => { sent.push(p); return { id: "m" + sent.length, channelId: "333333333333333333", edit: async (n) => { edits.push(n); } }; },
      messages: { fetch: async (id) => (sent.length ? { id, edit: async (n) => { edits.push(n); } } : null) } });
    await postNowPlaying(ctx, player, player.queue.current, "111111111111111111");
    await postNowPlaying(ctx, player, player.queue.current, "111111111111111111");
    assert.equal(sent.length, 1); assert.ok(edits.length >= 1);
  });
  await test("source-choice buttons: two buttons, selected disabled, bad key safe", async () => {
    const ctx = makeCtx(); const player = ctx.lavalink.getPlayer("999999999999999999");
    // Config default is "youtube" -> YouTube starts selected (disabled), Spotify clickable.
    let row = sourceChoiceComponents(ctx, player)[0].toJSON();
    assert.equal(row.components.length, 3);
    assert.equal(row.components[0].custom_id, "gaana:src:spotify");
    assert.equal(row.components[1].custom_id, "gaana:src:youtube");
    assert.equal(row.components[2].custom_id, "gaana:srcnow");
    assert.equal(row.components[2].disabled, false); // a track is playing -> switch-now enabled
    assert.equal(row.components[0].disabled, false);
    assert.equal(row.components[1].disabled, true);
    // Selecting Spotify disables + highlights it, leaves YouTube clickable.
    setSourceChoice(ctx, player, "spotify");
    row = sourceChoiceComponents(ctx, player)[0].toJSON();
    assert.equal(row.components[0].disabled, true);
    assert.equal(row.components[0].style, 3); // ButtonStyle.Success
    assert.equal(row.components[1].disabled, false);
    assert.equal(row.components[1].style, 2); // ButtonStyle.Secondary
    assert.equal(getSourceChoice(ctx, player), "spotify");
    // Persisted to the guild store so it survives a new card / restart.
    assert.equal(ctx.stores.settings.get("999999999999999999").sourceChoice, "spotify");
    // An unknown key is ignored, never crashes.
    assert.equal(setSourceChoice(ctx, player, "bogus"), null);
    // The Now Playing payload carries the source row as its LAST row (3 total).
    const payload = nowPlayingPayload(ctx, player, player.queue.current, "111111111111111111");
    assert.equal(payload.components.length, 3);
    assert.equal(payload.components[2].toJSON().components[0].custom_id, "gaana:src:spotify");
    // With nothing playing, switch-now is disabled (nothing to re-resolve).
    const idle = makePlayer({ queue: makeQueue([], null) });
    const idleRow = sourceChoiceComponents(ctx, idle)[0].toJSON();
    assert.equal(idleRow.components[2].custom_id, "gaana:srcnow");
    assert.equal(idleRow.components[2].disabled, true);
  });
  await test("ensureVoiceConnected retries then reports failure instead of hanging", async () => {
    // A player that never confirms: must return false (not throw, not hang).
    let connects = 0;
    const dead = { connected: false, async connect() { connects += 1; return this; } };
    const ok = await ensureVoiceConnected(dead, { attempts: 2, waitMs: 50 });
    assert.equal(ok, false);
    assert.equal(connects, 2);
    // A player that confirms on the first check returns true immediately.
    const live = { connected: true, async connect() { return this; } };
    assert.equal(await ensureVoiceConnected(live, { attempts: 2, waitMs: 50 }), true);
  });
  await test("source fallback walks ytsearch -> spsearch -> ytmsearch, never soundcloud", async () => {
    const calls = [];
    const player = makePlayer({ async search(q) {
      calls.push(q.source);
      // First source (the requested one) returns nothing; the second works.
      if (calls.length === 1) return { loadType: "empty", exception: null, playlist: null, tracks: [] };
      return { loadType: "track", exception: null, playlist: null, tracks: [fakeTrack()] };
    } });
    const ctx = makeCtx(player);
    setSourceChoice(ctx, player, "spotify");
    const result = await search(ctx, player, "kesariya", { id: "1" });
    assert.ok(result.tracks.length);
    assert.equal(calls[0], "spsearch");
    assert.ok(calls.includes("ytsearch"));
    assert.ok(!calls.includes("scsearch"), "must never fall back to the broken soundcloud source");
  });
  await test("switchCurrentTrack re-resolves the current track on the chosen source", async () => {
    const calls = [];
    const played = [];
    const player = makePlayer({
      async search(q) { calls.push(q); return { loadType: "track", exception: null, playlist: null, tracks: [fakeTrack({ info: { ...fakeTrack().info, title: "Kesariya" } })] }; },
      async play(o) { played.push(o); this.playing = true; return this; },
    });
    const ctx = makeCtx(player);
    setSourceChoice(ctx, player, "spotify");
    const replacement = await switchCurrentTrack(ctx, player);
    assert.equal(calls[0].source, "spsearch");
    assert.ok(calls[0].query.includes("Never Gonna Give You Up"));
    assert.equal(played.length, 1);
    assert.equal(played[0].clientTrack.info.title, "Kesariya");
    assert.equal(replacement.info.title, "Kesariya");
  });
  await test("search honours the chosen source for plain text, links keep theirs", async () => {
    const calls = [];
    const player = makePlayer({ async search(q) { calls.push(q); return { loadType: "track", exception: null, playlist: null, tracks: [fakeTrack()] }; } });
    const ctx = makeCtx(player);
    setSourceChoice(ctx, player, "spotify");
    await search(ctx, player, "kesariya", { id: "1" });
    assert.equal(calls[0].source, "spsearch");
    await search(ctx, player, "https://open.spotify.com/track/abc", { id: "1" });
    assert.equal(calls[1].source, "spotify");
    setSourceChoice(ctx, player, "youtube");
    await search(ctx, player, "kesariya", { id: "1" });
    assert.equal(calls[2].source, "ytsearch");
  });
  await test("queue page shows totals, requester and 5 pager buttons", () => {
    const tracks = Array.from({ length: 23 }, (_, i) => fakeTrack({ info: { ...fakeTrack().info, title: "Track " + (i + 1), identifier: "id" + i }, requester: { id: "111111111111111111" } }));
    const player = makePlayer({ queue: makeQueue(tracks) }); const ctx = makeCtx(player);
    const payload = buildQueuePage(ctx, player, 2); const embed = payload.embeds[0].toJSON();
    assert.ok(embed.footer.text.includes("page 2/3")); assert.ok(embed.footer.text.includes("23 tracks"));
    assert.ok(embed.fields[0].value.includes("<@111111111111111111>"));
    assert.equal(payload.components[0].components.length, 5);
    assert.equal(payload.components[0].components[2].data.label, "Page 2/3");
  });
  await test("nowplaying renders the compact minimal card", async () => {
    const ctx = makeCtx(); const result = await run("nowplaying", ctx, makeMessage());
    assert.equal(result.status, "ok"); const embed = result.replies[0].embeds[0].toJSON();
    assert.equal(embed.thumbnail, undefined); assert.equal(embed.fields, undefined);
    assert.ok(!embed.description.includes("\u25c9")); assert.ok(embed.author.name.includes("Gaana"));
    assert.ok(embed.description.includes("Never Gonna Give You Up")); assert.equal(embed.color, 0xf1b2c1);
  });
  await test("remove/move survive a single-track splice return", async () => {
    const tracks = ["A","B","C"].map((t) => fakeTrack({ info: { ...fakeTrack().info, title: t } }));
    const p1 = makePlayer({ queue: makeQueue(tracks) }); const c1 = makeCtx(p1);
    assert.equal((await run("remove", c1, makeMessage(), ["2"])).status, "ok");
    assert.deepEqual(p1.queue.tracks.map((t) => t.info.title), ["A","C"]);
    const p2 = makePlayer({ queue: makeQueue(tracks) }); const c2 = makeCtx(p2);
    assert.equal((await run("move", c2, makeMessage(), ["1","3"])).status, "ok");
    assert.deepEqual(p2.queue.tracks.map((t) => t.info.title), ["B","C","A"]);
  });
  await test("skip <n> passes the index through", async () => {
    const tracks = ["A","B","C","D"].map((t) => fakeTrack({ info: { ...fakeTrack().info, title: t } }));
    const calls = [];
    const player = makePlayer({ queue: makeQueue(tracks), async skip(skipTo = 0) { calls.push(skipTo); if (skipTo > 1) player.queue.tracks.splice(0, skipTo - 1); player.queue.current = player.queue.tracks.shift() ?? null; return player; } });
    const ctx = makeCtx(player);
    assert.equal((await run("skip", ctx, makeMessage(), ["2"])).status, "ok");
    assert.deepEqual(calls, [2]); assert.equal(player.queue.current.info.title, "B");
  });
  await test("happy paths: play, volume, seek, loop, filters, favorites, playlist", async () => {
    const ctx = makeCtx(makePlayer({ playing: false }));
    assert.equal((await run("play", ctx, makeMessage(), ["lofi","beats"])).status, "ok");
    assert.equal((await run("volume", ctx, makeMessage(), ["999"])).status, "ok");
    assert.equal((await run("seek", ctx, makeMessage(), ["1:00"])).status, "ok");
    assert.equal((await run("loop", ctx, makeMessage())).status, "ok");
    for (const preset of FILTER_NAMES) assert.equal((await run("filter", ctx, makeMessage(), [preset])).status, "ok", "filter " + preset + " failed");
    assert.equal((await run("like", ctx, makeMessage())).status, "ok");
    assert.equal((await run("favorites", ctx, makeMessage())).status, "ok");
    assert.equal((await run("playlist", ctx, makeMessage(), ["save","chill"])).status, "ok");
    assert.equal((await run("playlist", ctx, makeMessage(), ["load","chill"])).status, "ok");
  });
  await test("commands fail gracefully with no active player", async () => {
    const ctx = makeCtx(null);
    for (const n of ["pause","resume","skip","stop","queue","loop","shuffle","volume","seek","filter","clear","jump","dedupe","sort","removerange","trackinfo","artistinfo","grab","queuesave","speed","pitch","rate","equalizer"])
      assert.equal((await run(n, ctx, makeMessage(), ["1"])).status, "usererror", n + " should raise a UserError with no player");
  });
  await test("input validation rejects bad values", async () => {
    const ctx = makeCtx();
    assert.equal((await run("play", ctx, makeMessage(), [])).status, "usererror");
    assert.equal((await run("volume", ctx, makeMessage(), ["loud"])).status, "usererror");
    assert.equal((await run("seek", ctx, makeMessage(), ["99:99"])).status, "usererror");
    assert.equal((await run("speed", ctx, makeMessage(), ["9"])).status, "usererror");
    assert.equal((await run("filter", ctx, makeMessage(), ["nonsense"])).status, "usererror");
  });
  await test("presence: status/stream/activity set, validate and clear", async () => {
    const ctx = makeCtx();
    presenceHooks.setPresence = (p) => ctx.presenceCalls.push(p);
    presenceHooks.rotate = () => {};
    presenceHooks.isOwner = (id) => ctx.config.developerIds.includes(id);
    // status <text> -> custom activity applied, rotation paused
    assert.equal((await run("status", ctx, makeMessage(), ["Chilling", "with", "Gaana"])).status, "ok");
    assert.equal(describePresence().key, "custom");
    assert.equal(describePresence().text, "Chilling with Gaana");
    assert.equal(rotationPaused, true);
    assert.ok(ctx.presenceCalls.length >= 1);
    assert.equal(ctx.presenceCalls.at(-1).activities[0].name, "Chilling with Gaana");
    // status with no args -> shows current, no crash
    assert.equal((await run("status", ctx, makeMessage(), [])).status, "ok");
    // stream <text> <url> -> streaming activity carries the url
    assert.equal((await run("stream", ctx, makeMessage(), ["Live", "now", "https://twitch.tv/gaana"])).status, "ok");
    assert.equal(describePresence().key, "streaming");
    assert.equal(describePresence().url, "https://twitch.tv/gaana");
    assert.equal(ctx.presenceCalls.at(-1).activities[0].url, "https://twitch.tv/gaana");
    // stream with no url -> falls back to the configured default
    assert.equal((await run("stream", ctx, makeMessage(), ["Just", "chatting"])).status, "ok");
    assert.equal(describePresence().url, "https://www.twitch.tv/gaana");
    // activity <type> <text>
    assert.equal((await run("activity", ctx, makeMessage(), ["watching", "the", "queue"])).status, "ok");
    assert.equal(describePresence().key, "watching");
    // clear -> override gone, rotation resumes
    assert.equal((await run("status", ctx, makeMessage(), ["clear"])).status, "ok");
    assert.equal(describePresence(), null);
    assert.equal(rotationPaused, false);
  });
  await test("presence: rejects bad type, oversized text and bad stream url", async () => {
    const ctx = makeCtx();
    presenceHooks.setPresence = (p) => ctx.presenceCalls.push(p);
    presenceHooks.rotate = () => {};
    presenceHooks.isOwner = (id) => ctx.config.developerIds.includes(id);
    assert.equal((await run("activity", ctx, makeMessage(), ["dancing", "now"])).status, "usererror");
    assert.equal((await run("activity", ctx, makeMessage(), ["playing"])).status, "usererror");
    assert.equal((await run("status", ctx, makeMessage(), ["x".repeat(200)])).status, "usererror");
    assert.equal((await run("stream", ctx, makeMessage(), ["Live", "ftp://twitch.tv/gaana"])).status, "usererror");
    assert.equal(describePresence(), null);
  });
  await test("presence: non-admin is refused, developer is allowed", async () => {
    const ctx = makeCtx();
    presenceHooks.setPresence = (p) => ctx.presenceCalls.push(p);
    presenceHooks.rotate = () => {};
    presenceHooks.isOwner = (id) => ctx.config.developerIds.includes(id);
    const plain = makeMessage({ member: { permissions: { has: () => false } } });
    assert.equal((await run("status", ctx, plain, ["nope"])).status, "usererror");
    assert.equal(describePresence(), null);
    // A configured developer bypasses the permission check.
    ctx.config.developerIds = ["111111111111111111"];
    assert.equal((await run("status", ctx, plain, ["dev", "status"])).status, "ok");
    assert.equal(describePresence().text, "dev status");
    clearPresence();
  });

  console.log("\n  Gaana — offline self-test\n");
  console.log("  " + passed + " passed");
  if (failures.length) {
    console.log("  " + failures.length + " failed\n");
    for (const f of failures) console.log("  x " + f + "\n");
    throw new Error(failures.length + " self-test(s) failed");
  }
  console.log("\n  All checks passed.\n");
}

/* Run the bot only when this file is executed directly (node index.js). */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) boot();
