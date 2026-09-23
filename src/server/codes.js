import { createHmac, randomUUID, randomInt, timingSafeEqual } from 'node:crypto';

export const QR_PREFIX = 'GAT1';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1
const CODE_LEN = 6;

export function secret() {
  return process.env.QR_SECRET || 'dev-insecure-secret-change-me';
}

export function newGuestId() {
  return randomUUID();
}

export function newStaffId() {
  return randomUUID();
}

export function newStationId() {
  return randomUUID();
}

export function newEventId() {
  return randomUUID();
}

export function newFallbackCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

export function sign(guestId) {
  return createHmac('sha256', secret()).update(guestId).digest('hex').slice(0, 16);
}

export function buildQrPayload(guestId) {
  return `${QR_PREFIX}:${guestId}:${sign(guestId)}`;
}

export function parseQrPayload(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const parts = trimmed.split(':');
  if (parts.length !== 3 || parts[0] !== QR_PREFIX) return null;
  const [, guestId, sig] = parts;
  if (!guestId || !sig) return null;
  const expected = sign(guestId);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { guestId };
}

export function normalizeCode(input) {
  return String(input || '').trim().toUpperCase().replace(/[\s-]/g, '');
}
