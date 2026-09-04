// Channel Manager — per-channel orchestrator for the AI Avatar Stream.
//
// State lives in Redis (see lib/channelStore.js), NOT process memory, so any
// serverless instance can serve any request: multiple concurrent streams work
// on Vercel and survive instance shuffles/redeploys.
//
// There are NO in-process timers. Time-based behavior (batch windows, welcome
// batching) is stored as DEADLINE fields in the channel meta and driven by
// tickChannel(), which hot routes call on every request (state polls every
// 10s, presence every 15s, plus a client tick when the HUD countdown hits 0).
//
// Cross-instance races are serialized with short Redis NX locks:
//   lock:dispatch  — anything that takes the speech lock (drain/close/flush)
//   lock:release   — speech-done dedupe (N clients report the same transition)
//   lock:histsync  — one history fetch at a time
//
// The agent answers audience questions in one of two response modes:
//   - sequential: questions queue up; the agent answers one at a time.
//   - batched:    questions collect for a window; at close the agent answers
//                 the whole room at once, then a new window opens.
// Both modes are serialized by the speech lock (isSpeaking in meta), released
// by clients posting /agent-state when the RTM state.speaking=false event fires.

import * as agora from './agoraService.js';
import {
  redis, k, tokenKey, INDEX_KEY,
  touchChannel, acquireLock, releaseLock, lockKey,
  LIVE_TTL_S, CLOSED_TTL_S,
} from './channelStore.js';

const IDLE_STATES = new Set(['listening', 'silent', 'idle']);
const PRESENCE_TTL_MS = 30 * 1000;
const WELCOME_BATCH_MS = 4000;
const FEED_CAP = 200;

// --- ID generation ---

const ID_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';

function randomId(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

// --- Prompt builders ---

function buildHostSystemPrompt(title, topic) {
  return [
    `You are a friendly live host running a 1-to-many stream${title ? ` called "${title}"` : ''}.`,
    topic ? `The topic of this stream is: ${topic}.` : '',
    'Answer audience questions warmly and concisely — usually 1 to 3 sentences.',
    'Your words are spoken aloud by a live avatar — always reply in natural spoken prose. Never use numbered lists, bullet points, headings, or any written formatting.',
    'When several questions arrive together, respond like a live host reading the chat: weave the answers into one flowing reply, group related questions, and address people by name when it feels natural. Make sure every question gets answered, then invite more.',
    'Keep the energy up and conversational. Never mention that you are an AI model unless you are directly asked.',
  ].filter(Boolean).join(' ');
}

function buildBatchPrompt(questions) {
  // No numbering — numbered input invites a numbered answer, which sounds
  // robotic when spoken. Present the batch as a plain chat log instead.
  const lines = questions
    .map((q) => `${q.user || 'Someone'}: ${q.text}`)
    .join('\n');
  return `Here are the questions from the room since your last answer:\n${lines}\n\nRespond to the room in one natural, flowing spoken reply — like a live host reading the chat. Cover every question, group related ones together, and mention people by name where it helps. Do not enumerate or number your answers.`;
}

function buildGreeting(title) {
  return `Hey everyone, welcome${title ? ` to ${title}` : ''}! I'm your host. Drop your questions in the chat and I'll answer them live.`;
}

function buildWelcome(names) {
  if (names.length === 1) return `Welcome ${names[0]} to the stream!`;
  if (names.length === 2) return `Welcome ${names[0]} and ${names[1]} to the stream!`;
  return `Welcome ${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]} to the stream!`;
}

// Punctuation maps to a SPACE (then collapsed) — Agora transcripts drop the
// space after punctuation ("everyone,welcome"), so stripping punctuation
// without a space would make the transcript normalize differently from the
// text we sent, and the echo guard would miss it.
function normalizeText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Agora's transcript/history text is segmented at punctuation for TTS and
// rejoined without spaces ("Paris!It's…"). Re-insert a space after sentence
// punctuation when followed by a letter — never a digit (protects 3.14 / 1,000).
function fixPunctuationSpacing(s) {
  return (s || '').replace(/([.,!?;:])(?=[A-Za-z])/g, '$1 ');
}

// --- Feed helpers (ZSET) ---

// zrange(..., { withScores: true }) returns a flat [member, score, …] array.
function parseFeed(flat) {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    out.push({ msg: flat[i], score: Number(flat[i + 1]) });
  }
  return out;
}

