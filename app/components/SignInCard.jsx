'use client';

import { useState } from 'react';

/** PIN prompt for host-only surfaces. Guest viewing remains public. */
export default function SignInCard({ signIn, authError, note }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (busy || !pin) return;
    setBusy(true);
    try {
      await signIn(pin);
    } catch {
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ width: '100%', maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span className="mono" style={{ fontSize: 12, letterSpacing: '0.16em', color: 'var(--faint)' }}>HOSTS ONLY</span>
        <h1 className="serif" style={{ margin: 0, fontSize: 40, lineHeight: 1.05, letterSpacing: '-0.01em', color: 'var(--ink)' }}>
          Enter the host PIN
        </h1>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: 'var(--muted)' }}>
          Enter the shared PIN to create and manage streams.
        </p>
      </div>
      <input
        aria-label="Host PIN"
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        autoFocus
        maxLength={12}
        value={pin}
        onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
        placeholder="PIN"
        style={{ height: 56, padding: '0 18px', border: '1px solid var(--line-3)', borderRadius: 14, fontSize: 22, letterSpacing: '0.18em', color: 'var(--ink)', background: 'var(--panel)', width: '100%' }}
      />
      {authError && (
        <div role="alert" style={{ padding: '10px 14px', background: 'color-mix(in oklab, var(--red) 10%, transparent)', border: '1px solid color-mix(in oklab, var(--red) 30%, transparent)', borderRadius: 10, fontSize: 13, color: 'var(--red)' }}>
          {authError}
        </div>
      )}
      <button
        type="submit"
        disabled={busy || pin.length < 4}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 56, border: 0, borderRadius: 14, background: 'var(--ink)', color: '#fff', fontSize: 16, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', opacity: busy || pin.length < 4 ? 0.55 : 1 }}
      >
        {busy ? 'Checking…' : 'Unlock hosting'}
      </button>
      {note && <span style={{ fontSize: 13, color: 'var(--faint)', textAlign: 'center' }}>{note}</span>}
    </form>
  );
}
