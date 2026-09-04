// Agora REST API wrapper for Conversational AI endpoints

import { generateConvoAIToken } from 'agora-agents';
import { generateSessionTokens } from './tokenService.js';

const AGORA_BASE_URL = 'https://api.agora.io/api/conversational-ai-agent/v2/projects';

function getBasicAuthToken() {
  const username = process.env.AGORA_USERNAME;
  const password = process.env.AGORA_PASSWORD;
  if (!username || !password) {
    throw new Error('Missing AGORA_USERNAME or AGORA_PASSWORD');
  }
  return Buffer.from(`${username}:${password}`).toString('base64');
}

/**
 * Build a short-lived, project-scoped authorization header for the ConvoAI
 * REST API. This avoids deploying Agora's account-wide Customer ID/Secret.
 */
function getConvoAIAuthHeader(channelName, uid = 0) {
  const appId = getAppId();
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;
  if (!appCertificate) {
    throw new Error('Missing AGORA_APP_CERTIFICATE');
  }

  const token = generateConvoAIToken({
    appId,
    appCertificate,
    channelName,
    uid: Number(uid),
    tokenExpire: 3600,
    privilegeExpire: 3600,
  });
  return `agora token=${token}`;
}

function getAppId() {
  const appId = process.env.AGORA_APP_ID;
  if (!appId) {
    throw new Error('Missing AGORA_APP_ID');
  }
  return appId;
}

/**
 * Start a Convo AI agent and join it to an RTC channel.
 * Returns the agent_id from Agora's response.
 */
// --- TTS vendor configs ---
// 'preset_openai' and 'preset_minimax' use Agora presets (no vendor API keys)
// 'microsoft' is a custom vendor requiring API keys

export function buildTTSConfig(ttsVendor, speedOverride, voiceGender) {
  const ttsSpeed = speedOverride || parseFloat(process.env.TTS_SPEED) || 1.0;

  if (ttsVendor === 'microsoft') {
    return {
      vendor: 'microsoft',
      params: {
        key: process.env.TTS_KEY,
        region: process.env.TTS_REGION || 'eastus',
        voice_name: process.env.TTS_VOICE_NAME || 'en-US-GuyNeural',
        speed: ttsSpeed,
        sample_rate: 24000,
      },
    };
  } else if (ttsVendor === 'preset_minimax') {
    return {
      params: {
        language_boost: 'English',
        audio_setting: {
          sample_rate: 24000,
        },
        voice_setting: {
          // Per-stream gender toggle (Lemonslice setup) — male id proven on
          // this Agora project by the auctioneer demo; female is the default.
          voice_id: voiceGender === 'male'
            ? (process.env.MINIMAX_VOICE_ID_MALE || 'English_expressive_narrator')
            : (process.env.MINIMAX_VOICE_ID || 'English_captivating_female1'),
          speed: ttsSpeed,
        },
      },
    };
  }
  // Default: OpenAI preset TTS
  return {
    params: {
      speed: ttsSpeed,
      instructions: 'Always speak in English. Speak in a warm, clear, conversational tone.',
    },
  };
}

/**
 * Returns true if the TTS vendor is a preset (included in the preset string)
 * rather than a custom vendor requiring its own config.
 */
function isPresetTTS(ttsVendor) {
  return !ttsVendor || ttsVendor === 'preset_openai' || ttsVendor === 'preset_minimax';
}

/**
 * Get the preset string based on TTS vendor choice.
 */
function configuredPreset(name, fallback) {
  const value = process.env[name] || fallback;
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error(`${name} must contain one Agora preset identifier`);
  }
  return value;
}

export function getPresetString(ttsVendor) {
  const asrPreset = configuredPreset('AGORA_ASR_PRESET', 'deepgram_nova_3');
  const llmPreset = configuredPreset('AGORA_LLM_PRESET', 'openai_gpt_4o_mini');
  const asrLlm = `${asrPreset},${llmPreset}`;

  if (ttsVendor === 'preset_minimax') {
    const ttsPreset = configuredPreset('AGORA_TTS_PRESET', 'minimax_speech_2_6_turbo');
    return `${asrLlm},${ttsPreset}`;
  } else if (isPresetTTS(ttsVendor)) {
    const ttsPreset = configuredPreset('AGORA_TTS_PRESET', 'openai_tts_1');
    return `${asrLlm},${ttsPreset}`;
  }
  // Custom vendor — no TTS preset
  return asrLlm;
}

// --- Avatar vendor configs ---

