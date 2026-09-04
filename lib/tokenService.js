import agoraToken from 'agora-token';

const { RtcTokenBuilder, RtcRole, RtmTokenBuilder } = agoraToken;

function getAppId() {
  return process.env.AGORA_APP_ID;
}

function getAppCertificate() {
  const cert = process.env.AGORA_APP_CERTIFICATE;
  if (!cert) {
    console.warn('[TokenService] AGORA_APP_CERTIFICATE not set — tokens will be empty');
    return null;
  }
  return cert;
}

const TOKEN_EXPIRY = 3600; // 1 hour

/**
 * Generate an RTC token for a numeric UID to join a channel.
 */
export function generateRtcToken(channelName, uid, role = RtcRole.PUBLISHER) {
  const appId = getAppId();
  const cert = getAppCertificate();
  if (!cert) return '';

  return RtcTokenBuilder.buildTokenWithUid(
    appId, cert, channelName, Number(uid), role,
    TOKEN_EXPIRY, TOKEN_EXPIRY
  );
}

/**
 * Generate an RTM token for a string user ID.
 */
export function generateRtmToken(userId) {
  const appId = getAppId();
  const cert = getAppCertificate();
  if (!cert) return '';

  return RtmTokenBuilder.buildToken(appId, cert, String(userId), TOKEN_EXPIRY);
}

/**
 * Generate a combined RTC+RTM token so the agent can publish
 * presence state and transcript data via RTM.
 */
export function generateRtcRtmToken(channelName, uid) {
  const appId = getAppId();
  const cert = getAppCertificate();
  if (!cert) return '';

  return RtcTokenBuilder.buildTokenWithRtm2(
    appId, cert, channelName,
    Number(uid), RtcRole.PUBLISHER,
    TOKEN_EXPIRY, TOKEN_EXPIRY, TOKEN_EXPIRY, TOKEN_EXPIRY, TOKEN_EXPIRY,
    String(uid), TOKEN_EXPIRY
  );
}

/**
 * Generate all tokens needed for a ConvoAI session with avatar.
 * Returns tokens for: user (RTC + RTM, vestigial — clients now mint their
 * own via /credentials), agent (RTC+RTM), avatar (RTC).
 */
export function generateSessionTokens(channelName, { userUid = 101, agentUid = 100, avatarUid = 102 } = {}) {
  return {
    userRtcToken: generateRtcToken(channelName, userUid),
    userRtmToken: generateRtmToken(String(userUid)),
    agentRtcToken: generateRtcRtmToken(channelName, agentUid),
    avatarRtcToken: generateRtcToken(channelName, avatarUid),
  };
}

/**
 * Mint a per-client RTC + RTM token pair. Guests are SUBSCRIBERs (audience).
 * The host gets a PUBLISHER token so it can join as a broadcaster — it never
 * publishes media, but joining as a visible role is what lets the ConvoAI
 * agent detect the host's arrival and fire its native greeting_message.
 */
export function generateClientCredentials(channelName, uid, role = 'subscriber') {
  const rtcRole = role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
  return {
    rtcToken: generateRtcToken(channelName, uid, rtcRole),
    rtmToken: generateRtmToken(String(uid)),
  };
}
