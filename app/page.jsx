'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAgoraAuth } from '../hooks/useAgoraAuth';
import SignInCard from './components/SignInCard';
import { Spinner } from './components/stream/StreamParts';
import { normalizeLemonsliceAvatarInput } from '../lib/avatarInput';

const WINDOWS = [
  { label: '10s', ms: 10000 },
  { label: '20s', ms: 20000 },
  { label: '30s', ms: 30000 },
];

const AVATAR_VENDORS = ['anam', 'lemonslice', 'heygen'];

// A query parameter can preselect the provider; the form remains editable.
// Read lazily (not useSearchParams) so the page needs no Suspense boundary.
function avatarFromQuery() {
  if (typeof window === 'undefined') return 'lemonslice';
  const v = new URLSearchParams(window.location.search).get('avatar');
  return AVATAR_VENDORS.includes(v) ? v : 'lemonslice';
}

export default function SetupPage() {
  const router = useRouter();
  const { me, loading: authLoading, authError, signIn, signOut } = useAgoraAuth();
  const [channel, setChannel] = useState('Product AMA');
  const [hostName, setHostName] = useState('');
  const [topic, setTopic] = useState('');
  const [mode, setMode] = useState('batched');
  const [windowMs, setWindowMs] = useState(20000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showJoin, setShowJoin] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [avatarVendor, setAvatarVendor] = useState(avatarFromQuery);
  const [avatarImageUrl, setAvatarImageUrl] = useState('');
  const [voiceGender, setVoiceGender] = useState('female');

  const create = async () => {
    if (busy) return;
    const imageUrl = normalizeLemonsliceAvatarInput(avatarImageUrl);
    if (avatarImageUrl.trim() && !imageUrl) {
        setError('Paste a full public https:// image URL or a Lemonslice agent_… ID');
        return;
    }
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelTitle: channel.trim() || 'Live Stream',
          hostName: hostName.trim() || 'Host',
          topic: topic.trim(),
          mode,
          collectionWindowMs: windowMs,
          ttsVendor: 'preset_minimax',
          avatarVendor,
          avatarImageUrl: imageUrl || undefined,
          voiceGender: avatarVendor === 'lemonslice' && imageUrl ? voiceGender : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create channel');
      router.push(data.hostUrl);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const goJoin = () => {
    const code = joinCode.trim().split('/').pop();
    if (code) router.push(`/stream/${code}`);
  };

  const pasteAvatarUrl = async () => {
    try {
      const pasted = await navigator.clipboard.readText();
      const normalized = normalizeLemonsliceAvatarInput(pasted);
      if (!normalized) throw new Error('Clipboard does not contain a full https:// URL or Lemonslice agent ID');
      setAvatarImageUrl(normalized);
      setError(null);
    } catch (e) {
      setError(e.message || 'Clipboard access failed. Click the field and press ⌘V or Ctrl+V.');
    }
  };

  if (authLoading) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--panel)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spinner />
      </div>
    );
  }

  // Hosting is PIN-gated in production; guests never need this page (they get
  // direct /stream links), but the paste-a-link helper stays public.
  if (!me?.authenticated) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--panel)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '64px 24px' }}>
        <div style={{ width: '100%', maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 44 }}>
          <SignInCard signIn={signIn} authError={authError} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span className="mono" style={labelStyle}>JOINING AS A GUEST? PASTE THE STREAM LINK</span>
            <div style={{ display: 'flex', gap: 10 }}>
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') goJoin(); }}
                placeholder="https://…/stream/abc123"
                style={{ ...inputStyle, flex: 1, width: 'auto' }}
              />
              <button
                onClick={goJoin}
                disabled={!joinCode.trim()}
                style={{ padding: '0 18px', height: 52, borderRadius: 13, border: 'none', background: joinCode.trim() ? 'var(--ink)' : '#D6D6D1', color: '#fff', fontSize: 15, fontWeight: 600, cursor: joinCode.trim() ? 'pointer' : 'not-allowed' }}
              >
                Go
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--panel)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '64px 24px' }}>
      <div style={{ width: '100%', maxWidth: 540, display: 'flex', flexDirection: 'column', gap: 30 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span className="mono" style={{ fontSize: 12, letterSpacing: '0.16em', color: 'var(--faint)' }}>NEW CHANNEL</span>
          <h1 className="serif" style={{ margin: 0, fontSize: 44, lineHeight: 1.05, letterSpacing: '-0.01em', color: 'var(--ink)' }}>Set up your stream</h1>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: 'var(--muted)' }}>Configure how the avatar handles the room before you go live.</p>
        </div>

        {!showJoin ? (
          <>
            <Field label="CHANNEL NAME">
              <input value={channel} onChange={(e) => setChannel(e.target.value)} style={inputStyle} />
            </Field>

            <Field label="YOUR NAME">
              <input value={hostName} onChange={(e) => setHostName(e.target.value)} placeholder="How you'll appear in the chat" style={inputStyle} />
            </Field>

            <Field label="TOPIC (OPTIONAL)">
              <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What should the avatar be knowledgeable about?" style={inputStyle} />
            </Field>

            <Field label="AVATAR PROVIDER">
              <select value={avatarVendor} onChange={(e) => setAvatarVendor(e.target.value)} style={inputStyle}>
                <option value="lemonslice">Lemonslice — animate an image</option>
                <option value="anam">Anam</option>
                <option value="heygen">HeyGen LiveAvatar</option>
              </select>
            </Field>

            {avatarVendor === 'lemonslice' && (
              <Field label="LEMONSLICE AVATAR IMAGE URL OR AGENT ID">
                <div style={{ display: 'flex', gap: 10 }}>
                  <input
                    value={avatarImageUrl}
                    onChange={(e) => setAvatarImageUrl(e.target.value)}
                    onPaste={(e) => {
                      const normalized = normalizeLemonsliceAvatarInput(e.clipboardData.getData('text'));
                      if (normalized) { e.preventDefault(); setAvatarImageUrl(normalized); setError(null); }
                    }}
                    placeholder="https://…/portrait.jpg or agent_…"
                    style={{ ...inputStyle, flex: 1, width: 'auto' }}
                  />
                  <button type="button" onClick={pasteAvatarUrl} style={{ ...toolbarStyle, minWidth: 82 }}>Paste URL</button>
                </div>
                <span style={{ fontSize: 12, color: 'var(--faint)', lineHeight: 1.4 }}>
                  Use a public image URL—not the Lemonslice dashboard /pipeline page URL—or paste a Lemonslice agent_… ID. Best image: face large in frame, neutral expression, portrait ≈368×560, under 4MB.
                </span>
                {avatarImageUrl.trim() && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
                    <span className="mono" style={{ ...labelStyle, fontSize: 10 }}>VOICE</span>
                    {[['female', 'Female'], ['male', 'Male']].map(([val, label]) => (
                      <button key={val} onClick={() => setVoiceGender(val)} style={{
                        height: 30, padding: '0 14px', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 500,
                        border: voiceGender === val ? '2px solid var(--ink)' : '1px solid var(--line-3)',
                        background: voiceGender === val ? 'var(--ink)' : 'var(--panel)',
                        color: voiceGender === val ? '#fff' : 'var(--ink)',
                      }}>{label}</button>
                    ))}
                  </div>
                )}
              </Field>
            )}

            <div style={{ padding: '12px 14px', border: '1px solid var(--line-2)', borderRadius: 12, background: 'var(--stage)', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span className="mono" style={{ ...labelStyle, fontSize: 10 }}>AGORA MANAGED PIPELINE</span>
              <span style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.45 }}>
                Deepgram Nova-3 ASR → OpenAI GPT-4o mini LLM → MiniMax Speech 2.6 Turbo TTS
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <span className="mono" style={labelStyle}>RESPONSE MODE</span>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                <ModeTile
                  active={mode === 'batched'} onClick={() => setMode('batched')}
                  title="Batched" desc="Collects everything for a set window, then answers the whole room at once."
                />
                <ModeTile
                  active={mode === 'sequential'} onClick={() => setMode('sequential')}
                  title="Sequential" desc="Queues questions and answers them one by one, in order."
                />
              </div>
            </div>

            {mode === 'batched' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <span className="mono" style={labelStyle}>COLLECTION WINDOW</span>
                <div style={{ display: 'flex', gap: 10 }}>
                  {WINDOWS.map((w) => (
                    <button key={w.ms} onClick={() => setWindowMs(w.ms)} style={{
                      flex: 1, height: 46, borderRadius: 12, cursor: 'pointer', fontSize: 15, fontWeight: 500,
                      border: windowMs === w.ms ? '2px solid var(--ink)' : '1px solid var(--line-3)',
                      background: windowMs === w.ms ? 'var(--ink)' : 'var(--panel)',
                      color: windowMs === w.ms ? '#fff' : 'var(--ink)',
                    }}>{w.label}</button>
                  ))}
                </div>
              </div>
            )}

            {error && <div style={errorStyle}>{error}</div>}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 4 }}>
              <button onClick={create} disabled={busy} style={{ height: 56, border: 'none', borderRadius: 14, background: 'var(--ink)', color: '#fff', cursor: busy ? 'wait' : 'pointer', fontSize: 16, fontWeight: 600, opacity: busy ? 0.7 : 1 }}>
                {busy ? 'Creating…' : 'Create & go live'}
              </button>
              <button onClick={() => setShowJoin(true)} style={linkBtnStyle}>Joining as a guest? Enter here →</button>
              {me.authMode === 'pin' && (
                <span style={{ alignSelf: 'center', fontSize: 12, color: 'var(--faint)' }}>
                  Hosting unlocked · <button onClick={signOut} style={{ ...linkBtnStyle, padding: 0, textDecoration: 'underline' }}>Lock</button>
                </span>
              )}
            </div>
          </>
        ) : (
          <>
            <Field label="STREAM LINK OR CODE">
              <input value={joinCode} onChange={(e) => setJoinCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') goJoin(); }} placeholder="paste the host's stream link" autoFocus style={inputStyle} />
            </Field>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 4 }}>
              <button onClick={goJoin} disabled={!joinCode.trim()} style={{ height: 56, border: 'none', borderRadius: 14, background: joinCode.trim() ? 'var(--ink)' : '#D6D6D1', color: joinCode.trim() ? '#fff' : 'var(--faint)', cursor: joinCode.trim() ? 'pointer' : 'not-allowed', fontSize: 16, fontWeight: 600 }}>Go to stream</button>
              <button onClick={() => setShowJoin(false)} style={linkBtnStyle}>← Back to setup</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const inputStyle = { height: 52, padding: '0 18px', border: '1px solid var(--line-3)', borderRadius: 13, fontSize: 16, color: 'var(--ink)', background: 'var(--panel)', width: '100%' };
