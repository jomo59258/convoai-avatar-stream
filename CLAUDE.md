# AI Avatar Stream — Agora Conversational AI Demo

## Project Overview

A 1-to-many live "avatar stream" built on Agora's Conversational AI Engine. A host creates a channel from the setup screen (`/`), gets two URLs (a shareable guest link and a private host link), and goes live with an AI avatar. Unlimited guests join the guest link, watch the avatar, and ask questions in a shared group chat. The avatar answers the room in one of two **response modes**. Multiple channels run concurrently and independently. State for each channel lives in **Upstash Redis** (`lib/channelStore.js`), so any serverless instance can serve any request (multi-stream safe on Vercel); RTM broadcasts the state snapshot to every client, and RTC (mode=live, audience role) streams the avatar's audio/video.

This is a **demo project** forked from an earlier "AI Auctioneer" build — it reuses that project's Agora plumbing (RTC audience streaming, RTM state broadcast, the vendored Web toolkit for agent-state events, per-session token minting, avatar integration, and the server-side speech lock) but replaces the auction domain (bids, lots, going-once/twice/sold, balances) with a simple group-chat-with-an-avatar experience. The UI matches the design in `claude_design/project/AI Avatar App.dc.html`.

---

## Development Workflow (ALWAYS follow this)

Features and fixes NEVER go straight to `main`:

1. **Branch**: `git checkout -b feat/<slug>` (or `fix/<slug>`).
2. **Implement**, then verify locally: `npm run build` green AND `npm test` green. If the user's dev server may be running, build with `NEXT_DIST_DIR=.next-verify npm run build` — a shared `.next` between build and dev corrupts the dev server's webpack cache (ENOENT noise / unhandledRejections).
3. **Hand off for local testing**: the user tests on their own dev server (`npm run dev`, port 4000). **STOP and wait for their explicit approval** — do not push, PR, or deploy before it.
4. **PR**: push the branch, `gh pr create` with a summary + test plan. Merge with `gh pr merge --squash` after the user OKs, then `git checkout main && git pull`.
5. **Deploy**: `npm run deploy` (runs the test suite, then `vercel deploy --prod` — the suite is the deploy gate). Deploy deliberately: a prod redeploy ends any live streams.

## Auth (host PIN — hosts only, production only)

Hosting surfaces are gated behind a shared **host PIN**; **guest viewing is fully public**. `POST /api/auth/pin` verifies `HOST_PIN` and issues an HttpOnly JWT cookie signed by `SESSION_JWT_SECRET`; there is no identity database.

- **Modes** (`authMode()` in `lib/auth.ts`): non-production defaults to `bypass` unless `AUTH_MODE=pin`; production always requires `pin` and fails closed when `HOST_PIN` is missing or invalid.
- **Gated (session required via `requireSession()` in `lib/authGuard.js`, checked BEFORE hostToken):** `POST+GET /api/channels`, `by-host-token`, `credentials?role=host`, `start`, `stop`, `speak`, `think`, channel `DELETE`. Pages: `/` (sign-in card, guest paste-a-link stays public) and `/manage/[hostToken]` (sign-in card; bootstrap effects gated on `authed` so no 401 noise).
- **Public (guests):** `/stream/[id]`, `state`, `message`, `presence`, `agent-state`, `transcript`, `credentials?role=guest`.
- **Host login:** a correct 4–12 digit `HOST_PIN` creates a 12-hour session. All host surfaces return 401 without that session; guest routes remain ungated.
- Note: `@/*` path alias maps to repo root (`tsconfig.json`) because the vendored files import `@/lib/auth` and this repo has no `src/`.

## Testing

`npm test` (Vitest) runs the channel-logic suite in `tests/`: real Upstash Redis (creds from `.env.local` via `@next/env`), **Agora fully mocked** (`tests/helpers/agoraMock.js` — no real agents, no cost). Tests exercise `lib/channelManager.js` directly; every test cleans up its channels (`deleteChannel`) so the shared Redis DB stays tidy. Deadline behavior is tested by writing past deadlines into Redis and calling `channel.tick()` — never by sleeping. `npm run test:watch` for development.

