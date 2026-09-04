import { NextResponse } from "next/server";

import {
  authMode,
  hostPinConfigured,
  setSessionCookie,
  signSession,
  verifyHostPin,
} from "@/lib/auth";

export async function POST(request: Request) {
  if (authMode() === "bypass") {
    return NextResponse.json({ authenticated: true });
  }

  if (!hostPinConfigured()) {
    console.error("[auth] HOST_PIN must contain 4–12 digits");
    return NextResponse.json({ error: "Host login is not configured" }, { status: 503 });
  }

  let body: { pin?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Enter the host PIN" }, { status: 400 });
  }

  if (!verifyHostPin(body.pin)) {
    return NextResponse.json({ error: "Incorrect PIN" }, { status: 401 });
  }

  const jwt = await signSession({ id: "pin-host", email: "", name: "Host" });
  await setSessionCookie(jwt);
  return NextResponse.json({ authenticated: true });
}