const labelStyle = { fontSize: 11, letterSpacing: '0.08em', color: 'var(--muted)', fontWeight: 500 };
const linkBtnStyle = { alignSelf: 'center', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 500, color: 'var(--muted)' };
const toolbarStyle = { height: 52, padding: '0 14px', border: '1px solid var(--line-3)', borderRadius: 13, background: 'var(--panel)', color: 'var(--ink)', cursor: 'pointer', fontSize: 14, fontWeight: 600 };
const errorStyle = { padding: '10px 14px', background: 'color-mix(in oklab, var(--red) 10%, transparent)', border: '1px solid color-mix(in oklab, var(--red) 30%, transparent)', borderRadius: 10, fontSize: 13, color: 'var(--red)' };

function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="mono" style={labelStyle}>{label}</span>
      {children}
    </div>
  );
}

function ModeTile({ active, onClick, title, desc }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, minWidth: 220, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 8,
      border: active ? '2px solid var(--ink)' : '1px solid var(--line-3)', background: 'var(--panel)',
      borderRadius: 16, padding: active ? '17px 19px' : '18px 20px', cursor: 'pointer',
      boxShadow: active ? '0 0 0 4px rgba(11,11,11,0.05)' : 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--ink)' }}>{title}</span>
        <span style={{ display: 'inline-block', width: 18, height: 18, borderRadius: '50%', border: active ? '5px solid var(--ink)' : '2px solid #D2D2CD', background: 'var(--panel)' }} />
      </div>
      <span style={{ fontSize: 13, lineHeight: 1.45, color: 'var(--muted)' }}>{desc}</span>
    </button>
  );
}
