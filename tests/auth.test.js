import { afterEach, describe, expect, it, vi } from 'vitest';
import { authMode, hostPinConfigured, verifyHostPin } from '../lib/auth.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('authMode()', () => {
  it('defaults to bypass outside production', () => {
    vi.stubEnv('AUTH_MODE', '');
    expect(authMode()).toBe('bypass');
  });

  it('supports an explicit PIN gate during local development', () => {
    vi.stubEnv('AUTH_MODE', 'pin');
    expect(authMode()).toBe('pin');
  });

  it('always requires a PIN in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const configuredMode of ['', 'bypass', 'sso', 'pin']) {
      vi.stubEnv('AUTH_MODE', configuredMode);
      expect(authMode()).toBe('pin');
    }
  });
});

describe('host PIN', () => {
  it('accepts a configured 4–12 digit PIN', () => {
    vi.stubEnv('HOST_PIN', '482913');
    expect(hostPinConfigured()).toBe(true);
    expect(verifyHostPin('482913')).toBe(true);
    expect(verifyHostPin('482914')).toBe(false);
  });

  it('fails closed for missing, short, long, or non-numeric configuration', () => {
    for (const value of ['', '123', '1234567890123', '12ab56']) {
      vi.stubEnv('HOST_PIN', value);
      expect(hostPinConfigured()).toBe(false);
      expect(verifyHostPin(value)).toBe(false);
    }
  });

  it('rejects non-string input', () => {
    vi.stubEnv('HOST_PIN', '482913');
    expect(verifyHostPin(482913)).toBe(false);
    expect(verifyHostPin(null)).toBe(false);
  });
});
