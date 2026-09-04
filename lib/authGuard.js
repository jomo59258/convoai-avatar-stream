// Session gate for host-flavored API routes. Local development defaults to a
// synthetic bypass user; production requires a valid PIN-issued session.

import { NextResponse } from 'next/server';
import { getSessionUser } from './auth';

export async function requireSession() {
  const user = await getSessionUser();
  if (!user) {
    return {
      user: null,
      deny: NextResponse.json({ error: 'Unauthorized — enter the host PIN' }, { status: 401 }),
    };
  }
  return { user, deny: null };
}