function buildAvatarConfig(avatarVendor, opts = {}) {
  if (!avatarVendor || avatarVendor === 'none') return null;

  if (avatarVendor === 'anam') {
    return {
      vendor: 'anam',
      enable: true,
      params: {
        api_key: process.env.ANAM_API_KEY,
        avatar_id: process.env.ANAM_AVATAR_ID || '960f614f-ea88-47c3-9883-f02094f70874',
        agora_uid: process.env.AVATAR_AGORA_UID || '102',
        agora_token: '__PLACEHOLDER__',
        sample_rate: 24000,
        quality: 'high',
        video_encoding: 'H264',
      },
    };
  } else if (avatarVendor === 'lemonslice') {
    // Lemonslice has no dedicated ConvoAI vendor — it implements Agora's
    // generic avatar interface (vendor: 'generic' + their liveai endpoint).
    return {
      vendor: 'generic',
      enable: true,
      params: {
        api_key: process.env.LEMONSLICE_API_KEY,
        api_base_url: process.env.LEMONSLICE_API_BASE_URL || 'https://lemonslice.com/api/liveai/agora',
        // avatar_id accepts a Lemonslice agent id OR a public image URL —
        // per-stream image (host's choice at setup) wins over the env default.
        avatar_id: opts.avatarImageUrl || process.env.LEMONSLICE_AVATAR_ID,
        agora_uid: process.env.AVATAR_AGORA_UID || '102',
        agora_token: '__PLACEHOLDER__',
        sample_rate: 24000,
        quality: 'high',
        version: 'v1',
        video_encoding: 'H264',
        activity_idle_timeout: 120,
        area: process.env.LEMONSLICE_AREA || 'NORTH_AMERICA',
      },
    };
  } else if (avatarVendor === 'heygen') {
    return {
      vendor: 'liveavatar',
      enable: true,
      params: {
        api_key: process.env.HEYGEN_API_KEY,
        avatar_id: process.env.HEYGEN_AVATAR_ID,
        agora_uid: process.env.AVATAR_AGORA_UID || '102',
        agora_token: '__PLACEHOLDER__',
        quality: process.env.HEYGEN_QUALITY || 'high',
      },
    };
  }

  return null;
}

/**
 * @param {string} ttsVendor - 'preset_openai', 'preset_minimax', or 'microsoft'
 * @param {string} avatarVendor - 'none', 'anam', or 'heygen'
 */
export async function joinAgent(channelName, agentName, ttsVendor, avatarVendor = 'none', extraConfig = {}) {
  const appId = getAppId();

  const vendor = ttsVendor || 'preset_openai';
  const hasAvatar = avatarVendor && avatarVendor !== 'none';

  const preset = getPresetString(vendor);
  const ttsConfig = buildTTSConfig(vendor, extraConfig.ttsSpeed, extraConfig.voiceGender);

  // Use fixed UIDs when avatar is enabled (Agora sample pattern):
  // Agent audio: 100, User: 101, Avatar video: 102
  const agentUid = hasAvatar ? '100' : '8888';
  const userUid = hasAvatar ? '101' : '12345';
  const avatarUid = process.env.AVATAR_AGORA_UID || '102';

  // Generate tokens for all participants
  const tokens = generateSessionTokens(channelName, {
    userUid: Number(userUid),
    agentUid: Number(agentUid),
    avatarUid: Number(avatarUid),
  });

  const body = {
    name: agentName || `host-${Date.now()}`,
    preset,
    properties: {
      channel: channelName,
      token: tokens.agentRtcToken,
      agent_rtc_uid: agentUid,
      // The agent tracks the users listed here: greeting_message fires when one
      // of them joins, and idle_timeout counts down when they've all left. Pass
      // the HOST's real RTC UID (extraConfig.remoteUids) — the host joins as a
      // visible broadcaster, so its arrival triggers the greeting. The wildcard
      // '*' is rejected by Agora when an avatar is enabled, so it must be a
      // concrete list.
      remote_rtc_uids: extraConfig.remoteUids?.length ? extraConfig.remoteUids.map(String) : [userUid],
      enable_string_uid: false,
      // Short idle_timeout so abandoned/orphaned agents auto-terminate.
      // The agent considers the channel idle when no audience is subscribed
      // — once everyone's tab is closed, it'll leave within 10 minutes.
      idle_timeout: 600,
      advanced_features: {
        enable_rtm: true,
      },
      asr: {
        language: 'en-US',
      },
      llm: {
        system_messages: [
          { role: 'system', content: extraConfig.systemPrompt || 'You are a friendly live host. Answer audience questions warmly and concisely.' },
        ],
        greeting_message: extraConfig.greeting || 'This is a basic greeting',
        failure_message: 'Error.',
        max_history: 10,
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
      tts: ttsConfig,
      ...(hasAvatar && (() => {
        const avatarConfig = buildAvatarConfig(avatarVendor, { avatarImageUrl: extraConfig.avatarImageUrl });
        if (avatarConfig) {
          avatarConfig.params.agora_token = tokens.avatarRtcToken;
        }
        return { avatar: avatarConfig };
      })()),
      parameters: {
        data_channel: 'rtm',
        transcript: { enable: true },
        enable_metrics: true,
        enable_error_message: true,
      },
    },
  };

  const url = `${AGORA_BASE_URL}/${appId}/join`;
  console.log(`[Agora] JOIN ${channelName} (preset=${preset}, avatar=${avatarVendor})`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: getConvoAIAuthHeader(channelName, Number(agentUid)),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Agora] JOIN failed:', response.status, errorText);
    throw new Error(`Agora join failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * Make the agent speak via TTS.
 * priority: 'INTERRUPT' | 'APPEND' | 'IGNORE'
 */
export async function speak(agentId, text, priority = 'INTERRUPT', interruptable = true, channelName = 'speak') {
  const appId = getAppId();

  const response = await fetch(
    `${AGORA_BASE_URL}/${appId}/agents/${agentId}/speak`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: getConvoAIAuthHeader(channelName),
      },
      body: JSON.stringify({ text, priority, interruptable }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Agora speak failed (${response.status}): ${errorText}`);
  }

  // Response may be empty on success
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json();
  }
  return { success: true };
}

