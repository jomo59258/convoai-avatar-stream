# AI Avatar Stream

A 1-to-many live room where a host goes live with an AI avatar (driven by [Agora's Conversational AI Engine](https://docs.agora.io/en/conversational-ai)), and any number of guests join to chat and ask questions. The avatar answers the room in one of two **response modes** — **Batched** (collect questions for a window, then answer the whole room at once) or **Sequential** (queue questions and answer them one at a time). A host creates a channel from the setup screen, gets a shareable **guest link** and a private **host link**, and unlimited guests can join. Multiple channels run independently in parallel.

This is a **reference / demo project** intended to be cloned and customized.

---

## Quick start

### Prerequisites

- **Node.js 20 or newer**
- **An Agora account** with a project that has:
  - The **Conversational AI Engine** enabled
  - Token authentication enabled (so we can mint RTC + RTM tokens)
- *(Optional)* An **Anam** or **HeyGen** account for a talking-head avatar
- *(Optional)* A **Microsoft Azure** Speech account if you don't want Agora's preset TTS

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Create your local env file from the template
cp .env.example .env.local

# 3. Fill in your real Agora credentials (see "Environment variables" below).

# 4. Run the dev server
npm run dev
```

The app is available at **http://localhost:4000**.

> **Auth:** in production, creating and managing streams requires the shared host PIN configured in `HOST_PIN`. Guest viewing is fully public. Local dev runs in bypass mode by default.

| Route | Who it's for | What it does |
|---|---|---|
| `/` | Host / operator | **Setup screen**: name the channel, optionally give the avatar a topic to be knowledgeable about, pick a response mode (Batched / Sequential) and, for batched, a collection window (10/20/30s). Opening the page as `/?avatar=lemonslice` switches the stream to a **Lemonslice** avatar and reveals an optional avatar image URL field (Lemonslice animates any public portrait image) plus a Female/Male voice toggle. **Create & go live** → server returns a guest link + a private host link and redirects to the host page. |
| `/manage/[hostToken]` | Host | Live console: the avatar goes live automatically and greets the room when the host connects. The host can direct the avatar ("+ Add Script" opens a modal: **Speak** says the text verbatim; **Think** sends a hidden prompt through the LLM and the avatar reacts in its own words), mute the agent locally, ask questions, and copy the guest link. |
| `/stream/[id]` | Guests | Enter a name + email, join the room, watch the avatar, and ask questions in the shared chat. Each new guest is welcomed by name (guests arriving within a few seconds are welcomed together). Unlimited guests per channel. |

### Running a stream end-to-end

1. Open `/`. Name the channel, pick **Batched** or **Sequential** (and a window for batched), then **Create & go live** — you're redirected to `/manage/<hostToken>` and the avatar joins.
2. Copy the **guest link** (`/stream/<id>`) from the host toolbar and share it. Open it in another tab/device to play a guest.
3. Each guest enters a name + email and joins.
4. Guests ask questions in the chat:
   - **Sequential** — questions queue up; the avatar answers them one at a time, in order.
   - **Batched** — questions collect during each window; when it closes, the avatar answers the whole batch in one flowing, host-style reply, then a fresh window opens.
5. Everything the avatar says appears in the chat feed — greeting, guest welcomes, scripted lines, and answers (with a live word-by-word caption on the stage while it speaks, and a typing indicator in the chat). Answers slot in directly under the question(s) they answer.
6. The host can broadcast a scripted line at any time with **+ Add Script → Speak**.
7. Each browser tab is its own participant — open the guest URL in several tabs with different names to simulate a room.

---

## Environment variables

The app ships with **Minimax TTS + Anam avatar** (set at channel creation in `app/page.jsx`). These are what it actually reads:

Required:

| Var | What it is |
|---|---|
| `AGORA_APP_ID` | Your Agora project App ID |
| `NEXT_PUBLIC_AGORA_APP_ID` | Same App ID, exposed to the browser for the RTC/RTM SDKs |
| `AGORA_USERNAME` | Agora REST API customer key |
| `AGORA_PASSWORD` | Agora REST API customer secret |
| `AGORA_APP_CERTIFICATE` | App certificate (needed for token generation; enable token auth in the Agora Console) |
| `ANAM_API_KEY`, `ANAM_AVATAR_ID` | Anam avatar credentials (the avatar is on by default) |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis (channel state) — from the Vercel Marketplace integration, or any Upstash database's REST credentials |
| `HOST_PIN` | Shared 4–12 digit PIN that unlocks host surfaces in production |
| `SESSION_JWT_SECRET` | Signs the 12-hour host session cookie (`openssl rand -hex 48`) |

Optional (defaults shown):

| Var | Default | What it is |
|---|---|---|
| `AGORA_ASR_PRESET` | `deepgram_nova_3` | Agora-managed ASR preset |
| `AGORA_LLM_PRESET` | `openai_gpt_4o_mini` | Agora-managed LLM preset |
| `AGORA_TTS_PRESET` | `minimax_speech_2_6_turbo` | Agora-managed TTS preset; remains at 24 kHz for avatar compatibility |
| `MINIMAX_VOICE_ID` | `English_captivating_female1` | Minimax TTS voice |
| `MINIMAX_VOICE_ID_MALE` | `English_expressive_narrator` | Voice used when the Lemonslice form's toggle is set to Male |
| `LEMONSLICE_API_KEY`, `LEMONSLICE_AVATAR_ID` | — | Lemonslice avatar; the setup screen accepts an agent id or public image URL per stream |
| `TTS_SPEED` | `1.0` | TTS playback speed multiplier |
| `AVATAR_AGORA_UID` | `102` | RTC UID the avatar's video track publishes on |

`.env.example` has the same list with inline comments — use it as the source of truth when filling in `.env.local`.

> `lib/agoraService.js` also contains config branches for **Microsoft Azure TTS** (`TTS_KEY`, `TTS_REGION`, `TTS_VOICE_NAME`), the **OpenAI TTS preset**, and **HeyGen avatars** (`HEYGEN_API_KEY`, `HEYGEN_AVATAR_ID`, `HEYGEN_QUALITY`). The setup screen exposes the avatar provider; the managed Deepgram → OpenAI → MiniMax preset chain remains fixed unless its environment variables are changed.

---

## How the demo works (in 60 seconds)

- Each channel is identified by an 8-character `id`. The id doubles as the Agora RTC + RTM channel name. Channel state (chat feed, queues, speech lock, deadlines) lives in **Upstash Redis**, so any server instance can serve any request — multiple concurrent streams work, and sessions survive instance recycling and redeploys. Channels auto-expire (3h inactive / 30m after ending).
- The host has a separate, unguessable 32-character `hostToken` that authorizes the **Start / Stop / Speak** REST calls. Guests can't derive the host URL from the guest URL.
- The browser joins an Agora **RTC** channel (in `mode: 'live'`) to hear the avatar's voice and see its video. Guests are invisible `audience`; the host joins as a broadcaster (publishing nothing) so the agent detects its arrival and speaks the native `greeting_message`. Only the agent publishes media — Agora supports many subscribers per channel cheaply.
- The browser also joins an Agora **RTM** channel for two things: receiving live channel-state broadcasts from the server (chat feed, queue, presence, agent state), and — via the vendored **Conversational AI toolkit** — receiving agent-state events that drive the speech handoff plus live transcripts that drive the word-by-word caption.
- The Next.js server holds each channel's state and calls Agora's **Think** REST endpoint to answer questions (sequential: one per question; batched: one combined prompt per window) and **Speak** for the host's scripted lines and per-guest welcomes. A server-side speech lock guarantees the avatar answers one thing at a time.
- The avatar's answers land in the shared chat via Agora's **conversation history** REST API (fetched after each utterance, deduped by `turn_id`), so every participant — including late joiners — sees identical history.

---

## Project layout

```
app/                                  # Next.js App Router
  page.jsx                            Setup screen (create a channel)
  stream/[id]/page.jsx                Guest room (join gate → live stream)
  manage/[hostToken]/page.jsx         Host console
  components/stream/                  StreamScreen, StreamStage, ChatRail, StreamParts
  hooks/                              useChannel(channelId, hostToken, creds) + useAgora
  api/channels/                       POST create / GET list, plus [id]/* and by-host-token/[hostToken]
  api/agents/                         Agora platform-level helpers (list / stop / stop-all)
  lib/conversational-ai-api/          Vendored Agora Conversational AI toolkit (TypeScript)
  globals.css                         Design tokens (light / editorial theme)

lib/                                  # Server-side modules (Node)
  channelManager.js                   Per-channel orchestrator: createChannel, getChannel, deleteChannel, listChannels
  agoraService.js                     Agora REST wrapper (joinAgent, speak, think, publishChannelMessage, …)
  tokenService.js                     RTC + RTM token generation + per-client credential minting
```

---

## Deploying (Vercel)

Channel state lives in Upstash Redis (Vercel Marketplace), so the app is fully serverless-safe: multiple concurrent streams, instance scale-out, and redeploys mid-session all work. Time-based behavior (batch windows, welcome batching) is deadline-driven — no server timers.

```bash
vercel link                                  # link the repo to a Vercel project
vercel integration add upstash/upstash-kv    # provisions Redis + KV_* env vars
# add every required var from .env.example (production scope):
vercel env add AGORA_APP_ID production       # …repeat for the rest
vercel env add HOST_PIN production
vercel env add SESSION_JWT_SECRET production
vercel deploy --prod
```

Notes:
- `NEXT_PUBLIC_AGORA_APP_ID` must be set **before** the first build (it's baked into the client bundle).
- For local dev against the same Redis: `vercel env pull` (or copy the `KV_*` values into `.env.local`).
- Stray agents (e.g. a host tab that vanished) self-terminate within 10 minutes via `idle_timeout`; `POST /api/agents/stop-all` is the manual kill switch.

## Troubleshooting

**The avatar joins but never answers questions.**
The agent's RTC token must include RTM privileges (`buildTokenWithRtm2`) so it can publish presence + `state.speaking` events. Without them the client can't tell the server the agent stopped speaking, and the speech lock never releases — so the sequential queue never advances / the next batch window never opens.

**Avatar video doesn't appear (only audio works).**
With the **Minimax** TTS preset + **Anam** avatar, the TTS must be at `audio_setting.sample_rate: 24000`. Anam consumes 24 kHz; Minimax defaults to 32 kHz and the avatar silently drops the stream. Set in `lib/agoraService.js`.

**The avatar speaks a non-English language.**
TTS vendors auto-detect language. Force English via the relevant config field: Minimax `language_boost: 'English'`, OpenAI `instructions: 'Always speak in English…'`.

**"N WATCHING" is wrong / zero.**
Presence is a server-side heartbeat: each guest POSTs `/api/channels/[id]/presence` every 15s and entries expire after 30s. If a guest tab is closed the count drops within 30s. It does not use raw RTM occupancy (which would double-count the two RTM identities each viewer holds).

**"Invalid host link" on /manage/<...>.**
The channel was evicted from the in-memory map (30 min after being stopped, or 2 hours idle in IDLE). Create a new one from `/`.

**Port 4000 already in use.**
Change the port in `package.json`'s `dev` script or run `PORT=4001 npm run dev`.

---

## License

This is a demo / reference project, provided as-is without warranty. You are responsible for your own Agora, Anam/HeyGen, and TTS vendor accounts, credentials, and usage costs.
