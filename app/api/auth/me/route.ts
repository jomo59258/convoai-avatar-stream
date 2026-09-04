import { NextResponse } from "next/server";

import { authMode, getSessionUser } from "@/lib/auth";

/**
 * GET /api/auth/me
 *
 * Returns the current PIN-backed host session without exposing the cookie.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json(
      { authenticated: false, authMode: authMode() },
      { status: 200 },
    );
  }

  return NextResponse.json({
    authenticated: true,
    authMode: authMode(),
    user: { id: user.id, email: user.email, name: user.name },
  });
}