/**
 * Send a custom instruction to the agent's LLM pipeline.
 * The LLM processes the text and the agent speaks the response via TTS.
 */
export async function think(agentId, text, channelName = 'think') {
  const appId = getAppId();

  const response = await fetch(
    `${AGORA_BASE_URL}/${appId}/agents/${agentId}/think`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: getConvoAIAuthHeader(channelName),
      },
      body: JSON.stringify({ text }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Agora think failed (${response.status}): ${errorText}`);
  }

  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return response.json();
  }
  return { success: true };
}

/**
 * Interrupt the agent mid-speech.
 */
export async function interrupt(agentId, channelName = 'interrupt') {
  const appId = getAppId();

  const response = await fetch(
    `${AGORA_BASE_URL}/${appId}/agents/${agentId}/interrupt`,
    {
      method: 'POST',
      headers: {
        Authorization: getConvoAIAuthHeader(channelName),
      },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Agora interrupt failed (${response.status}): ${errorText}`);
  }

  return { success: true };
}

/**
 * Remove the agent from the RTC channel.
 */
export async function leaveAgent(agentId, channelName = 'stop') {
  const appId = getAppId();

  const response = await fetch(
    `${AGORA_BASE_URL}/${appId}/agents/${agentId}/leave`,
    {
      method: 'POST',
      headers: {
        Authorization: getConvoAIAuthHeader(channelName),
      },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Agora leave failed (${response.status}): ${errorText}`);
  }

  return { success: true };
}

/**
 * List all agents, optionally filtered by status.
 * Returns { data: { count, list }, meta: { cursor, total }, status }
 */
export async function listAgents(limit = 50) {
  const appId = getAppId();

  const response = await fetch(
    `${AGORA_BASE_URL}/${appId}/agents?limit=${limit}`,
    {
      method: 'GET',
      headers: {
        Authorization: getConvoAIAuthHeader('list'),
      },
      cache: 'no-store',
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Agora list failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * Fetch the agent's conversation history (works mid-session).
 * Returns { agent_id, channel, contents: [{role, content, turn_id, ...}], status }.
 */
export async function getAgentHistory(agentId, channelName = 'history') {
  const appId = getAppId();

  const response = await fetch(
    `${AGORA_BASE_URL}/${appId}/agents/${agentId}/history`,
    {
      method: 'GET',
      headers: {
        Authorization: getConvoAIAuthHeader(channelName),
      },
      cache: 'no-store',
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Agora history failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * Query agent status.
 */
export async function queryAgent(agentId, channelName = 'query') {
  const appId = getAppId();

  const response = await fetch(
    `${AGORA_BASE_URL}/${appId}/agents/${agentId}/query`,
    {
      method: 'GET',
      headers: {
        Authorization: getConvoAIAuthHeader(channelName),
      },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Agora query failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

// --- RTM REST API (for server→client state broadcasting) ---

const RTM_BASE_URL = 'https://api.agora.io/dev/v2/project';

/**
 * Publish a message to an RTM channel so all subscribed clients receive it.
 * @param {string} channel - RTM channel name to publish into (= channel ID)
 * @param {object|string} payload - Message payload (objects are JSON-stringified)
 */
export async function publishChannelMessage(channel, payload) {
  const appId = getAppId();
  const authToken = getBasicAuthToken();

  const response = await fetch(
    `${RTM_BASE_URL}/${appId}/rtm/users/Server/channel_messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${authToken}`,
      },
      cache: 'no-store',
      body: JSON.stringify({
        channel_name: channel,
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[RTM] Channel message failed:', response.status, errorText);
  }
}
