import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeLemonsliceAvatarInput } from '../lib/avatarInput.js';
import { buildTTSConfig, getPresetString } from '../lib/agoraService.js';

afterEach(() => vi.unstubAllEnvs());

describe('Agora managed pipeline presets', () => {
  it('uses the official quickstart default ASR, LLM, and TTS chain', () => {
    expect(getPresetString('preset_minimax')).toBe(
      'deepgram_nova_3,openai_gpt_4o_mini,minimax_speech_2_6_turbo',
    );
  });

  it('allows each preset stage to be configured independently', () => {
    vi.stubEnv('AGORA_ASR_PRESET', 'deepgram_nova_3');
    vi.stubEnv('AGORA_LLM_PRESET', 'openai_gpt_5_mini');
    vi.stubEnv('AGORA_TTS_PRESET', 'minimax_speech_2_6_turbo');
    expect(getPresetString('preset_minimax')).toBe(
      'deepgram_nova_3,openai_gpt_5_mini,minimax_speech_2_6_turbo',
    );
  });

  it('keeps MiniMax audio at the avatar-compatible 24 kHz sample rate', () => {
    expect(buildTTSConfig('preset_minimax').params.audio_setting.sample_rate).toBe(24000);
  });
});

describe('Lemonslice avatar input', () => {
  it('accepts and normalizes public HTTPS image URLs', () => {
    expect(normalizeLemonsliceAvatarInput('  https://cdn.example.com/face.jpg  ')).toBe(
      'https://cdn.example.com/face.jpg',
    );
  });

  it('accepts Markdown-wrapped URLs and Lemonslice agent IDs', () => {
    expect(normalizeLemonsliceAvatarInput('[portrait](https://cdn.example.com/face.png)')).toBe(
      'https://cdn.example.com/face.png',
    );
    expect(normalizeLemonsliceAvatarInput('agent_demo_123')).toBe('agent_demo_123');
  });

  it('rejects relative pipeline paths, insecure URLs, and arbitrary text', () => {
    expect(normalizeLemonsliceAvatarInput('/pipeline/123')).toBe('');
    expect(normalizeLemonsliceAvatarInput('http://example.com/face.jpg')).toBe('');
    expect(normalizeLemonsliceAvatarInput('not a URL')).toBe('');
  });
});