---

## Architecture

Next.js 14 (App Router) with API routes for server logic and React client pages for the UI. Per-channel state lives in Upstash Redis (atomic native structures; short NX locks serialize cross-instance dispatch). There are NO in-process timers: batch/welcome windows are deadline fields in Redis, driven by `tickChannel()` on hot routes plus a client poke when the HUD countdown hits zero. RTM carries both Conversational-AI events (toolkit-mediated) and server→client state broadcasts — snapshots carry a monotonic `rev` so clients drop out-of-order broadcasts.

```
┌──────────────────────────┐        ┌─────────────────────┐
│  Next.js App             │        │ Agora Convo AI      │
│                          │──REST─▶│ Agent (v2.6)        │
│  Client pages:           │        │ - Think (answer Qs) │
│   /            (setup)   │        │ - Speak (host script)│
│   /stream/[id]  guest    │        └─────────────────────┘
│   /manage/[token] host   │
│                          │        ┌─────────────────────┐
│  Toolkit per tab ────────┼──RTM──▶│ Agora RTM (v2)      │
│  (agent-state events)    │        │  channel = channel id│
│                          │        │  - presence          │
│  Routes (per-channel):   │        │  - state broadcast   │
│  /api/channels           │        └─────────────────────┘
│  /api/channels/[id]/*    │
│                          │        ┌─────────────────────┐
│  Server modules:         │──RTC──▶│ Agora RTC mode=live │
│  - channelManager        │        │ Agent = publisher    │
│  - agoraService          │        │ All clients = audience│
│  - tokenService          │        │  channel = channel id │
└──────────────────────────┘        └─────────────────────┘
```

### How the AI Agent Is Used

One agent is started **per channel** with a friendly-host system prompt (`buildHostSystemPrompt(title, topic)` in `channelManager.js`). Preset is ASR + LLM + TTS (`deepgram_nova_3`, `openai_gpt_4o_mini`, `minimax_speech_2_6_turbo`). Two server-side calls drive it:

- **`/think`** — answers audience questions through the LLM, spoken via TTS. Sequential mode sends one question at a time; batched mode sends one combined prompt per window.
- **`/speak`** — the host's manual scripted lines (bypasses the LLM, straight to TTS).

The host's **+ Add Script** modal drives both: Speak → `speakScript` (verbatim, shows as AGENT · SCRIPTED), Think → `thinkScript` (host prompt through the LLM; **"answer only"** — the prompt never appears in the feed or caption, no anchor is set, and the answer lands at the feed end like any agent turn). If the avatar is mid-utterance a think prompt queues in the `promptq` LIST; `markSpeechDone` flushes it after deferred welcomes and BEFORE mode logic — the host jumps the guest queue but never interrupts.

The agent join request must enable `advanced_features.enable_rtm: true`, `parameters.data_channel: 'rtm'`, `enable_metrics: true`, and `enable_error_message: true`. The **agent token must include both RTC and RTM privileges** (`RtcTokenBuilder.buildTokenWithRtm2`) — without RTM privileges, presence/state events never reach clients and the speech lock never releases.

### Response Modes

Chosen by the host at setup, stored on the channel instance:

