# 🎵 Gaana

**A production-ready Discord music bot — dark minimalist UI, prefix *and* slash commands, interactive queue pagination, multi-source playback (YouTube, Spotify, SoundCloud, Apple Music, Deezer) and Lavalink-backed playback.**

Built for real servers: one consistent premium embed style, full queue control, 25 audio filters, playlists, favorites, autoplay, 24/7 mode and graceful error handling.

> Upload → paste your token → go live. No coding required.

---

## Table of contents

- [What's new in v7.0](#whats-new-in-v70)
- [Features](#features)
- [Quick start (obsdn / any Node host)](#quick-start-obsdn--any-node-host)
- [Slash commands](#slash-commands)
- [Configuration](#configuration)
- [Spotify Support (LavaSrc plugin)](#spotify-support-lavasrc-plugin)
- [Commands](#commands)
- [Project structure](#project-structure)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Production notes](#production-notes)

---

## What's new in v7.0

### Bot presence control — `status`, `stream`, `activity`

- **Three new commands (prefix **and** slash)** to set the bot's own status:
  - `?status <text>` / `/status` — a custom (plain-text) status. No argument shows the current one.
  - `?stream <text> [url]` / `/stream` — a **STREAMING** activity with the purple LIVE badge. Omit the URL and it uses `config.json` → `presence.defaultStreamUrl`.
  - `?activity <type> <text>` / `/activity` — any type: `playing`, `streaming`, `listening`, `watching`, `competing`, `custom`.
- **`clear` resets it.** `?status clear` (or `?activity clear` / `?stream clear`) removes the manual status and the rotating status resumes.
- **Rotation pauses while a manual status is set**, so your choice is never overwritten a minute later — and resumes the moment you clear it. Predictable, no surprises.
- **Permission-guarded.** Only members with **Manage Server** (or a configured `developerIds` entry) can change the bot's status; everyone else gets a clear refusal.
- **Validated input.** Activity text is capped at Discord's 128-character limit, an unknown type is rejected with the list of valid ones, and a streaming status requires a real `http(s)` URL.
- **This is the bot's own presence** (`client.user.setPresence`) — never a user account, and no user token is ever involved.

### What was in v6.0

### Playback reliability — the "card shows but no audio" fix

- **Root cause found and fixed.** The bot could show a Now Playing card while the node never actually received the voice handshake, so it sat silently connected-but-mute. Gaana now **verifies the voice connection** after `connect()` and, if the node does not confirm within a few seconds, retries once and then tells the user plainly instead of failing silently.
- **Automatic source fallback.** If the requested source returns nothing (a source can be missing, rate-limited, or simply broken on a node — SoundCloud is a common casualty), Gaana walks a fallback chain — **`ytsearch` → `spsearch` → `ytmsearch`** — and plays the first that works. SoundCloud is deliberately excluded from the chain because it is broken on many shared nodes. If every source fails, the user gets a clear ephemeral error — never a silent no-op.
- **Every failure is surfaced.** Search errors, track errors, stuck tracks and voice-join failures all log to the console *and* post a short message to the channel, so nothing fails quietly.

### Mid-track source switch — "Switch now"

- **A third button on the source row: `Switch now`.** The two source buttons (Spotify / YouTube) still only steer the **next** search. `Switch now` is the explicit opt-in for an **instant** change: it re-resolves the **currently playing** track through the selected source and restarts it immediately.
- **Predictable and safe.** `Switch now` is disabled when nothing is playing. It is author/channel-guarded like every other control, defers the reply (the search can exceed Discord's 3-second window), and reports the new track — or a clear error if the source has no match.
- **No cheap coloured circles.** The old 🟢/🔴 source icons are gone. The defaults are clean, recognisable glyphs (🎧 Spotify, ▶️ YouTube, 🔁 Switch now); drop in your own brand emoji via `config.json` → `emojis`.

### What was in v5.0

### Source choice — Spotify or YouTube, live from the card

- **Two source buttons on the Now Playing card.** Below the playback controls sits a dedicated row with a **Spotify** and a **YouTube** button. The active source is highlighted (green) and disabled; the other is clickable. Tap it to switch.
- **The choice is remembered per server.** It is stored in the runtime store, so every new Now Playing card shows the same selection — and it survives a restart.
- **It steers plain-text searches only.** With Spotify selected, `?play kesariya` searches Spotify (`spsearch`); with YouTube selected it searches YouTube (`ytsearch`). A **pasted link always keeps its own source** — a Spotify link still goes to Spotify, a SoundCloud link to SoundCloud.
- **The current track is never interrupted** by the source buttons — they apply to the **next** search. Use **`Switch now`** for an instant mid-track change. The card refreshes in place so the highlight updates immediately.
- **Also available as a command** — `?source` / `/source` shows the current source and lets you set it (`?source spotify`, `?source youtube`), even with nothing playing.
- **Custom brand icons** — set `config.json` → `emojis.spotify` / `emojis.youtube` to your own emoji (e.g. `<:spotify:123456789012345678>`). The built-in fallback is a clean glyph (🎧 / ▶️) — never a coloured circle. Every icon is validated at load time, so a bad glyph can never break the payload.

### Single-file flat build

- **Everything in one `index.js`** — config loader, logger, formatting, theme/embed builders, stores, Lavalink logic, all prefix commands, slash commands, interactive components and boot code. No folders, no subfolders: GitHub's web/phone uploader accepts it as-is.
- **59 commands** (prefix **and** slash), the ultra-compact Now Playing card, interactive queue pagination, 25 filters and multi-source playback all intact.
- **25 offline checks** — including new regression tests for the source-choice buttons (selected state, persistence, unknown-key safety), the source-aware search path, the source fallback chain, the mid-track `Switch now` re-resolve, and the presence commands (set / validate / clear / permission guard).

### What was in v4.0

- **Multi-source playback** — YouTube, SoundCloud, **Spotify**, **Apple Music**, Deezer, Yandex Music, Twitch, Vimeo and Bandcamp. Gaana names the right source for each recognised link; a node with the **LavaSrc** plugin then resolves Spotify/Apple/Deezer natively. If Lavalink returns nothing, Gaana retries once as a text search built from the link — a best-effort safety net, not a substitute for LavaSrc ([details](#about-the-automatic-fallback--and-its-limit)). Toggle any source in `config.json` → `sources`.
- **Ultra-compact Now Playing card** — the hero embed is deliberately tiny: just the track, artist, duration and requester. No artwork, no progress bar, no field grid.
- **Decluttered, premium icons** — decorative emoji are gone. Text uses a few clean monochrome glyphs; buttons use real, valid emoji. Every icon is validated at load time.
- **Lavalink credentials pre-filled** — `config.json` ships with the node already configured; you only need to paste your Discord bot token.

### What was in v3.0

- **Dark minimalist UI** — every embed (Now Playing, queue, help, errors, info, favorites, playlists, track info, filters) shares one design system: a soft-rose accent, compact field grids, small text and a consistent brand footer. Nothing is oversized; every field is validated against Discord's hard limits.
- **Fixed: duplicate Now Playing cards** — the `play` command and the `trackStart` event used to each post a card. Both now go through a single `postNowPlaying()` entry point with a per-player lock, so a card already on screen is *edited*, never stacked. Repeat / skip / volume / seek / autoplay refresh the same card.
- **Fixed: `?help` and `/help`** — the help menu's category dropdown carried an invalid emoji, which made Discord reject the entire message (`Invalid Form Body`). The dropdown is now emoji-free and both prefix and slash help render correctly.
- **Premium bot profile** — a rotating presence that alternates between *Listening* and *Watching*, a branded welcome card, and a help intro that shows the live command count.

### What was in v2.1

- **Interactive queue pagination** — `?queue` renders first / previous / page-indicator / next / last buttons. Only the person who ran the command can use them, and they auto-disable after 2 minutes.
- **Slash commands** — every major command has a `/` version with proper options (`/play query:`, `/volume level:`, `/seek time:` …). Prefix commands are unchanged and still work exactly as before.
- **59 commands** — playlists, favorites, track/artist info, grab-to-DM, history, queue save/restore, dedupe, sort, remove-range, speed/pitch/rate, a full equalizer, 25 filter presets, the `source` switcher, and the `status`/`stream`/`activity` presence controls.
- **Standalone command deployer** — `npm run deploy-commands` registers slash commands without booting the bot.

---

## Features

### Playback
- **Play** from a search term, a YouTube/SoundCloud link, or a whole playlist
- **Multi-source links** — Spotify, Apple Music, Deezer, Yandex Music, Twitch, Vimeo and Bandcamp. Spotify/Apple/Deezer need the **LavaSrc** plugin on your Lavalink node — see [Spotify Support](#spotify-support-lavasrc-plugin); there is also a best-effort text fallback when a link cannot be resolved
- Pause, resume, skip (single or multiple), previous, replay, stop, disconnect
- **Seek** to any timestamp, plus relative forward/rewind
- Volume control with a configurable ceiling
- **24/7 mode** — stay in the voice channel after the queue empties
- **Autoplay** — keeps the music going with similar tracks when the queue runs dry

### Queue
- **Interactive paginated queue** with first/prev/next/last buttons and a `Page x/y` indicator
- Totals in the footer: track count and total duration
- Each line shows position, title, duration and requester
- Loop (off / track / queue), shuffle, jump-to-track, move, remove, remove-range, clear
- **Dedupe** and **sort** (by title / duration / author)
- **Queue save & restore** — snapshot the queue and bring it back later

### Audio
- **25 filter presets**: bass, bassboost, bassboostextreme, pop, rock, electronic, classical, gaming, fullsound, bettermusic, treble, nightcore, vaporwave, daycore, 8D, rotation, karaoke, vibrato, tremolo, lowpass, highpass, soft, normalization, distortion, off
- **Speed / pitch / rate** controls and a **15-band equalizer** (presets or per-band gain)
- Lyrics from the Lavalink lyrics plugin, with a public lyrics API fallback
- Support for live streams (progress bar switches to a live readout)

### Library
- **Favorites** — like, like-all, list, play, clear
- **Playlists** — save, load, show, list, delete (per user)
- **History** — recently played tracks per server
- **Grab** — DM the current track's details to yourself
- **Track info** and **artist info** cards

### The Now Playing card
A deliberately tiny, premium embed that updates itself:
- The **track title** and **artist**
- **Duration** and the **requester** mention
- **Control buttons**: previous, pause/resume, skip, stop, volume ±10, loop, shuffle, autoplay
- **Source buttons** (own row): **Spotify** / **YouTube** — the active one is highlighted and disabled, the other switches the search source for upcoming tracks
- No artwork, no progress bar, no field grid — standard Discord size, clean and minimal
- The old card is replaced instead of stacking

### Server features
- Per-server **prefix**, per-server **24/7**, per-user **favorites** and **playlists**
- Interactive **help menu** with category dropdown
- Welcome message on join (DM, with a channel fallback)
- `/health` JSON endpoint for uptime monitors

### Engineering
- **Zero hardcoded secrets** — everything comes from `config.json` or environment variables
- **One source of truth** — slash commands reuse the exact same `run()` functions as prefix commands
- Atomic JSON persistence (tmp file + rename), so a hard kill never corrupts data
- Every expected failure becomes a clean embed, never a stack trace
- Crash guards on `unhandledRejection` / `uncaughtException`
- Graceful shutdown on `SIGINT` / `SIGTERM` that flushes stores and disconnects nodes
- Offline self-test suite — **19 checks**, no Discord connection needed (`node index.js --check`)

---

## Quick start (obsdn / any Node host)

### 1. What you need

| Requirement | Notes |
|---|---|
| **Node.js 18.17+** | Node 20 LTS recommended |
| **Discord bot token** | [Developer Portal](https://discord.com/developers/applications) → your app → **Bot** → *Reset Token* |
| **Lavalink v4 server** | A host + port + password. See [below](#no-lavalink-server-yet) if you don't have one |
| **LavaSrc plugin** | Only if you want Spotify / Apple Music / Deezer. Lavalink cannot play them without it — see [Spotify Support](#spotify-support-lavasrc-plugin) |

### 2. Create the bot application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**, name it **Gaana**
2. **Bot** tab → **Reset Token** → copy the token (you only see it once)
3. **Bot** tab → enable **MESSAGE CONTENT INTENT** (required for prefix commands)
4. **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`
5. Permissions: **View Channels**, **Send Messages**, **Embed Links**, **Read Message History**, **Connect**, **Speak**
6. Open the generated URL and invite the bot

> The `applications.commands` scope is what lets the bot register slash commands. If you invited the bot before adding it, re-invite with the updated URL.

### 3. Upload

Upload the project folder to your host (obsdn, Pterodactyl, Railway, a VPS — anything that runs Node).

### 4. Fill in `config.json`

Open `config.json` and set your Discord bot token. The Lavalink node is **already pre-filled** — change it only if you use a different server:

```json
{
  "token": "YOUR_DISCORD_BOT_TOKEN_HERE",
  "lavalink": {
    "nodes": [
      {
        "id": "main",
        "host": "us3.visihost.in",
        "port": 2774,
        "password": "youshallnotpass",
        "secure": false
      }
    ]
  }
}
```

That's it — every other field has a working default.

### 5. Install and start

```bash
npm install
npm start
```

Expected output:

```
[2026-01-01 12:00:00] INFO  (boot)  Starting Gaana v5.0.0
[2026-01-01 12:00:00] INFO  (boot)  Lavalink node(s): main@us3.visihost.in:2774
[2026-01-01 12:00:00] INFO  (boot)  Keep-alive server listening on port 3000
[2026-01-01 12:00:01] INFO  (boot)  Logged in as Gaana#1234 — 56 prefix commands loaded
[2026-01-01 12:00:01] INFO  (boot)  Lavalink manager initialised.
[2026-01-01 12:00:02] INFO  (boot)  Registered 56 global slash commands (global scope).
```

### 6. Play something

Join a voice channel in your server and type either:

```
?play kesariya
```

or use the slash command:

```
/play query:kesariya
```

---

### Host-specific setup

**obsdn / Pterodactyl-style panels**

| Setting | Value |
|---|---|
| Startup command | `npm start` |
| Node version | 18 or newer (20 recommended) |
| Install command | `npm install --omit=dev` |
| Required env | none (config.json works) — `DISCORD_TOKEN` overrides the file if your panel injects secrets |

> The bot binds `PORT` (default `3000`) with a keep-alive HTTP server, because most panels expect a listening port.

**Railway / Render / Fly.io**

```
Build:  npm install
Start:  npm start
Port:   $PORT (bound automatically)
```

Set `DISCORD_TOKEN` and `LAVALINK_URL` as environment variables instead of editing the file:

```
LAVALINK_URL=lavalink://main:yourpassword@lavalink.example.com:2333
```

**Docker**

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
CMD ["npm", "start"]
```

### No Lavalink server yet?

Lavalink is the audio engine that actually streams to Discord — the bot cannot play without one. Options:

1. **Host Lavalink yourself** (free, ~5 min): [lavalink.dev](https://lavalink.dev/getting-started/) — download the jar, set `password` in `application.yml`, run `java -jar Lavalink.jar`
2. **Use a hosted provider** — search "free Lavalink hosting" or use a public node; put its host/port/password in `config.json`
3. **Local testing:** `host: "127.0.0.1"`, `port: 2333`, plus your `application.yml` password

---

## Slash commands

Slash commands are registered **automatically on startup** (global + every guild the bot is in). Nothing extra is required — just invite the bot with the `applications.commands` scope.

- **Global** registration can take up to **1 hour** to appear the first time.
- **Per-guild** registration is **instant**, which is why the bot also registers into each guild it is in.

### Manual deploy (optional)

If you change a command definition and want to push it without restarting the bot:

```bash
npm run deploy-commands            # global + every guild the bot is in
npm run deploy-commands -- --global   # global only
npm run deploy-commands <guildId>     # one specific guild (instant)
```

### Turning slash commands off

Set `"registerSlashCommands": false` in `config.json` to skip registration entirely (prefix commands keep working).

### Slash command options

| Command | Options |
|---|---|
| `/play` | `query` (required) |
| `/skip` | `amount` |
| `/queue` | `page` |
| `/loop` | `mode` (off / track / queue) |
| `/remove` | `position` (required) |
| `/removerange` | `from`, `to` (required) |
| `/move` | `from`, `to` (required) |
| `/jump` | `position` (required) |
| `/sort` | `by` (title / duration / author), `order` (asc / desc) |
| `/seek` | `time` (required) |
| `/forward` / `/rewind` | `seconds` |
| `/volume` | `level` |
| `/speed` / `/pitch` / `/rate` | `value` (required) |
| `/equalizer` | `preset`, `gain` |
| `/filter` | `preset` |
| `/lyrics` | `query` |
| `/search` | `query` (required) |
| `/playfavorites` | `count` |
| `/playlist` | `action` (save / load / show / list / delete), `name` |
| `/trackinfo` | `position` |
| `/prefix` | `value` |
| `/source` | `provider` (spotify / youtube) |
| `/help` | `command` |

---

## Configuration

Every value is optional except `token` and `lavalink.nodes`.

| Key | Type | Default | Description |
|---|---|---|---|
| `token` | string | — | **Required.** Discord bot token |
| `prefix` | string | `?` | Default command prefix (per-server overrides via `?prefix`) |
| `botName` | string | `Gaana` | Branding in embeds, footers and status |
| `embedColor` | string | `#f1b2c1` | Accent colour for embeds |
| `defaultVolume` | number | `80` | Starting volume, 1–150 |
| `maxVolume` | number | `150` | Ceiling for the volume command |
| `defaultSearchSource` | string | `ytsearch` | `ytsearch`, `ytmsearch`, `scsearch` |
| `sourceChoice` | string | `youtube` | Default source for plain-text searches: `spotify` or `youtube`. Users can switch it live from the Now Playing card buttons or with `?source` |
| `sources` | object | all `true` | Which link sources to hand to Lavalink by name: `youtube`, `soundcloud`, `spotify`, `applemusic`, `deezer`, `yandexmusic`, `twitch`, `vimeo`, `bandcamp`. A source only works if the node has the matching plugin; otherwise Gaana falls back to a YouTube search |
| `emojis` | object | `{}` | Optional icon overrides, e.g. `"play": "<a:play:123456789012345678>"`. Set a key to `""` to remove it. `spotify` / `youtube` are the source-choice buttons |
| `maxQueueSize` | number | `1000` | Refuse new tracks past this length |
| `stayInVoiceByDefault` | boolean | `false` | 24/7 behaviour for servers that never set it |
| `supportServerUrl` | string | `""` | Shown in help/support/welcome |
| `voteUrl` | string | `""` | Shown by the `vote` command |
| `registerSlashCommands` | boolean | `true` | Register slash commands on startup |
| `slashGuildIds` | string[] | `[]` | Optional guild IDs to register slash commands in instantly |
| `developerIds` | string[] | `[]` | Discord user IDs with owner privileges |
| `activityRotation` | string[] | see file | Rotating status lines; `{prefix}`, `{servers}`, `{bot}` are substituted |
| `presence.defaultStreamUrl` | string | `https://www.twitch.tv/gaana` | Stream URL used by `?stream` when none is given |
| `presence.defaultStreamText` | string | `Gaana Radio` | Stream title used by `?stream` when none is given |
| `presence.defaultActivityType` | string | `listening` | Default activity type for the presence commands |
| `lavalink.nodes[]` | object[] | — | **Required.** `id`, `host`, `port`, `password`, `secure` |

### Environment variable overrides

Environment variables win over the file, so hosts that inject secrets keep working:

| Variable | Overrides |
|---|---|
| `DISCORD_TOKEN` | `token` |
| `LAVALINK_URL` | `lavalink.nodes` — `lavalink://id:password@host:port` (comma-separate for multiple) |
| `DEVELOPER_IDS` | `developerIds` — comma-separated |
| `PORT` | keep-alive HTTP port (default `3000`) |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` (default `info`) |

> `config.json` also accepts `//` line comments and `/* */` blocks, so you can annotate freely.

---

## Spotify Support (LavaSrc plugin)

Everything in this section happens on your **Lavalink server**, not in the bot's folder. Gaana already knows how to talk to Spotify — it just needs a node capable of answering.

### 1. What LavaSrc is, and why you need it

**Lavalink by itself cannot play Spotify links.** A stock Lavalink only ships source managers for the formats it can stream directly — YouTube, SoundCloud, Bandcamp, Twitch, Vimeo, and plain HTTP. Spotify, Apple Music, Deezer and Yandex Music are **not** included: hand a stock node an `open.spotify.com` link and it returns an empty result, because no registered source manager recognises it.

**LavaSrc** is the official community plugin that adds those platforms. It does two separate jobs:

| Job | What it gives you |
|---|---|
| **Search** | The `spsearch:` platform — `spsearch:kesariya` searches Spotify's catalogue instead of YouTube's |
| **Link resolving** | `open.spotify.com/track/…`, `/album/…`, `/playlist/…`, `/artist/…` URLs resolve into real queue entries |

It also adds Apple Music (`amsearch`), Deezer (`dzsearch`) and Yandex Music (`ymsearch`), which is why one plugin covers all four sources Gaana advertises.

**How playback actually works (important).** Spotify serves **metadata only** — its audio is DRM-protected, so no bot can stream it. LavaSrc calls this *mirroring*: it reads the Spotify metadata (title, artist, duration, artwork, ISRC), then asks a **Direct** source to produce a playable stream for that track. Deezer can do this natively; otherwise it falls back to a YouTube search using the track's ISRC or its `artist - title` string. This is why a Spotify link can occasionally play a slightly different version — a live take, a remix, or a lyric video. See [§8](#8-the-mirroring-caveat-why-a-track-sometimes-doesnt-match).

**What Gaana does with and without the plugin:**

| Situation | `?play <spotify link>` |
|---|---|
| Node **has** LavaSrc + credentials | Track resolves properly — title, artist and artwork all come from Spotify, audio mirrors from Deezer/YouTube |
| Node has LavaSrc but **no** credentials | `spsearch` errors; Gaana retries as a text search on the bare ID and finds nothing usable — effectively broken |
| Node has **no** LavaSrc | Lavalink returns nothing; Gaana shows a clean "couldn't load" error after the text fallback finds nothing |

### 2. Install the plugin

LavaSrc requires **Lavalink v4 or newer**. Current release: **4.8.3**.

> ⚠️ **There are two different `plugins` keys, and mixing them up is the #1 install mistake.** They live at different indentation levels and do different jobs:
>
> | Key | Where | What it holds |
> |---|---|---|
> | `lavalink.plugins:` | **inside** `lavalink:` | The *dependency list* — jars for Lavalink to download |
> | `plugins:` | **root** (no indentation) | Each plugin's *settings* — `plugins.lavasrc:`, `plugins.youtube:` |
>
> Put the dependency list at root and nothing downloads. Put the settings under `lavalink:` and the jar loads but ignores every setting. Both mistakes fail **silently**.

#### Option A — let Lavalink download it (recommended)

Add the dependency list to your existing `lavalink:` block in `application.yml` and restart. Lavalink fetches the jar from Maven on boot:

```yaml
lavalink:
  plugins:
    - dependency: "com.github.topi314.lavasrc:lavasrc-plugin:4.8.3"
      repository: "https://maven.lavalink.dev/releases"
      snapshot: false
```

Then add the settings block from [§4](#4-complete-applicationyml) at the **root** of the file — that's where `plugins.lavasrc:` lives.

On start you'll see it pull the jar, then:

```
INFO  ... PluginManager : Found plugin 'lavasrc-plugin' version 4.8.3
INFO  ... PluginManager : Loaded lavasrc-plugin-4.8.3.jar
```

#### Option B — drop the jar in manually

Use this when your host has no outbound internet, or the auto-download fails.

1. Open the releases page: **https://github.com/topi314/LavaSrc/releases/latest**
2. Download **`lavasrc-plugin-4.8.3.jar`** — the *plugin* jar, **not** `lavasrc-4.8.3.jar` (that one is the library, and Lavalink will ignore it)
3. Put it in the Lavalink **`plugins/`** folder next to `Lavalink.jar` (create the folder if missing)
4. Restart Lavalink

To upgrade later, delete the old jar and drop in the new one — plugin config survives.

### 3. Spotify credentials

The Spotify Web API needs an application identity. It's free, needs no Premium subscription, and takes about two minutes.

1. Go to **https://developer.spotify.com/dashboard** and log in with any Spotify account
2. Click **Create app**
3. Fill in:
   - **App name** — anything, e.g. `Gaana`
   - **App description** — anything, e.g. `Discord music bot`
   - **Redirect URI** — `http://localhost:8080` (LavaSrc never uses it, but the form requires one; any valid URL works)
   - **Which API/SDKs are you planning to use?** — tick **Web API**
4. Accept the terms and click **Save**
5. Open the app → **Settings**
6. Copy the **Client ID**, then click **View client secret** and copy the **Client secret**

> 💡 Leaving the app in **Development mode** is fine — LavaSrc only uses app-level credentials, so no user login or extended-quota approval is needed for normal playback.
>
> 🔒 Treat the client secret like a password. Keep `application.yml` out of git, and if it ever leaks, rotate it in the same Settings page.

### 4. Complete `application.yml`

Copy-paste ready. Replace the **three** marked values — Lavalink password, Spotify Client ID, Spotify Client secret — and leave the rest alone.

```yaml
server:
  port: 2333
  address: 0.0.0.0

lavalink:
  server:
    password: "CHANGE_ME_lavalink_password"     # <-- 1. your Lavalink password
    sources:
      youtube: false        # the youtube-plugin below replaces the built-in one
      bandcamp: true
      soundcloud: true
      twitch: true
      vimeo: true
      http: true            # keep enabled: mirroring fetches streams over HTTP
      local: false

  plugins:
    # YouTube (the modern source plugin — required for ytsearch to work)
    - dependency: "dev.lavalink.youtube:youtube-plugin:1.18.2"
      snapshot: false
    # Spotify / Apple Music / Deezer / Yandex Music
    - dependency: "com.github.topi314.lavasrc:lavasrc-plugin:4.8.3"
      repository: "https://maven.lavalink.dev/releases"
      snapshot: false

plugins:
  youtube:
    enabled: true
    clients:
      - MUSIC
      - ANDROID_VR
      - WEB
      - WEBEMBEDDED

  lavasrc:
    # Where to look for a playable stream, in order. ISRC first (most accurate),
    # then a plain "artist - title" search. These are the mirroring providers.
    providers:
      - "ytsearch:\"%ISRC%\""    # skipped automatically when a track has no ISRC
      - "ytsearch:%QUERY%"
      # - "dzisrc:%ISRC%"        # uncomment for native Deezer mirroring (needs arl)
      # - "dzsearch:%QUERY%"

    sources:
      spotify: true          # <-- must be true, or spsearch is unavailable
      applemusic: false      # needs a mediaAPIToken, see LavaSrc docs
      deezer: false          # needs an arl cookie
      yandexmusic: false     # needs an accessToken
      flowerytts: false
      youtube: false
      vkmusic: false
      tidal: false
      qobuz: false
      ytdlp: false
      jiosaavn: false

    lyrics-sources:
      spotify: true          # lets ?lyrics use Spotify's lyrics endpoint
      deezer: false
      youtube: true
      yandexmusic: false
      vkmusic: false
      lrcLib: true           # free fallback, works without any credentials

    spotify:
      clientId: "YOUR_SPOTIFY_CLIENT_ID"          # <-- 2.
      clientSecret: "YOUR_SPOTIFY_CLIENT_SECRET"  # <-- 3.
      # spDc: ""             # optional cookie, only needed for Spotify lyrics
      countryCode: "IN"      # ISO-3166-1 alpha-2 — affects top-tracks filtering
      playlistLoadLimit: 6   # pages of 100 tracks each
      albumLoadLimit: 6      # pages of 50 tracks each
      resolveArtistsInSearch: true
      localFiles: false

logging:
  level:
    root: INFO
    lavalink: INFO
```

A couple of notes on the above:

- **`countryCode`** — set it to your listeners' market (e.g. `IN`, `US`, `GB`). It changes which tracks appear for artist top-tracks and can affect availability.
- **`http: true`** stays on: mirrored streams and some artwork URLs are fetched over plain HTTP.
- **Anything you enable in `sources:` that needs a token** (Apple Music, Deezer, Yandex) also needs its own credentials block — leaving one `true` without credentials will make that source fail at runtime rather than at boot.

### 5. Bot-side config

Nothing here is required if your node is already set up — these are the two keys that matter, and both already default correctly:

```json
{
  "defaultSearchSource": "ytsearch",
  "sources": {
    "spotify": true,
    "applemusic": true,
    "deezer": true
  }
}
```

| Key | Effect |
|---|---|
| `sources.spotify: true` | Gaana names `spotify` as the source for `open.spotify.com` links, which `lavalink-client` translates to the `spsearch` platform |
| `sources.spotify: false` | The link is passed through untouched and Lavalink auto-detects it — only useful when the node resolves Spotify without a named source |
| `defaultSearchSource` | Where **plain text** searches go (`?play kesariya`). Leave it `ytsearch` unless you specifically want text searches hitting Spotify |

**Why `spotify` works even though Lavalink's platform is called `spsearch`:** `lavalink-client` keeps an alias table that maps friendly names to platform identifiers — `spotify` / `sp` / `spsearch` all resolve to `spsearch`, `applemusic` / `am` to `amsearch`, `deezer` / `dz` to `dzsearch`, and so on. Gaana sends the friendly name, the client translates it, Lavalink receives `spsearch:<query>`. Nothing to configure by hand.

#### About the automatic fallback — and its limit

Gaana's multi-source safety net is real but **narrow**. If Lavalink returns nothing for a link, the bot retries once as a text search built from the link's **last path segment**:

| Link | Fallback query | Outcome |
|---|---|---|
| `soundcloud.com/artist/my-great-song` | `my great song` | ✅ Usually finds the track |
| `youtube.com/watch?v=dQw4w9WgXcQ` | `dQw4w9WgXcQ` | ⚠️ Doesn't matter — YouTube resolves natively |
| `open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT` | `4cOdK2wGLETKBW3PvgPWqT` | ❌ A base62 ID is not a song name — this finds nothing |

So the fallback genuinely rescues slug-based links (SoundCloud, Bandcamp), but **it cannot rescue Spotify** — a Spotify URL carries no title in its path. **Install LavaSrc if you want Spotify to work.** Treat the fallback as a safety net for odd links, not as a Spotify workaround.

### 6. Verify it works

**a. Check the plugin loaded.** Query the node's `/v4/info` endpoint:

```bash
curl -s http://us3.visihost.in:2774/v4/info | grep -o '"name":"[^"]*"'
```

If your node returns `401`, add the password header:

```bash
curl -s -H "Authorization: your_lavalink_password" http://us3.visihost.in:2774/v4/info
```

Expected: `lavasrc-plugin` appears in `plugins`, and `spotify` appears in `sourceManagers`.

**b. Or just read the startup log.** After a restart, Lavalink prints one line per source it registered:

```
INFO  LavaSrcPlugin : Registering Spotify source manager...
INFO  LavaSrcPlugin : Registering Spotify search manager...
INFO  LavaSrcPlugin : Registering Deezer source manager...
```

No `LavaSrcPlugin` lines at all → the jar isn't in `plugins/`, or `plugins:` was nested under `lavalink:` by mistake.

**c. Check the live LavaSrc config.** Version 4.6+ exposes the effective settings — handy for confirming your `clientId` actually reached the plugin:

```bash
curl -s -H "Authorization: your_lavalink_password" http://us3.visihost.in:2774/v4/lavasrc/config
```

**d. Check node health from Discord.** `?nodeinfo` shows each node's status, player count, CPU and memory — useful to confirm the node is alive after your restart, but it does **not** list source managers. For that, use §6a or watch the startup log in §6b.

**e. Play a real link:**

```
?play https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT
```

Success looks like: the Now Playing card shows the **Spotify** title and artist, and audio starts within a few seconds while LavaSrc resolves the mirror. A playlist link queues the whole playlist in order.

> 💡 If tracks resolve but the queue stalls on "loading", the mirroring step is the problem, not Spotify — usually YouTube blocking the node. Check the node's log for `Something went wrong while looking up the track`.

### 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `No matching source` / `Unknown source` | LavaSrc not loaded, or `sources.spotify` is `false` in `application.yml` | Confirm the jar is in `plugins/`, the settings block is at **root**, and `lavasrc.sources.spotify: true` |
| `?play <spotify link>` → "couldn't load that track" | Node resolved nothing: plugin missing, or credentials rejected | Run §6a. If `spotify` isn't in `sourceManagers`, the plugin didn't load |
| Plugin not loaded (no `LavaSrcPlugin` lines) | Settings block placed under `lavalink:` instead of root; dependency list placed at root instead of inside `lavalink:`; jar named `lavasrc-*.jar` instead of `lavasrc-plugin-*.jar`; Lavalink older than v4 | Check both indentation levels against §2, download the **plugin** jar, upgrade Lavalink to v4+ |
| `Spotify credentials invalid` / `invalid_client` | Wrong `clientId`/`clientSecret`, stray quotes or whitespace, or the secret was rotated in the dashboard | Re-copy both values from Settings → paste without quotes (they're already quoted in the YAML) |
| `401 Unauthorized` from Spotify | Same as above — the app can't mint a token | Verify by re-copying; a deleted/regenerated secret stops working immediately |
| `403 Forbidden` on a track | Track is region-locked, or the app hit its rate limit | Set `countryCode` to a market where it's available; space out bulk playlist loads |
| `429 Too Many Requests` | Spotify rate limit — common when loading several big playlists at once | Wait a few minutes; lower `playlistLoadLimit`; don't loop `?play` on playlists |
| Playlist loads only the first ~100 tracks | `playlistLoadLimit` reached | Raise it (each unit ≈ 100 tracks) — but watch the rate limit |
| Track resolves but audio is a different version | **Mirroring** picked another source's match | See §8 — expected behaviour, not a bug |
| Audio never starts, track stuck loading | Mirroring failed: YouTube is blocking the node, or `http: true` is off | Check node logs; update the youtube-plugin; keep `http: true` |
| `?lyrics` finds nothing for Spotify tracks | `lyrics-sources.spotify` disabled, or `spDc` cookie not set | Enable it and add the `spDc` cookie (DevTools → Application → Cookies → `sp_dc`) |
| Spotify links work but search doesn't | `sources.spotify: false` in `config.json` disables naming the platform | Set it back to `true` |
| Worked yesterday, broken today | Lavalink restarted with a changed/blanked `application.yml`, or the jar was replaced by the wrong artifact | Re-check §6b and §6c |

### 8. The mirroring caveat (why a track sometimes doesn't match)

This surprises people, so it's worth stating plainly:

> **No Discord bot streams Spotify audio.** Spotify's audio is DRM-protected and there is no API to fetch a playable stream. LavaSrc reads the **metadata** from Spotify, then finds the **audio** somewhere else.

The consequence: when LavaSrc mirrors a Spotify track, it searches a Direct source using the track's **ISRC** (a unique recording ID — very accurate) or, failing that, `"artist - title"`. If the exact recording isn't available on that source, you get the closest match, which can be:

- a **live** or **remastered** version instead of the studio take
- a **remix**, **sped-up** or **slowed** version
- a **lyric video** or extended edit with a different duration
- a track that's simply **unavailable** in your region

The Spotify **title, artist and artwork** in the Now Playing card still come from Spotify, so the card can say one thing while a slightly different audio take plays. That mismatch is inherent to mirroring, not a bug in Gaana.

You can improve match quality by keeping **ISRC providers first** in the `providers` list (as in §4) — the ISRC lookup is far more precise than a text search. Adding a Deezer `arl` and enabling `dzisrc` gives you native Deezer mirroring, which is the highest-fidelity option available.

---

## Commands

Default prefix `?` — every command also accepts its aliases, and most have a slash version. Run `?help` for the in-Discord menu.

### Playback

| Command | Aliases | Description |
|---|---|---|
| `play <song\|url>` | `p` | Search and queue a track or playlist |
| `pause` | — | Pause the current track |
| `resume` | `unpause` | Resume playback |
| `skip [amount]` | `s`, `next` | Skip one or several tracks |
| `previous` | `prev`, `back` | Replay the previous track |
| `replay` | — | Restart the current track |
| `stop` | — | Stop and clear the queue |
| `disconnect` | `dc`, `leave` | Leave the voice channel |

### Queue

| Command | Aliases | Description |
|---|---|---|
| `queue [page]` | `q`, `list` | Interactive paginated queue |
| `nowplaying` | `np`, `current`, `song` | Compact Now Playing card |
| `loop [off\|track\|queue]` | `repeat`, `l` | Cycle or set the repeat mode |
| `shuffle` | `sh` | Shuffle upcoming tracks |
| `remove <pos>` | `rm`, `delete` | Remove a track by position |
| `removerange <from> <to>` | `rr` | Remove a range of tracks |
| `move <from> <to>` | `mv` | Reorder the queue |
| `jump <pos>` | `skipto`, `j` | Jump to a queued track |
| `clear` | `clearqueue`, `cq` | Clear every upcoming track |
| `dedupe` | `dedup`, `unique` | Remove duplicate tracks |
| `sort <by> [order]` | `order` | Sort by title / duration / author |
| `autoplay` | `ap` | Toggle autoplay of similar tracks |
| `queuesave [name]` | `qsave` | Save the current queue |
| `queuerestore [name]` | `qrestore` | Restore a saved queue |

### Audio

| Command | Aliases | Description |
|---|---|---|
| `seek <mm:ss\|sec>` | `ss` | Jump to a timestamp |
| `forward [sec]` | `ff` | Skip forward (default 10s) |
| `rewind [sec]` | `rw` | Go back (default 10s) |
| `volume [0-100]` | `vol`, `v` | Show or set the volume |
| `speed <0.5-2.0>` | — | Change playback speed |
| `pitch <0.5-2.0>` | — | Change playback pitch |
| `rate <0.5-2.0>` | — | Change playback rate |
| `equalizer <preset\|band gain>` | `eq` | Equalizer presets or per-band gain |
| `filter [preset]` | `filters`, `fx` | Apply an audio filter preset |
| `lyrics [query]` | `ly` | Lyrics for the current track or a search |

**Filter presets:** `bass` · `bassboost` · `bassboostextreme` · `pop` · `rock` · `electronic` · `classical` · `gaming` · `fullsound` · `bettermusic` · `treble` · `nightcore` · `vaporwave` · `daycore` · `8d` · `rotation` · `karaoke` · `vibrato` · `tremolo` · `lowpass` · `highpass` · `soft` · `normalization` · `distortion` · `off`

### Favorites

| Command | Aliases | Description |
|---|---|---|
| `like` | `save`, `grab`, `bookmark` | Save the current track |
| `likeall` | `saveall` | Save the current track and queue |
| `favorites` | `favs`, `showliked`, `liked` | List your saved tracks |
| `playfavorites [n]` | `playfavs`, `playliked` | Queue your saved tracks |
| `unlike` | `clearfavorites`, `clearfavs` | Clear your list |

### Playlists

| Command | Aliases | Description |
|---|---|---|
| `playlist save <name>` | `pl` | Save the current queue as a playlist |
| `playlist load <name>` | `pl` | Queue a saved playlist |
| `playlist show <name>` | `pl` | Show a playlist's tracks |
| `playlist list` | `pl` | List your playlists |
| `playlist delete <name>` | `pl` | Delete a playlist |

### Info

| Command | Aliases | Description |
|---|---|---|
| `trackinfo [pos]` | `ti` | Detailed track information |
| `artistinfo` | `ai` | Info about the current artist |
| `grab` | `dm` | DM the current track to you |
| `history` | `recent`, `played` | Recently played tracks |
| `uptime` | — | How long the bot has been online |
| `invite` | — | The bot's invite link |
| `support` | — | Support server link |
| `vote` | — | Vote link |
| `nodeinfo` | `nodes` | Lavalink node details |
| `shardinfo` | `shards` | Shard information |

### Settings & utility

| Command | Aliases | Description |
|---|---|---|
| `247` | `stay`, `24-7` | Toggle 24/7 mode *(Manage Server)* |
| `prefix [new]` | — | Show or change the prefix *(Manage Server)* |
| `source [spotify\|youtube]` | `src`, `provider` | Show or set the search source for plain-text searches |
| `status [text\|clear]` | `setstatus` | Set the bot's custom status, or show the current one *(Manage Server)* |
| `stream [text] [url]` | `setstream` | Set a STREAMING status (LIVE badge), or show the current one *(Manage Server)* |
| `activity [type] [text]` | `setactivity`, `presence` | Set the bot's activity type and text, or show the current one *(Manage Server)* |
| `join` | `summon` | Join your voice channel |
| `help [command]` | `h`, `cmds` | Command menu |
| `ping` | `latency` | Gateway / round-trip / Lavalink latency |
| `stats` | `botinfo` | Bot and node statistics |
| `search <query>` | `find` | Search and pick from an interactive menu |

---

## Project structure

This is a **single-file flat build** — no folders, so it uploads straight to GitHub from a phone.

```
gaana/
├── index.js            # The whole bot: config, logger, format, theme, stores,
│                       #   Lavalink logic, all prefix commands, slash commands,
│                       #   interactive components and boot code
├── config.json         # All configuration (no secrets in code)
├── package.json        # Dependencies and scripts
├── README.md           # This file
└── data/               # Created at runtime: prefixes, 24/7, favorites, playlists…
```

Inside `index.js` the sections appear in this order, each under a banner comment:
`logger` · `format` · `theme` · `config` · `store` · `music` · `commands` · `slash` · `index (boot)` · `deploy-commands` · `self-test`.

---

## How it works

```
Discord message  →  prefix parser  →  command registry  →  Lavalink (playback)
Discord /command →  slash adapter  →  command registry  ↗
                                            ↓
                                   Now Playing card  ←  trackStart event
                                            ↓
                                   15s progress refresh
```

- **`index.js`** owns the Discord client, the Lavalink manager and the dispatcher. Every listener lives here so the control flow is in one place.
- **The command registry** is a plain `Map` of command objects. Adding a command means adding one `register({...})` block — no other file changes.
- **The slash table** declares slash options and reuses the same `run()` functions, so `/play` and `?play` can never drift apart.
- **The music section** holds everything that touches Lavalink, plus user-facing guards (`requireVoiceChannel`, `requireSameChannel`) that produce clean errors, the queue pager and the source-choice buttons.
- **The store** writes JSON atomically on a 250 ms debounce, so rapid config changes don't hammer the disk and a crash can't truncate a file.

### Adding a command

```js
register({
  name: "mycommand",
  aliases: ["mc"],
  category: "Utility",
  usage: "mycommand <thing>",
  description: "Does something useful.",
  async run(ctx, message, args) {
    await message.reply("Hello!");
  },
});
```

It appears in `?help` automatically, gets the cooldown guard, and any `UserError` you throw becomes a friendly embed. To also expose it as a slash command, add one entry to the slash `DEFS` table.

---

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `Discord login failed: An invalid token was provided` | Token is wrong/expired. Reset it in the Developer Portal and update `config.json`. |
| Bot is online but `play` does nothing | **Message Content Intent** is disabled — enable it in the Bot tab. |
| Slash commands don't appear | The bot was invited without the `applications.commands` scope, or global registration hasn't propagated yet (up to 1 hour). Re-invite, or run `npm run deploy-commands <guildId>` for instant guild commands. |
| `No usable Lavalink node configured` | `lavalink.nodes` still has placeholders. Fill in host/port/password. |
| `I couldn't reach the music server` | Lavalink is down, the password is wrong, or the port is blocked. Check the node's own logs. |
| Bot joins but there's no audio | Lavalink can't reach the source, or `ffmpeg`/plugins are missing on the node. Also check **Speak** permission. |
| `I can't join <channel>` | Missing **Connect**/**Speak** permission on that channel. |
| Commands silently ignored | Wrong prefix. Run `?prefix` to see the server's prefix, or mention the bot: `@Gaana help`. |
| A filter says it needs a plugin | `highpass`, `normalization` and `distortion` need the LavaDSPx / filter plugin on your Lavalink node. The other 20+ presets work on a stock node. |
| Queue buttons say "expired" | The pager disables itself after 2 minutes — run `?queue` again. |
| Embed shows "Unknown" for requester | The track was queued before a restart — requester data isn't persisted by Lavalink. |
| Lyrics never found | The Lavalink lyrics plugin isn't installed; the bot falls back to lrclib.net, which may not have the track. For Spotify tracks, also check `lyrics-sources.spotify` — see [Spotify troubleshooting](#7-troubleshooting). |
| Spotify links don't play / resolve to nothing | LavaSrc isn't installed on the node, or its credentials are wrong. Full checklist: [Spotify Support → Troubleshooting](#7-troubleshooting). |

Enable verbose logging with `LOG_LEVEL=debug` to see every command execution and Lavalink interaction.

---

## Production notes

**Scaling.** One Lavalink node handles roughly 50–150 concurrent players depending on CPU. For more, add nodes to `lavalink.nodes` — `lavalink-client` load-balances automatically via `leastUsedNodes()`.

**Persistence.** `data/*.json` holds prefixes, 24/7 flags, favorites, playlists, saved queues and history. Mount it as a volume if your host uses ephemeral containers, otherwise it resets on redeploy.

**Rate limits.** Command cooldowns (700 ms per user/command) and the 15-second progress refresh are both well inside Discord's limits. Avoid lowering them.

**Health checks.** Point your monitor at `GET /health` — it returns guild count, player count and per-node connection state.

**Updates.** Replace the source files and redeploy. `data/` and `config.json` survive; `git pull && npm install && npm start` is enough.

**Security.** Never commit `config.json` with a real token. If a token leaks, reset it immediately in the Developer Portal — the old one dies instantly.

---

## Verification

```bash
npm run check
```

Runs 25 offline assertions against the real command registry — formatting, pagination, registry completeness, slash definitions, help rendering, multi-source resolution, the compact card shape, icon validation, the source-choice buttons, the presence commands (set / validate / clear / permission guard), happy paths, queue mutations and error handling. No Discord connection or Lavalink needed.

```
  Gaana — offline self-test

  25 passed

  All checks passed.
```

---

## License

MIT — use it, modify it, ship it.

Built with [discord.js](https://discord.js.org/) and [lavalink-client](https://github.com/Tomato6966/lavalink-client).
