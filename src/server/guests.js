import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { newGuestId, newFallbackCode, buildQrPayload } from './codes.js';

const photosDir = () => resolve(process.env.PHOTOS_DIR || 'data/photos');

function savePhoto(guestId, dataUrlOrPath) {
  if (!dataUrlOrPath || typeof dataUrlOrPath !== 'string') return null;
  const str = dataUrlOrPath.trim();
  if (!str) return null;
  // Already a URL or relative path -> store as-is.
  if (!str.startsWith('data:')) return str;

  const m = str.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
  if (!m) return null;
  const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
  const buf = Buffer.from(m[2], 'base64');
  const dir = photosDir();
  mkdirSync(dir, { recursive: true });
  const filename = `${guestId}.${ext}`;
  writeFileSync(resolve(dir, filename), buf);
  return `/api/photo/${filename}`;
}

export function photoPublicPath(filename) {
  const safe = String(filename || '').replace(/[^a-zA-Z0-9._-]/g, '');
  return resolve(photosDir(), safe);
}

export function readPhoto(filename) {
  const p = photoPublicPath(filename);
  if (!existsSync(p)) return null;
  return readFileSync(p);
}

function uniqueCode(db, preferred) {
  const exists = db.prepare('SELECT 1 FROM guests WHERE code = ?');
  if (preferred && !exists.get(preferred)) return preferred;
  for (let i = 0; i < 50; i++) {
    const code = newFallbackCode();
    if (!exists.get(code)) return code;
  }
  throw new Error('could not generate a unique fallback code');
}

/**
 * Creates a guest (walk-in registration). Idempotent by guest_id so offline
 * phones can retry safely. Returns { guest, created }.
 */
export function createGuest(db, input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('name is required');

  const guestId = String(input.guest_id || '').trim() || newGuestId();
  const existing = db.prepare('SELECT * FROM guests WHERE guest_id = ?').get(guestId);
  if (existing) {
    return { guest: withQr(db, existing), created: false };
  }

  const code = uniqueCode(db, String(input.code || '').trim() || null);
  const photo = savePhoto(guestId, input.photo);

  db.prepare(`
    INSERT INTO guests (guest_id, name, group_name, dietary, contact, id_card, photo, code)
    VALUES (@guest_id, @name, @group_name, @dietary, @contact, @id_card, @photo, @code)
  `).run({
    guest_id: guestId,
    name,
    group_name: input.group_name ? String(input.group_name).trim() : null,
    dietary: input.dietary ? String(input.dietary).trim() : null,
    contact: input.contact ? String(input.contact).trim() : null,
    id_card: input.id_card ? String(input.id_card).trim() : null,
    photo,
    code,
  });

  const guest = db.prepare('SELECT * FROM guests WHERE guest_id = ?').get(guestId);
  return { guest: withQr(db, guest), created: true };
}

function withQr(db, guest) {
  return { ...guest, qr_payload: buildQrPayload(guest.guest_id) };
}

export function createGuests(db, list = []) {
  const results = [];
  const summary = { created: 0, existing: 0, invalid: 0 };
  const run = db.transaction(() => {
    for (const item of list) {
      try {
        const { guest, created } = createGuest(db, item);
        results.push({
          guest_id: guest.guest_id,
          code: guest.code,
          qr_payload: guest.qr_payload,
          status: created ? 'created' : 'existing',
        });
        summary[created ? 'created' : 'existing']++;
      } catch (err) {
        results.push({ guest_id: item?.guest_id, status: 'invalid', reason: err.message });
        summary.invalid++;
      }
    }
  });
  run();
  return { results, summary };
}
