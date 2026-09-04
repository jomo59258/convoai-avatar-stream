/**
 * PIN-backed host sessions.
 *
 * Production always requires the configured HOST_PIN. Local development
 * defaults to bypass mode so contributors can run the UI without credentials.
 * Successful PIN entry creates a signed, HttpOnly session cookie.
 */

import { timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

export type AuthMode = "pin" | "bypass";

export function authMode(): AuthMode {
  const raw = (process.env.AUTH_MODE || "").toLowerCase();
  if (process.env.NODE_ENV !== "production" && raw !== "pin") return "bypass";
  return "pin";
}

export const SESSION_COOKIE = "host_session";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
};

const SESSION_TTL_SECONDS = 60 * 60 * 12;

function secretKey(): Uint8Array {
  const raw = process.env.SESSION_JWT_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      "SESSION_JWT_SECRET is not set or is shorter than 32 chars. Generate one with `openssl rand -hex 48`.",
    );
  }
  return new TextEncoder().encode(raw);
}

export function hostPinConfigured(): boolean {
  return /^\d{4,12}$/.test(process.env.HOST_PIN || "");
}

/** Compare PINs without leaking a useful timing signal. */
export function verifyHostPin(candidate: unknown): boolean {
  const expected = process.env.HOST_PIN || "";
  if (!/^\d{4,12}$/.test(expected) || typeof candidate !== "string") return false;
  const supplied = Buffer.from(candidate);
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

export async function signSession(user: SessionUser): Promise<string> {
  return await new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .setSubject(user.id)
    .sign(secretKey());
}

export async function verifySession(jwt: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(jwt, secretKey(), { algorithms: ["HS256"] });
    const id = typeof payload.id === "string" ? payload.id : null;
    const email = typeof payload.email === "string" ? payload.email : "";
    const name = typeof payload.name === "string" ? payload.name : "";
    if (!id) return null;
    return { id, email, name };
  } catch {
    return null;
  }
}

export async function getSessionUser(): Promise<SessionUser | null> {
  if (authMode() === "bypass") {
    return { id: "bypass-user", email: "demo@local", name: "Demo User" };
  }
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return token ? await verifySession(token) : null;
}

export async function setSessionCookie(jwt: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, jwt, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}
