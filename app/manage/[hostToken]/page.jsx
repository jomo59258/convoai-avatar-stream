'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import useChannel from '../../hooks/useChannel';
import useAgora from '../../hooks/useAgora';
import StreamScreen from '../../components/stream/StreamScreen';
import { Spinner } from '../../components/stream/StreamParts';
import { useAgoraAuth } from '../../../hooks/useAgoraAuth';
import SignInCard from '../../components/SignInCard';
import ErrorScreen from '../../components/ErrorScreen';
import ConfirmModal from '../../components/ConfirmModal';

export default function ManagePage({ params }) {
  const { hostToken } = params;
  const router = useRouter();
  const { me, loading: authLoading, authError, signIn } = useAgoraAuth();
  const authed = !!me?.authenticated;
  const [channelId, setChannelId] = useState(null);
  const [resolveError, setResolveError] = useState(null);
  const [creds, setCreds] = useState(null);       // useAgora — host role, UID_A
  const [rtmCreds, setRtmCreds] = useState(null); // useChannel — guest role, UID_B
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const startedRef = useRef(false);

  // Resolve host token → channel id. Gated on auth so an unauthenticated
  // visitor doesn't fire 401ing bootstrap requests (PIN mode).
  useEffect(() => {
    if (!authed) return;
    let alive = true;
    fetch(`/api/channels/by-host-token/${hostToken}`)
      .then((res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'Invalid host link' : `Lookup failed (${res.status})`);
        return res.json();
      })
      .then((data) => { if (alive) setChannelId(data.id); })
      .catch((err) => { if (alive) setResolveError(err.message); });
    return () => { alive = false; };
  }, [hostToken, authed]);

  // Mint host + guest creds (two RTM identities).
  useEffect(() => {
    if (!channelId) return;
    let alive = true;
    const hostFetch = fetch(`/api/channels/${channelId}/credentials?role=host`, {
      headers: { 'X-Channel-Host-Token': hostToken },
    }).then((res) => { if (!res.ok) throw new Error(`Credentials failed (${res.status})`); return res.json(); });
    const guestFetch = fetch(`/api/channels/${channelId}/credentials?role=guest`)
      .then((res) => { if (!res.ok) throw new Error(`Credentials failed (${res.status})`); return res.json(); });
    Promise.all([hostFetch, guestFetch])
      .then(([host, guest]) => { if (alive) { setCreds(host); setRtmCreds(guest); } })
      .catch((err) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [channelId, hostToken]);

  const channel = useChannel(channelId, hostToken, rtmCreds ? { rtmToken: rtmCreds.rtmToken, rtmUid: rtmCreds.uid } : null);

  const { remoteVideoTrack, isJoined, isMuted, agentSpeakingState, liveCaption, join, leave, toggleMute } = useAgora(
    channel.channelName,
    {
      startMuted: false,
      enableAvatar: channel.enableAvatar,
      userRtcToken: creds?.rtcToken,
      userRtmToken: creds?.rtmToken,
      userUid: creds?.uid,
      channelId,
      // Broadcaster role (no media published) — makes the host visible to the
      // agent so the native greeting_message fires on join.
      clientRole: 'host',
    }
  );

  // Auto-start the channel on first load (matches "Create & go live"). Passes
  // this tab's RTC UID so the agent watches for the host joining — that join is
  // what triggers the agent's native greeting_message.
  useEffect(() => {
    if (startedRef.current) return;
    if (!channelId || !creds) return;
    if (channel.status !== 'IDLE') return;
    startedRef.current = true;
    channel.start(creds.uid).catch((e) => { setError(e.message); startedRef.current = false; });
  }, [channelId, creds, channel.status, channel]);

  // Join RTC once live.
  useEffect(() => {
    const live = channel.status === 'LIVE';
    if (live && creds && !isJoined) join();
    if (!live && isJoined) leave();
  }, [channel.status, creds, isJoined, join, leave]);

  // Presence heartbeat — the host counts toward "N WATCHING" too.
  const live = channel.status === 'LIVE';
  const { sendPresence } = channel;
  useEffect(() => {
    if (!rtmCreds?.uid || !live) return;
    const beat = () => sendPresence(rtmCreds.uid, channel.hostName || 'Host');
    beat();
    const t = setInterval(beat, 15000);
    return () => clearInterval(t);
  }, [rtmCreds?.uid, live, sendPresence, channel.hostName]);

  if (authLoading) {
    return <Centered><Spinner /></Centered>;
  }
  if (!authed) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--panel)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '64px 24px' }}>
        <SignInCard
          signIn={signIn}
          authError={authError}
          note="This unlocks the host console for 12 hours."
        />
      </div>
    );
  }
  if (resolveError) {
    return (
      <ErrorScreen
        eyebrow="INVALID HOST LINK"
        title="This host link isn't active"
        body="Host links stop working when a stream ends or expires (streams clean up about 30 minutes after ending). If you copied the link, double-check it — otherwise create a new stream."
        ctaHref="/"
        ctaLabel="Go to setup"
      />
    );
  }
  if (!channelId || !creds) {
    return <Centered><Spinner /><span className="mono" style={{ fontSize: 12, letterSpacing: '0.12em', color: 'var(--muted)' }}>PREPARING HOST CONSOLE</span></Centered>;
  }

  const isLive = channel.status === 'LIVE';
  const isOver = channel.status === 'CLOSED';
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const guestUrl = channelId ? `${origin}/stream/${channelId}` : '';

  const copyGuest = () => {
    if (typeof navigator !== 'undefined') navigator.clipboard?.writeText(guestUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleStop = async () => {
    setEnding(true);
    try {
      await channel.stop();
      await fetch(`/api/channels/${channelId}`, { method: 'DELETE', headers: { 'X-Channel-Host-Token': hostToken } });
      router.push('/');
    } catch (e) {
      setError(e.message);
      setEnding(false);
      setConfirmEnd(false);
    }
  };

  const onSend = (text) => channel.sendMessage(text, { uid: rtmCreds?.uid, user: channel.hostName || 'Host' });

  return (
    // Locked to the viewport so only the chat list scrolls (avatar stays pinned).
    <div style={{ height: '100dvh', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--panel)' }}>
      {/* host toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 18px', borderBottom: '1px solid var(--line-2)', flexShrink: 0, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>{channel.channelTitle || 'Live Stream'}</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--faint)', padding: '3px 8px', borderRadius: 999, background: 'var(--stage)' }}>{channel.mode?.toUpperCase()}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <span className="mono" style={{ fontSize: 11, color: 'var(--muted)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{guestUrl}</span>
          <button onClick={copyGuest} style={toolbarBtn}>{copied ? 'Copied!' : 'Copy guest link'}</button>
          <button onClick={() => setConfirmEnd(true)} disabled={!isLive && !isOver} style={{ ...toolbarBtn, borderColor: 'color-mix(in oklab, var(--red) 40%, var(--line-3))', color: 'var(--red)' }}>{isOver ? 'Delete' : 'End stream'}</button>
        </div>
      </div>

      {error && <div style={{ padding: '8px 18px', fontSize: 13, color: 'var(--red)', background: 'color-mix(in oklab, var(--red) 8%, transparent)' }}>{error}</div>}

      {isOver ? (
        <Centered><span className="serif" style={{ fontSize: 28, color: 'var(--ink)' }}>Stream ended</span><span style={{ fontSize: 14, color: 'var(--muted)' }}>Delete to remove it now, or it evicts automatically.</span></Centered>
      ) : (!isLive || !isJoined) ? (
        <Centered><Spinner /><span className="mono" style={{ fontSize: 12, letterSpacing: '0.12em', color: 'var(--muted)' }}>GOING LIVE…</span></Centered>
      ) : (
        <StreamScreen
          channel={channel}
          isHost
          myUid={rtmCreds?.uid}
          myName={channel.hostName || 'Host'}
          videoTrack={remoteVideoTrack}
          agentSpeakingState={agentSpeakingState}
          liveCaption={liveCaption}
          isMuted={isMuted}
          onToggleMute={toggleMute}
          onSend={onSend}
          onSpeakScript={channel.speakScript}
          onThinkScript={channel.thinkScript}
        />
      )}

      <ConfirmModal
        open={confirmEnd}
        eyebrow="END STREAM"
        title={isOver ? 'Delete this stream?' : 'End this stream?'}
        body={isOver
          ? 'This removes the stream immediately. Anyone still on the guest link will see it as ended.'
          : 'Everyone will be disconnected and the avatar will leave. This can\u2019t be undone.'}
        confirmLabel={isOver ? 'Delete' : 'End stream'}
        danger
        busy={ending}
        onConfirm={handleStop}
        onCancel={() => setConfirmEnd(false)}
      />
    </div>
  );
}

const toolbarBtn = { height: 34, padding: '0 14px', borderRadius: 10, border: '1px solid var(--line-3)', background: 'var(--panel)', color: 'var(--ink)', fontSize: 13, fontWeight: 500, cursor: 'pointer' };

function Centered({ children }) {
  return (
    <div style={{ flex: 1, minHeight: '60vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, textAlign: 'center', padding: 24 }}>
      {children}
    </div>
  );
}
