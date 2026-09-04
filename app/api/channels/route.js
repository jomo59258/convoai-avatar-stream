import { NextResponse } from 'next/server';
import { requireSession } from '../../../lib/authGuard.js';
import { createChannel, listChannels } from '../../../lib/channelManager.js';
import { normalizeLemonsliceAvatarInput } from '../../../lib/avatarInput.js';

export async function POST(request) {
  try {
    const { deny } = await requireSession();
    if (deny) return deny;
    const body = await request.json().catch(() => ({}));
    const { channelTitle, hostName, topic, mode, collectionWindowMs, ttsVendor, avatarVendor, ttsSpeed, voiceGender } = body;
    const avatarImageUrl = normalizeLemonsliceAvatarInput(body.avatarImageUrl);

    // Optional per-stream avatar image (Lemonslice): their servers fetch it,
    // so it must be a well-formed https URL with a real host — parse, don't
    // prefix-match (catches "https://", "https:// not-a-host"; accepts HTTPS://).
    if (body.avatarImageUrl && !avatarImageUrl) {
      return NextResponse.json({ error: 'Paste a full public https:// image URL or a Lemonslice agent_… ID' }, { status: 400 });
    }

    const result = await createChannel({ channelTitle, hostName, topic, mode, collectionWindowMs, ttsVendor, avatarVendor, ttsSpeed, avatarImageUrl, voiceGender });
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error creating channel:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET() {
  try {
    const { deny } = await requireSession();
    if (deny) return deny;
    return NextResponse.json({ channels: await listChannels() });
  } catch (error) {
    console.error('Error listing channels:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