- **Sequential** — each guest question is pushed to `questionQueue`. `drainQueue()` answers one at a time via `/think`; the next is dispatched only when the previous answer's speech releases the lock.
- **Batched** — guest questions collect in the `batch` LIST during a fixed window (`collectionWindowMs`, 10/20/30s). When the stored `batchDeadline` passes (detected by `tickChannel()` on any hot request, or the HUD's zero-cross poke), `closeBatchWindow()` sends one combined `/think` prompt for the whole batch; after the answer, `markSpeechDone()` calls `openBatchWindow()` to start the next window.

Both modes are serialized by the **speech lock** — the avatar answers exactly one thing at a time.

---

## Project Structure

```
convoai_stream/
├── CLAUDE.md                           ← This file
├── README.md                           ← Customer-facing
├── claude_design/                      ← Static UI prototype (design source of truth)
├── lib/                                ← Server-side modules (Node, ESM .js)
│   ├── agoraService.js                 ← Agora REST wrapper: joinAgent, speak, think, leaveAgent, listAgents, publishChannelMessage
│   ├── channelManager.js               ← Per-channel orchestrator on Redis — modes, messages, queue, batch, speech lock, tickChannel
│   ├── channelStore.js                 ← Redis layer (Upstash): key layout, TTLs, NX locks
│   └── tokenService.js                 ← RTC + RTM token generation; generateClientCredentials for per-guest minting
├── app/
│   ├── layout.js                       ← Loads Instrument Serif, Space Grotesk, JetBrains Mono
│   ├── globals.css                     ← Design tokens (light / editorial theme) + keyframes
│   ├── page.jsx                        ← Setup screen (create a channel)
│   ├── stream/[id]/page.jsx            ← Guest room (join gate → connecting → stream)
│   ├── manage/[hostToken]/page.jsx     ← Host console
│   ├── components/
│   │   ├── ConfirmModal.jsx            ← Design-language confirm dialog (End stream)
│   │   ├── ErrorScreen.jsx             ← Invalid-link / ended-stream screens
│   │   └── SignInCard.jsx              ← Host PIN card (/ and /manage)
│   ├── components/stream/
│   │   ├── StreamScreen.jsx            ← Responsive orchestrator (desktop/mobile), composes stage + rail
│   │   ├── StreamStage.jsx             ← Avatar stage: state pill, HUD, live caption, host controls
│   │   ├── ChatRail.jsx                ← Presence, sequential queue, message feed, composer
│   │   ├── DirectAvatarModal.jsx       ← + Add Script modal: Speak (verbatim) / Think (LLM prompt)
│   │   ├── JoinQr.jsx                  ← Scan-to-join QR (desktop)
│   │   └── StreamParts.jsx             ← StatePill, LivePill, PresencePill, AvatarStage, Spinner, CaptionBars
│   ├── lib/                            ← Client-side helpers (TypeScript)
│   │   ├── conversational-ai-api/      ← Vendored Agora Web toolkit (agent-state events)
│   │   └── latency-metrics.ts          ← Stub the toolkit imports
│   ├── hooks/
│   │   ├── useAgoraAuth.ts             ← Client host-session state and PIN login/logout actions
│   │   ├── useChannel.js               ← Subscribes to id as RTM channel; state snapshot + actions (sendMessage, speakScript, start, stop, sendPresence)
│   │   └── useAgora.js                 ← RTC + RTM client mgmt + toolkit init. mode='live' + audience role.
│   └── api/
│       ├── channels/
│       │   ├── route.js                        ← POST create, GET list
│       │   ├── by-host-token/[hostToken]/route.js  ← Resolve host token → {id, state}
│       │   └── [id]/
│       │       ├── route.js                    ← DELETE (host)
│       │       ├── state/route.js              ← Public poll
│       │       ├── credentials/route.js        ← Mint per-client RTC + RTM token (role=guest|host)
│       │       ├── message/route.js            ← Post a chat message (guest → question, host → chat-only)
│       │       ├── presence/route.js           ← Heartbeat for "N WATCHING"
│       │       ├── agent-state/route.js        ← Toolkit-fired speech-done notify
│       │       ├── transcript/route.js         ← Clients post finished agent turns (deduped by turn_id)
│       │       ├── start/route.js              ← Host-only: agent join + go live
│       │       ├── stop/route.js               ← Host-only
│       │       ├── speak/route.js              ← Host-only manual TTS script
│       │       └── think/route.js              ← Host-only LLM prompt (answer-only)
│       └── agents/                     ← list, stop, stop-all (Agora-platform tools, not per-channel)
└── public/
```

---

## Key Concepts

### 1. Channel Manager (`lib/channelManager.js`) — Per-Channel Instances

State for all channels lives in **Redis** (see `lib/channelStore.js` for the key layout): scalars in `ch:{id}:meta` (HASH), the feed in `ch:{id}:messages` (ZSET — fractional scores let answers insert at their anchor), queues/buffers as LISTs, dedupe sets as SETs, plus `token:{hostToken}` → id and a `channels:index` SET. Lifecycle status is a plain string in meta: `IDLE` → `LIVE` → `CLOSED`.

Public exports (ALL async): `createChannel(opts)`, `getChannel(id)` → `{notifyAgentState, start, stop, sendMessage, speakScript, addAgentTranscript, heartbeat, getState, tick}`, `getChannelByHostToken(token)`, `deleteChannel(id)`, `listChannels()`, `tickChannel(id)`.

**Cross-instance serialization** uses short Redis NX locks (`lock:dispatch` for anything taking the speech lock; `lock:release` for speech-done dedupe; `lock:histsync`). Hot-path mutations use atomic native ops (ZADD/RPUSH/SADD/HSET) — never read-modify-write.

Cleanup: rolling TTLs (3h active, 30m after CLOSED) replace the old sweep; `listChannels` prunes expired ids from the index lazily. There is no orphan-agent startup sweep anymore — agents self-terminate via `idle_timeout: 600`, and `/api/agents/stop|stop-all` is the manual kill switch.

### 2. The Speech Lock (drives both modes)

`speakNow()`/`/think` set `isSpeaking = true` optimistically. When the agent stops, Agora emits `state.speaking = false` over RTM; `useChannel`'s message handler POSTs `/agent-state {state:'idle'}` → `notifyAgentState` → `markSpeechDone()`. `markSpeechDone` releases the lock and then, **by mode**: sequential → `drainQueue()` (answer the next queued question); batched → `openBatchWindow()` if we just finished answering, or `closeBatchWindow()` if a window closed while the agent was mid-script (`batchPendingAnswer`).

`speaking` and `thinking` states are ignored (mid-cycle). Multiple clients post the same transition; the server dedupes with a 300ms Redis NX lock (`lock:release`). Do **not** dedupe on `turnID` — with the `/speak`+`/think` flow it stays at 1 forever. **No fallback timer** — the RTM event is authoritative; if RTM dies the channel stalls (acceptable for a demo).

### 3. Two URLs / Host Auth

| URL | Who | Auth | What |
|---|---|---|---|
| `/stream/[id]` | Guests | none | 8-char channel slug — public, shareable |
| `/manage/[hostToken]` | Host | the 32-char hostToken IS the auth | Live console; auto-starts the agent on load |

Host-only routes verify `request.headers.get('x-channel-host-token')` against `getChannelByHostToken(token).id === id`. `/message` derives `isHost` from that header (never trusted from the body) so a guest can't post as the host.

### 4. Two RTM Identities per Tab

Each guest/host tab mints **two** independent credential sets (two UIDs) via `/credentials` — one for `useAgora` (RTC + toolkit RTM), one for `useChannel` (state-broadcast RTM). RTM v2 allows only one session per `(appId, userId)`; sharing a UID would make the second login silently evict the first. The `useChannel` UID is the tab's canonical identity — messages, queue rows, and presence all key on it (`myUid`).

### 5. Presence ("N WATCHING")

Server-side participant set + client heartbeat. The stream page POSTs `/presence {uid, name}` on mount and every 15s; `getState()` prunes entries older than 30s and returns `presence = participants.size`. This avoids the RTM-occupancy double-count (each viewer holds two RTM identities, plus the agent/avatar UIDs).

### 6. Tokens + RTC Mode (`lib/tokenService.js`)

Every tab fetches `GET /api/channels/[id]/credentials?role=guest|host` → `{uid, rtcToken, rtmToken, channelName, role}`. UIDs are allocated in the 1M–9M range (reserved 100/101/102 belong to agent/user/avatar). Both roles get a SUBSCRIBER RTC token; only the agent (and avatar) publish. RTC mode is `'live'` with `setClientRole('audience')` — this is what makes "unlimited guests" tractable.

### 7. Vendor Configuration

| Vendor | Type | Notes |
|---|---|---|
| **Minimax (preset)** | TTS | Default. Requires `language_boost: 'English'` and `audio_setting.sample_rate: 24000` (else Anam audio sync breaks). |
| **Anam** | Avatar | Default. `sample_rate: 24000`, `video_encoding: 'H264'`, `quality: 'high'`. |
| **Lemonslice** | Avatar | No dedicated ConvoAI vendor — uses the **generic avatar** interface: `vendor: 'generic'`, `api_base_url: https://lemonslice.com/api/liveai/agora`, plus `sample_rate: 24000`, `version: 'v1'`, `area`. Selected per channel via the setup-page query param `/?avatar=lemonslice` (allowlist: anam, lemonslice, heygen — no vendor form UI by design; when active, the form shows an optional AVATAR IMAGE URL field; entering an image also reveals a Female/Male voice toggle — `voiceGender` in meta selects `MINIMAX_VOICE_ID` vs `MINIMAX_VOICE_ID_MALE`, default `English_expressive_narrator`). `avatar_id` accepts a Lemonslice agent id OR a public https image URL — the per-stream image (stored as `avatarImageUrl` in meta) wins over the `LEMONSLICE_AVATAR_ID` env default. Env: `LEMONSLICE_API_KEY`, `LEMONSLICE_AVATAR_ID`. |
| **HeyGen** | Avatar | Custom vendor; `vendor: 'liveavatar'` in Agora config. |

---

## Environment

Runs on **port 4000** (`next dev -p 4000`). See `.env.example` for the full list. Required: `AGORA_APP_ID`, `NEXT_PUBLIC_AGORA_APP_ID`, `AGORA_USERNAME`, `AGORA_PASSWORD`, `AGORA_APP_CERTIFICATE`, `AGORA_PRESET` (+ `AGORA_PRESET_ASR_LLM`). TTS: `MINIMAX_VOICE_ID` (+ `MINIMAX_VOICE_ID_MALE` for the Lemonslice voice toggle), `TTS_SPEED` (default 1.0). Avatar: `AVATAR_AGORA_UID`, `ANAM_API_KEY`, `ANAM_AVATAR_ID` (or HeyGen).

---

## Common Gotchas / Lessons Learned

1. **Agent token needs RTM privileges** (`buildTokenWithRtm2`). Without them the toolkit never fires agent-state events, `state.speaking=false` never arrives, the speech lock never releases, and the sequential queue / batch window stalls after the first answer.

2. **Minimax TTS + Anam avatar requires `audio_setting.sample_rate: 24000`.** Minimax defaults to 32 kHz; Anam consumes only 24 kHz and silently drops the stream. Set in `lib/agoraService.js`.

3. **`thinking` must NOT release the speech lock.** The agent goes `thinking → speaking → listening`; only `listening`/`silent`/`idle` release. `notifyAgentState` handles this.

4. **The toolkit doesn't synthesize an initial presence event** for a client that subscribes mid-speech — it may only see the trailing `→ listening`. Fine here: the server's `if (!a.isSpeaking) return` guard in `notifyAgentState` absorbs irrelevant transitions.

5. **Two RTM identities per tab** — never share a UID between `useAgora` and `useChannel`. Presence and message identity key on the `useChannel` UID only.

6. **State-message disambiguation** — server snapshots carry `type: 'state'`. `useChannel`'s RTM handler keys on it so a full snapshot is never confused with an agent `state.speaking` event.

7. **Batch timer surviving the lock is intentional** — no timer runs during the "answering" phase; the next window is armed in `markSpeechDone → openBatchWindow`. Questions arriving during answering accumulate for the next window.

8. **No in-process timers, ever.** Server timers don't survive serverless. Time-based behavior = deadline fields in Redis (`batchDeadline`, `welcomeDeadline`) + `tickChannel()` on hot routes + the HUD's zero-cross poke. If you add a new timed behavior, add a deadline field and extend `tick()` — do NOT reach for `setTimeout`. (The old "helpers must close over the instance" invariant died with the in-memory Map.)

9. **Next 14 params** — `params` in pages and route handlers is a plain object; destructure directly (`const { id } = params`). The Next 15 `await params` pattern would throw.

10. **Don't log tokens.** `joinAgent` logs only `[Agora] JOIN <channelName> (tts=…, avatar=…)`.

11. **State is in Upstash Redis — safe across instances/redeploys, bounded by TTL.** Channels expire after 3h of inactivity (30m once CLOSED); every mutating route refreshes the TTL. Snapshots carry a monotonic `rev` (HINCRBY on broadcast) and `useChannel` drops out-of-order snapshots — keep that when adding broadcast paths. Requires `KV_REST_API_URL`/`KV_REST_API_TOKEN` (Vercel Marketplace Upstash integration; same DB for local dev via `.env.local`).

12. **The native `greeting_message` only fires for users the agent can SEE join.** The agent tracks exactly the UIDs in `remote_rtc_uids` (immutable after join — `/update` can't change it), and only *visible* (broadcaster-role) joins count; audience joins are invisible in live mode. That's why the host tab joins RTC as `host` role with a PUBLISHER token and its real UID is passed through `start({hostUid})` into `remote_rtc_uids`. The wildcard `'*'` is rejected when an avatar is enabled.

13. **Agent answers reach the chat feed via the REST history API (primary) + client transcripts (secondary).** The LLM's think-answers are generated inside Agora's pipeline — the server never sees the text at dispatch. PRIMARY: `markSpeechDone` fires `syncAgentHistory()` → `GET /agents/{id}/history` (works mid-session; answers are written when the LLM completes, before speech ends) → appends `role: 'assistant'` turns to the feed. SECONDARY: clients receive real transcripts via the toolkit's `TRANSCRIPT_UPDATED` events (`useAgora`); IN_PROGRESS turns drive the live word-by-word caption locally; on END/INTERRUPTED they POST `/transcript {turnId, text, interrupted}` (this also covers the native greeting, which never appears in LLM history). Both sources funnel through `addAgentTranscript`, deduped by `turn_id` — first wins. **Trap — never classify transcript items by uid.** The toolkit's uid heuristic (`stream_id ? self : publisher`) is inverted for our server-injected-text flow: agent answers ride the agent's audio stream (`stream_id != 0`) so they're labeled uid `'0'` (self), while the `/think` question echo (`user.transcription`, `stream_id: 0`) gets the agent publisher's uid `'100'`. Classify by message type only: `metadata.object === 'user.transcription'` → exclude; everything else is an agent turn. Also judge finality/text from the raw `metadata` (`status`/`turn_status`, full `text`) — the item's own `text`/`status` only advance with the audio-PTS word reveal (requires `ENABLE_AUDIO_PTS_METADATA` set before `createClient`). ALL avatar speech shows in the feed: `speakNow` pushes the bubble itself for every `/speak` utterance (welcomes → `AVATAR`, scripts → `AGENT · SCRIPTED`), think-answers and the native greeting arrive via the transcript path. `speakNow` records normalized `recentSpeakTexts` as an echo guard so the TTS transcripts of its own utterances don't double-post — that guard deliberately does not consume the turn_id, since `/speak` flows can reuse turn ids.

14. **Greeting system is hybrid: native for the host, `/speak` welcomes for guests.** The native `greeting_message` opens the stream when the host connects. Guests (invisible audience, random UIDs) can't trigger it, so `channelManager` welcomes them by name: the FIRST presence heartbeat from a new guest UID queues a welcome; guests arriving within `WELCOME_BATCH_MS` (4s) are announced in one utterance ("Welcome A, B, and C to the stream!"); if the avatar is mid-utterance the flush defers to `markSpeechDone` (welcomes take the lock before the next question — never interrupt, and `/speak` uses APPEND besides). Dedupe is by uid AND normalized name, so a tab refresh (new UID, same name) doesn't re-welcome. Host exemption comes from the `X-Channel-Host-Token` header on `/presence` — never from the request body.

---

## Reference

- Agora Conversational AI v2.6 docs: <https://docs.agora.io/en/conversational-ai>
- `/think`: `POST /api/conversational-ai-agent/v2/projects/{appid}/agents/{agentId}/think`
- `/speak`: `POST /api/conversational-ai-agent/v2/projects/{appid}/agents/{agentId}/speak`
- Toolkit source (vendored): <https://github.com/AgoraIO-Community/Conversational-AI-Demo/tree/main/Web/Scenes/VoiceAgent/src/conversational-ai-api>