async function appendMessage(id, msg) {
  const p = redis.pipeline();
  p.zadd(k(id, 'messages'), { score: msg.id, member: msg });
  p.zremrangebyrank(k(id, 'messages'), 0, -(FEED_CAP + 1));
  await p.exec();
}

async function nextMsgId(id) {
  return await redis.incr(k(id, 'msgseq'));
}

// --- Multi-channel lifecycle ---

export async function createChannel(opts = {}) {
  const id = randomId(8);
  const hostToken = randomId(32);

  const meta = {
    id,
    hostToken,
    status: 'IDLE',                // 'IDLE' | 'LIVE' | 'CLOSED'
    mode: opts.mode === 'sequential' ? 'sequential' : 'batched',
    collectionWindowMs: 30000,
    channelTitle: (opts.channelTitle || '').toString().slice(0, 120),
    hostName: (opts.hostName || 'Host').toString().slice(0, 60),
    topic: (opts.topic || '').toString().slice(0, 500),
    ttsVendor: opts.ttsVendor || '',
    avatarVendor: opts.avatarVendor || '',
    avatarImageUrl: (opts.avatarImageUrl || '').toString().slice(0, 500),
    voiceGender: ['male', 'female'].includes(opts.voiceGender) ? opts.voiceGender : '',
    ttsSpeed: opts.ttsSpeed || '',
    enableAvatar: !!(opts.avatarVendor && opts.avatarVendor !== 'none'),
    agentId: '',
    isSpeaking: false,
    answerPending: false,
    answerAnchorId: 0,
    agentState: 'idle',
    caption: '',
    lastSpokenText: '',
    batchPhase: 'collecting',
    batchDeadline: 0,
    welcomeDeadline: 0,
    batchPendingAnswer: false,
    rev: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  const win = Number(opts.collectionWindowMs);
  if (Number.isFinite(win) && win >= 5000 && win <= 300000) meta.collectionWindowMs = win;

  const p = redis.pipeline();
  p.hset(k(id, 'meta'), meta);
  p.set(tokenKey(hostToken), id);
  p.sadd(INDEX_KEY, id);
  await p.exec();
  await touchChannel(id, LIVE_TTL_S, hostToken);

  console.log(`[ChannelManager:${id}] Created (hostToken=${hostToken.slice(0, 8)}…, mode=${meta.mode}, avatar=${meta.enableAvatar})`);

  return { id, hostToken, guestUrl: `/stream/${id}`, hostUrl: `/manage/${hostToken}` };
}

export async function getChannelByHostToken(token) {
  if (!token) return null;
  const id = await redis.get(tokenKey(token));
  if (!id) return null;
  return getChannel(id);
}

export async function deleteChannel(id) {
  const meta = await redis.hgetall(k(id, 'meta'));
  if (meta?.agentId) {
    try {
      await agora.leaveAgent(meta.agentId, id);
    } catch (err) {
      console.error(`[ChannelManager:${id}] leaveAgent during delete failed:`, err.message);
    }
  }
  const p = redis.pipeline();
  for (const s of ['meta', 'messages', 'msgseq', 'queue', 'batch', 'participants', 'welcomed', 'welcomeq', 'promptq', 'turns', 'speaktexts']) {
    p.del(k(id, s));
  }
  if (meta?.hostToken) p.del(tokenKey(meta.hostToken));
  p.srem(INDEX_KEY, id);
  await p.exec();
  console.log(`[ChannelManager:${id}] Deleted`);
}

export async function listChannels() {
  const ids = await redis.smembers(INDEX_KEY);
  const out = [];
  for (const id of ids) {
    const meta = await redis.hgetall(k(id, 'meta'));
    if (!meta) {
      await redis.srem(INDEX_KEY, id); // expired — prune the index lazily
      continue;
    }
    out.push({
      id,
      status: meta.status,
      mode: meta.mode,
      channelTitle: meta.channelTitle,
      createdAt: meta.createdAt,
      lastActivityAt: meta.lastActivityAt,
      hostUrl: meta.hostToken ? `/manage/${meta.hostToken}` : null,
      guestUrl: `/stream/${id}`,
    });
  }
  return out;
}

// --- Per-channel interface ---

export async function getChannel(id) {
  if (!id) return null;
  const exists = await redis.exists(k(id, 'meta'));
  if (!exists) return null;

  const log = (...args) => console.log(`[ChannelManager:${id}]`, ...args);
  const meta = () => redis.hgetall(k(id, 'meta'));

  // ---------- state snapshot + broadcast ----------

  async function getState() {
    const [m, feedFlat, queue, batchCount, participants] = await Promise.all([
      meta(),
      redis.zrange(k(id, 'messages'), 0, -1, { withScores: true }),
      redis.lrange(k(id, 'queue'), 0, -1),
      redis.llen(k(id, 'batch')),
      redis.hgetall(k(id, 'participants')),
    ]);
    if (!m) return null;

    // Prune stale participants lazily.
    const now = Date.now();
    const stale = [];
    let presence = 0;
    for (const [uid, p] of Object.entries(participants || {})) {
      if (now - (p?.lastSeen || 0) > PRESENCE_TTL_MS) stale.push(uid);
      else presence++;
    }
    if (stale.length) redis.hdel(k(id, 'participants'), ...stale).catch(() => {});

    redis.hset(k(id, 'meta'), { lastActivityAt: now }).catch(() => {});

    return {
      type: 'state',
      rev: Number(m.rev) || 0,
      status: m.status,
      mode: m.mode,
      collectionWindowMs: Number(m.collectionWindowMs) || 30000,
      channelTitle: m.channelTitle || '',
      hostName: m.hostName || 'Host',
      agentId: m.agentId || null,
      channelName: id,
      enableAvatar: !!m.enableAvatar,
      isSpeaking: !!m.isSpeaking,
      answerPending: !!m.answerPending,
      answerAnchorId: Number(m.answerAnchorId) || null,
      agentState: m.agentState || 'idle',
      caption: m.caption || '',
      lastSpokenText: m.lastSpokenText || null,
      messages: parseFeed(feedFlat).map((e) => e.msg),
      queue: (queue || []).map((q, i) => ({ ...q, position: i })),
      batchPhase: m.batchPhase || 'collecting',
      batchCount: Number(batchCount) || 0,
      batchDeadline: Number(m.batchDeadline) || null,
      presence,
    };
  }

  async function broadcastState() {
    try {
      const rev = await redis.hincrby(k(id, 'meta'), 'rev', 1);
      const snap = await getState();
      if (!snap) return;
      snap.rev = rev;
      await agora.publishChannelMessage(id, snap);
    } catch (err) {
      console.error(`[ChannelManager:${id}] broadcast error:`, err);
    }
  }

  // ---------- speech ----------

  async function speakNow(text, type) {
    const m = await meta();
    if (!m?.agentId) return;

    const norm = normalizeText(text);
    const msgId = await nextMsgId(id);
    const p = redis.pipeline();
    p.hset(k(id, 'meta'), {
      isSpeaking: true,
      agentState: 'speaking',
      caption: `“${text}”`,
      lastSpokenText: text,
    });
    // Echo guard: the TTS of this utterance comes back as a transcript too.
    p.rpush(k(id, 'speaktexts'), norm);
    p.ltrim(k(id, 'speaktexts'), -8, -1);
    await p.exec();
    // Everything the avatar says shows in the feed.
    await appendMessage(id, {
      id: msgId, uid: 'agent', user: 'AVATAR', text, kind: 'agent',
      ...(type === 'script' ? { scripted: true } : {}),
    });
    await broadcastState();

    try {
      log(`Speaking (${type}): "${text}"`);
      await agora.speak(m.agentId, text, 'APPEND', true, id);
    } catch (err) {
      console.error(`[ChannelManager:${id}] Speak error:`, err);
      await redis.hset(k(id, 'meta'), { isSpeaking: false, agentState: 'listening', caption: '' });
      await broadcastState();
    }
  }

  async function markSpeechDone() {
    log('Speech done');
    // Land the just-finished answer FIRST — and do it while isSpeaking still
    // holds the speech lock. Clearing the lock before this await would let a
    // concurrent /message drainQueue() mid-sync and overwrite answerAnchorId
    // before the answer is placed (observed in prod as "my comment showed
    // before the answer to his question").
    await syncAgentHistory();

    await redis.hset(k(id, 'meta'), {
      isSpeaking: false,
      answerPending: false,
      agentState: 'listening',
      caption: '',
    });

    // Deferred guest welcomes next (their window already elapsed mid-speech;
    // an OPEN window — welcomeDeadline set — is left for tickChannel).
    const m = await meta();
    const pendingWelcomes = await redis.llen(k(id, 'welcomeq'));
    if (pendingWelcomes > 0 && !Number(m.welcomeDeadline)) {
      const spoke = await flushWelcomes();
      if (spoke) return; // flush broadcast via speakNow
    }

    // Deferred host think-prompts jump the queue (one per release; the next
    // speech-done picks up any remainder, then normal mode flow resumes).
    const prompt = await redis.lpop(k(id, 'promptq'));
    if (prompt) {
      const dispatched = await dispatchThinkPrompt(prompt);
      if (dispatched) return; // dispatch broadcast already
    }

    if (m.mode === 'sequential') {
      await drainQueue();
    } else if (m.batchPendingAnswer) {
      await redis.hset(k(id, 'meta'), { batchPendingAnswer: false });
      await closeBatchWindow();
    } else if (m.batchPhase === 'answering') {
      await openBatchWindow();
    }

    await broadcastState();
  }

  async function notifyAgentState(state, turnID) {
    log(`Agent state: ${state} (turn ${turnID ?? '∅'})`);
    if (!IDLE_STATES.has(state)) return; // speaking/thinking — keep the lock

    const m = await meta();
    if (!m?.isSpeaking) return;

    // Cross-instance dedupe: N clients report the same transition at once.
    if (!(await acquireLock(lockKey(id, 'release'), 300))) return;
    await markSpeechDone();
  }

  // ---------- sequential ----------

  async function drainQueue() {
    if (!(await acquireLock(lockKey(id, 'dispatch'), 10000))) return;
    try {
      const m = await meta();
      if (m.mode !== 'sequential' || m.isSpeaking || !m.agentId) return;

      const q = await redis.lpop(k(id, 'queue'));
      if (!q) return;

      await redis.hset(k(id, 'meta'), {
        isSpeaking: true,
        answerPending: true,
        answerAnchorId: q.id,          // the answer slots in under this question
        agentState: 'thinking',
        caption: `Answering — ${q.text}`,
      });
      await broadcastState();

      log(`Think (sequential) from ${q.user}: "${q.text}"`);
      try {
        await agora.think(m.agentId, q.text, id);
      } catch (err) {
        console.error(`[ChannelManager:${id}] Think error (sequential):`, err);
        await redis.lpush(k(id, 'queue'), q); // retry later
        await redis.hset(k(id, 'meta'), { isSpeaking: false, answerPending: false, agentState: 'listening', caption: '' });
        await broadcastState();
      }
    } finally {
      await releaseLock(lockKey(id, 'dispatch'));
    }
  }

  // ---------- batched ----------

  async function openBatchWindow() {
    const m = await meta();
    if (m.mode !== 'batched') return;
    await redis.hset(k(id, 'meta'), {
      batchPhase: 'collecting',
      batchDeadline: Date.now() + (Number(m.collectionWindowMs) || 30000),
      ...(m.isSpeaking ? {} : { agentState: 'listening' }),
    });
    await broadcastState();
  }

  async function closeBatchWindow() {
    if (!(await acquireLock(lockKey(id, 'dispatch'), 10000))) return;
    try {
      const m = await meta();
      if (m.mode !== 'batched' || m.status !== 'LIVE') return;

      const count = await redis.llen(k(id, 'batch'));
      if (count === 0) {
        await openBatchWindow(); // nobody asked — reopen silently
        return;
      }
      if (m.isSpeaking) {
        // Mid-utterance (e.g. a host script) — defer to markSpeechDone.
        await redis.hset(k(id, 'meta'), { batchPendingAnswer: true, batchDeadline: 0 });
        return;
      }

      const batch = await redis.lrange(k(id, 'batch'), 0, -1);
      await redis.del(k(id, 'batch'));

      // The answer belongs after the last feed message at dispatch time.
      const lastFlat = await redis.zrange(k(id, 'messages'), -1, -1, { withScores: true });
      const anchorId = lastFlat.length ? parseFeed(lastFlat)[0].msg.id : 0;

      await redis.hset(k(id, 'meta'), {
        batchPhase: 'answering',
        batchDeadline: 0,
        isSpeaking: true,
        answerPending: true,
        answerAnchorId: anchorId,
        agentState: 'thinking',
        caption: 'Answering the room…',
      });
      await broadcastState();

      log(`Think (batched) answering ${batch.length} question(s)`);
      try {
        await agora.think(m.agentId, buildBatchPrompt(batch), id);
      } catch (err) {
        console.error(`[ChannelManager:${id}] Think error (batched):`, err);
        await redis.hset(k(id, 'meta'), { isSpeaking: false, answerPending: false, agentState: 'listening', caption: '' });
        await openBatchWindow();
      }
    } finally {
      await releaseLock(lockKey(id, 'dispatch'));
    }
  }

  // ---------- chat / questions ----------

  async function sendMessage({ uid, user, text }) {
    const clean = (text || '').toString().trim();
    if (!clean) return { accepted: false, reason: 'Empty message' };

    const m = await meta();
    const msgId = await nextMsgId(id);
    await appendMessage(id, { id: msgId, uid, user: user || 'Guest', text: clean, kind: 'chat' });

    const isQuestion = m.status === 'LIVE' && !!m.agentId;
    if (isQuestion) {
      if (m.mode === 'sequential') {
        await redis.rpush(k(id, 'queue'), { id: msgId, uid, user: user || 'Guest', text: clean });
        await broadcastState();
        await drainQueue();
        await touchChannel(id, LIVE_TTL_S, m.hostToken);
        return { accepted: true };
      }
      await redis.rpush(k(id, 'batch'), { uid, user: user || 'Guest', text: clean });
    }

    await broadcastState();
    await touchChannel(id, LIVE_TTL_S, m.hostToken);
    return { accepted: true };
  }

  // ---------- host manual script ----------

  async function speakScript(text) {
    const m = await meta();
    if (!m?.agentId) throw new Error('No active agent');
    const clean = (text || '').toString().trim();
    if (!clean) throw new Error('Empty script');
    await speakNow(clean, 'script');
    return { success: true };
  }

  // Host prompt through the LLM (/think). "Answer only" UX: the prompt text
  // never appears in the feed or caption — the avatar's commentary arrives
  // like any other agent turn (history sync / transcripts, no anchor).
  async function thinkScript(text) {
    const m = await meta();
    if (!m?.agentId) throw new Error('No active agent');
    const clean = (text || '').toString().trim();
    if (!clean) throw new Error('Empty prompt');

    if (m.isSpeaking) {
      // Mid-utterance — defer; markSpeechDone flushes prompts before the
      // next question dispatch (host jumps the queue, never interrupts).
      await redis.rpush(k(id, 'promptq'), clean);
      log(`Think prompt queued (avatar busy)`);
      return { success: true, queued: true };
    }
    await dispatchThinkPrompt(clean);
    return { success: true };
  }

  async function dispatchThinkPrompt(text) {
    let locked = await acquireLock(lockKey(id, 'dispatch'), 10000);
    if (!locked) {
      // Contended — real holds are milliseconds, so one short retry usually
      // wins. If not, queue it; the next speech release OR any tick() drains
      // promptq (idle contenders like an empty-batch close never speak, so
      // the release alone isn't enough — see tick()).
      await new Promise((r) => setTimeout(r, 150));
      locked = await acquireLock(lockKey(id, 'dispatch'), 10000);
    }
    if (!locked) {
      await redis.rpush(k(id, 'promptq'), text);
      return false;
    }
    try {
      const m = await meta();
      if (!m.agentId) return false;
      if (m.isSpeaking) { await redis.rpush(k(id, 'promptq'), text); return false; }

      await redis.hset(k(id, 'meta'), {
        isSpeaking: true,
        answerPending: true,
        answerAnchorId: 0,   // answer appends at the feed end — prompt stays invisible
        agentState: 'thinking',
        caption: '',
      });
      await broadcastState();

      log(`Think (host prompt): "${text}"`);
      try {
        await agora.think(m.agentId, text, id);
        return true;
      } catch (err) {
        console.error(`[ChannelManager:${id}] Think error (host prompt):`, err);
        await redis.lpush(k(id, 'promptq'), text); // retry later (mirrors drainQueue)
        await redis.hset(k(id, 'meta'), { isSpeaking: false, answerPending: false, agentState: 'listening', caption: '' });
        await broadcastState();
        return false;
      }
    } finally {
      await releaseLock(lockKey(id, 'dispatch'));
    }
  }

  // ---------- per-guest welcomes ----------

  async function queueWelcome(uid, name) {
    const m = await meta();
    if (m.status !== 'LIVE' || !m.agentId) return;
    // Dedupe on uid AND normalized name (a refresh mints a new uid).
    const added = await redis.sadd(k(id, 'welcomed'), String(uid));
    if (!added) return;
    const nameAdded = await redis.sadd(k(id, 'welcomed'), `name:${normalizeText(name)}`);
    if (!nameAdded) return;

    await redis.rpush(k(id, 'welcomeq'), name.trim());
    log(`Welcome queued for ${name}`);
    // Open a batching window only if one isn't already open.
    const cur = await redis.hget(k(id, 'meta'), 'welcomeDeadline');
    if (!Number(cur)) {
      await redis.hset(k(id, 'meta'), { welcomeDeadline: Date.now() + WELCOME_BATCH_MS });
    }
  }

  // Returns true if it took the speech lock to announce the welcome(s).
  async function flushWelcomes() {
    if (!(await acquireLock(lockKey(id, 'dispatch'), 10000))) return false;
    try {
      await redis.hset(k(id, 'meta'), { welcomeDeadline: 0 });
      const names = await redis.lrange(k(id, 'welcomeq'), 0, -1);
      if (!names.length) return false;
      const m = await meta();
      if (m.isSpeaking) return false; // deferred — markSpeechDone retries (queue non-empty, no deadline)
      await redis.del(k(id, 'welcomeq'));
      await speakNow(buildWelcome(names), 'welcome');
      return true;
    } finally {
      await releaseLock(lockKey(id, 'dispatch'));
    }
  }

  // ---------- presence ----------

  async function heartbeat(uid, name, isHost = false) {
    if (uid == null) return;
    const key = String(uid);
    const isNew = !(await redis.hget(k(id, 'participants'), key));
    await redis.hset(k(id, 'participants'), { [key]: { name: name || 'Guest', lastSeen: Date.now() } });
    if (isNew && !isHost) await queueWelcome(key, name || 'Guest');
  }

  // ---------- agent transcripts ----------

  async function addAgentTranscript({ turnId, text, interrupted }) {
    const clean = fixPunctuationSpacing((text || '').toString().trim());
    if (clean === '' || turnId == null) return { accepted: false, reason: 'Empty transcript' };

    // Echo guard BEFORE turn dedupe — /speak flows can reuse turn ids, so an
    // echo must not consume the turn.
    const recent = await redis.lrange(k(id, 'speaktexts'), 0, -1);
    if (recent.includes(normalizeText(clean))) return { accepted: true, skipped: 'speak-echo' };

    const added = await redis.sadd(k(id, 'turns'), String(turnId));
    if (!added) return { accepted: true, deduped: true };

    const msgId = await nextMsgId(id);
    const msg = {
      id: msgId, uid: 'agent', user: 'AVATAR', text: clean, kind: 'agent',
      ...(interrupted ? { interrupted: true } : {}),
    };

    // Insert right after the question(s) this answers (fractional ZSET score);
    // fall back to append.
    const anchorId = Number(await redis.hget(k(id, 'meta'), 'answerAnchorId')) || 0;
    let placed = false;
    if (anchorId) {
      const feed = parseFeed(await redis.zrange(k(id, 'messages'), 0, -1, { withScores: true }));
      const idx = feed.findIndex((e) => e.msg?.id === anchorId);
      if (idx >= 0) {
        const anchorScore = feed[idx].score;
        const nextScore = idx + 1 < feed.length ? feed[idx + 1].score : anchorScore + 2;
        await redis.zadd(k(id, 'messages'), { score: (anchorScore + nextScore) / 2, member: msg });
        placed = true;
      }
      await redis.hset(k(id, 'meta'), { answerAnchorId: 0 }); // consumed
    }
    if (!placed) await appendMessage(id, msg);

    log(`Transcript (turn ${turnId}${interrupted ? ', interrupted' : ''}): "${clean.slice(0, 80)}${clean.length > 80 ? '…' : ''}"`);
    await broadcastState();
    return { accepted: true };
  }

  // Authoritative source for LLM answers: Agora's history REST API.
  async function syncAgentHistory() {
    const m = await meta();
    if (!m?.agentId) return;
    if (!(await acquireLock(lockKey(id, 'histsync'), 8000))) return;
    try {
      const history = await agora.getAgentHistory(m.agentId, id);
      for (const entry of history?.contents || []) {
        if (entry.role !== 'assistant') continue;
        if (entry.turn_id == null || !entry.content) continue;
        await addAgentTranscript({ turnId: entry.turn_id, text: entry.content, interrupted: false });
      }
    } catch (err) {
      console.error(`[ChannelManager:${id}] History sync error:`, err.message);
    } finally {
      await releaseLock(lockKey(id, 'histsync'));
    }
  }

  // ---------- deadline driver (replaces all in-process timers) ----------

  async function tick() {
    const m = await meta();
    if (!m || m.status !== 'LIVE') return;
    const now = Date.now();
    const batchDue = Number(m.batchDeadline) && now >= Number(m.batchDeadline);
    const welcomeDue = Number(m.welcomeDeadline) && now >= Number(m.welcomeDeadline);
    if (welcomeDue) {
      const spoke = await flushWelcomes();
      if (spoke) return; // welcome took the speech lock; batch close defers naturally
    }
    // Stranded think-prompt recovery: a prompt queued during dispatch-lock
    // contention normally drains on the next speech release — but idle
    // contenders (empty-batch close, empty-queue drain) never speak, so no
    // release ever comes. Hot routes tick constantly; recover it here.
    if (!m.isSpeaking && (await redis.llen(k(id, 'promptq'))) > 0) {
      const prompt = await redis.lpop(k(id, 'promptq'));
      if (prompt) {
        const dispatched = await dispatchThinkPrompt(prompt);
        if (dispatched) return; // speech lock taken; batch close defers naturally
      }
    }
    if (batchDue) await closeBatchWindow();
  }

  // ---------- lifecycle ----------

  async function start(optionsArg) {
    const m = await meta();
    if (m.status !== 'IDLE') {
      throw new Error(`Cannot start channel — current status is ${m.status}`);
    }
    const hostUid = optionsArg?.hostUid;
    const avatarVendor = m.avatarVendor || 'none';

    const greeting = buildGreeting(m.channelTitle);
    const joinResult = await agora.joinAgent(id, `host-${Date.now()}`, m.ttsVendor || undefined, avatarVendor, {
      ttsSpeed: m.ttsSpeed || undefined,
      systemPrompt: buildHostSystemPrompt(m.channelTitle, m.topic),
      greeting,
      remoteUids: hostUid != null ? [hostUid] : undefined,
      avatarImageUrl: m.avatarImageUrl || undefined,
      voiceGender: m.voiceGender || undefined,
    });

    await redis.hset(k(id, 'meta'), {
      agentId: joinResult.agent_id,
      status: 'LIVE',
      agentState: 'listening',
      enableAvatar: avatarVendor !== 'none',
    });

    // The native greeting_message is spoken by Agora when the host connects —
    // treat it like every other server-known utterance: bubble in the feed
    // now, normalized text in the echo guard, so its transcript can never be
    // mistaken for an answer (or steal the answer anchor).
    const greetMsgId = await nextMsgId(id);
    await appendMessage(id, { id: greetMsgId, uid: 'agent', user: 'AVATAR', text: greeting, kind: 'agent' });
    await redis.rpush(k(id, 'speaktexts'), normalizeText(greeting));

    if (m.mode === 'batched') {
      await openBatchWindow();
    } else {
      await broadcastState();
    }
    await touchChannel(id, LIVE_TTL_S, m.hostToken);

    return { agentId: joinResult.agent_id, channelName: id, mode: m.mode, status: 'LIVE' };
  }

  async function stop() {
    const m = await meta();
    log(`stop called. agentId=${m.agentId}, status=${m.status}`);
    if (m.agentId) {
      try {
        await agora.leaveAgent(m.agentId, id);
        log('leaveAgent succeeded');
      } catch (err) {
        console.error(`[ChannelManager:${id}] Error leaving agent:`, err);
      }
    }
    await redis.hset(k(id, 'meta'), {
      agentId: '',
      status: 'CLOSED',
      agentState: 'idle',
      isSpeaking: false,
      answerPending: false,
      caption: '',
      lastSpokenText: '',
      batchDeadline: 0,
      welcomeDeadline: 0,
    });
    await broadcastState();
    await touchChannel(id, CLOSED_TTL_S, m.hostToken);
    return { success: true };
  }

  return {
    id,
    notifyAgentState,
    start,
    stop,
    sendMessage,
    speakScript,
    thinkScript,
    addAgentTranscript,
    heartbeat,
    getState,
    tick,
  };
}

/** Deadline driver for hot routes: no-op unless a channel deadline has passed. */
export async function tickChannel(id) {
  try {
    const channel = await getChannel(id);
    if (channel) await channel.tick();
  } catch (err) {
    console.error(`[ChannelManager:${id}] tick error:`, err);
  }
}
