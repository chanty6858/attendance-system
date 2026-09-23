import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb, MEALS } from '../src/server/db.js';
import { importGuests, seedMealSlots } from '../src/server/import.js';
import { recordEvents, dashboard, exportCsv } from '../src/server/sync.js';
import { createGuest, createGuests } from '../src/server/guests.js';
import { newEventId, buildQrPayload, parseQrPayload, sign } from '../src/server/codes.js';

function freshDb() {
  const path = resolve('out/test.db');
  mkdirSync('out', { recursive: true });
  rmSync(path, { force: true });
  rmSync(path + '-wal', { force: true });
  rmSync(path + '-shm', { force: true });
  return openDb(path);
}

function makeRoster(n) {
  const lines = ['name,group,dietary'];
  for (let i = 0; i < n; i++) lines.push(`Guest ${i},Group ${i % 20},none`);
  return lines.join('\n') + '\n';
}

test('QR payload round-trips and rejects tampering', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const payload = buildQrPayload(id);
  assert.deepEqual(parseQrPayload(payload), { guestId: id });
  assert.equal(parseQrPayload(`${payload.slice(0, -1)}0`), null, 'bad signature rejected');
  assert.equal(parseQrPayload('random text'), null);
});

test('re-import can replace the roster when the list changes', () => {
  const db = freshDb();
  importGuests(db, makeRoster(10));
  seedMealSlots(db, ['2026-10-01'], ['lunch']);
  const g = db.prepare('SELECT guest_id FROM guests LIMIT 1').get();
  recordEvents(db, {
    events: [{ event_id: newEventId(), guest_id: g.guest_id, slot_id: '2026-10-01_lunch', scanned_at: new Date().toISOString() }],
  });

  assert.throws(() => importGuests(db, makeRoster(5), { replace: true }), /refusing to replace/);

  const res = importGuests(db, makeRoster(5), { replace: true, force: true });
  assert.equal(res.inserted, 5);
  assert.equal(dashboard(db).total_guests, 5);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM checkins').get().n, 0);
});

test('staff can register a walk-in guest with a photo and get a QR', () => {
  process.env.PHOTOS_DIR = resolve('out/test-photos');
  rmSync(process.env.PHOTOS_DIR, { recursive: true, force: true });
  const db = freshDb();

  const dataUrl = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');
  const { guest, created } = createGuest(db, {
    name: 'Walk In',
    group_name: 'Guests',
    id_card: '999888777',
    photo: dataUrl,
  });

  assert.equal(created, true);
  assert.equal(guest.name, 'Walk In');
  assert.match(guest.code, /^[A-Z0-9]{6}$/);
  assert.equal(guest.photo, `/api/photo/${guest.guest_id}.jpg`);
  assert.ok(existsSync(resolve(process.env.PHOTOS_DIR, `${guest.guest_id}.jpg`)), 'photo written to disk');

  // The returned QR payload must decode back to this guest.
  assert.deepEqual(parseQrPayload(guest.qr_payload), { guestId: guest.guest_id });
});

test('walk-in registration is idempotent and can be checked in immediately', () => {
  const db = freshDb();
  seedMealSlots(db, ['2026-10-01'], ['lunch']);
  const clientId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  const first = createGuest(db, { guest_id: clientId, code: 'WALK01', name: 'Retry Guest' });
  const second = createGuest(db, { guest_id: clientId, code: 'OTHER1', name: 'Retry Guest' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.guest.code, 'WALK01', 'code stays stable on retry');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM guests').get().n, 1);

  const r = recordEvents(db, {
    events: [{ event_id: newEventId(), guest_id: clientId, slot_id: '2026-10-01_lunch', scanned_at: new Date().toISOString() }],
  });
  assert.equal(r.summary.accepted, 1, 'newly registered guest can check in');
});

test('offline sync creates pending guests before their check-ins', () => {
  const db = freshDb();
  seedMealSlots(db, ['2026-10-01'], ['lunch']);
  const offlineGuest = { guest_id: 'ffffffff-1111-4222-8333-444444444444', name: 'Offline Guest' };

  // Same batch: guest + event together (as the PWA sends them).
  const guestResult = createGuests(db, [offlineGuest]);
  assert.equal(guestResult.summary.created, 1);
  const eventResult = recordEvents(db, {
    events: [{ event_id: newEventId(), guest_id: offlineGuest.guest_id, slot_id: '2026-10-01_lunch', scanned_at: new Date().toISOString() }],
  });
  assert.equal(eventResult.summary.accepted, 1);
  assert.equal(dashboard(db).total_guests, 1);
});

test('import assigns unique ids and codes', () => {
  const db = freshDb();
  const res = importGuests(db, makeRoster(1000));
  assert.equal(res.inserted, 1000);
  const ids = db.prepare('SELECT COUNT(DISTINCT guest_id) n FROM guests').get().n;
  const codes = db.prepare('SELECT COUNT(DISTINCT code) n FROM guests').get().n;
  assert.equal(ids, 1000);
  assert.equal(codes, 1000);
});

test('roster size is flexible — any CSV row count works', () => {
  for (const n of [1, 7, 37, 2500]) {
    const db = freshDb();
    const res = importGuests(db, makeRoster(n));
    assert.equal(res.inserted, n, `${n} guests inserted`);
    seedMealSlots(db, ['2026-10-01'], ['lunch']);

    const last = db.prepare('SELECT guest_id FROM guests ORDER BY rowid DESC LIMIT 1').get();
    const r = recordEvents(db, {
      events: [{ event_id: newEventId(), guest_id: last.guest_id, slot_id: '2026-10-01_lunch', scanned_at: new Date().toISOString() }],
    });
    assert.equal(r.summary.accepted, 1, `check-in works for a roster of ${n}`);
    assert.equal(dashboard(db).total_guests, n, `dashboard reflects ${n} guests`);
  }
});

test('idempotent sync: replays never double-count', () => {
  const db = freshDb();
  importGuests(db, makeRoster(10));
  seedMealSlots(db, ['2026-10-01'], MEALS);
  const guests = db.prepare('SELECT guest_id FROM guests').all();
  const events = guests.map((g) => ({
    event_id: newEventId(),
    guest_id: g.guest_id,
    slot_id: '2026-10-01_lunch',
    scanned_at: new Date().toISOString(),
  }));

  const first = recordEvents(db, { events });
  assert.equal(first.summary.accepted, 10);
  const replay = recordEvents(db, { events });
  assert.equal(replay.summary.accepted, 0);
  assert.equal(replay.summary.duplicate, 10);

  const lunch = dashboard(db).slots.find((s) => s.meal === 'lunch');
  assert.equal(lunch.checked_in, 10);
  assert.equal(dashboard(db).slots[0].meal, 'breakfast', 'slots are in meal order');
});

test('first scan wins across two stations', () => {
  const db = freshDb();
  importGuests(db, 'name\nAlice\nBob\n');
  seedMealSlots(db, ['2026-10-01'], MEALS);
  const [alice] = db.prepare('SELECT guest_id FROM guests ORDER BY name').all();

  const early = { event_id: newEventId(), guest_id: alice.guest_id, slot_id: '2026-10-01_lunch', scanned_at: '2026-10-01T12:00:00Z' };
  const late = { event_id: newEventId(), guest_id: alice.guest_id, slot_id: '2026-10-01_lunch', scanned_at: '2026-10-01T12:05:00Z' };

  const a = recordEvents(db, { events: [early], station_id: 'gate-a' });
  const b = recordEvents(db, { events: [late], station_id: 'gate-b' });
  assert.equal(a.summary.accepted, 1);
  assert.equal(b.summary.accepted, 0);
  assert.equal(b.results[0].reason, 'already_checked_in');
  assert.equal(b.results[0].scanned_at, '2026-10-01T12:00:00Z');

  const row = db.prepare('SELECT station_id, scanned_at FROM checkins').get();
  assert.equal(row.station_id, 'gate-a');
  assert.equal(dashboard(db).slots.find((s) => s.meal === 'lunch').checked_in, 1);
});

test('unknown guest and unknown slot are rejected', () => {
  const db = freshDb();
  importGuests(db, 'name\nAlice\n');
  seedMealSlots(db, ['2026-10-01'], MEALS);
  const r = recordEvents(db, {
    events: [
      { event_id: newEventId(), guest_id: 'ghost', slot_id: '2026-10-01_lunch', scanned_at: new Date().toISOString() },
      { event_id: newEventId(), guest_id: db.prepare('SELECT guest_id FROM guests').get().guest_id, slot_id: 'nope', scanned_at: new Date().toISOString() },
    ],
  });
  assert.equal(r.summary.unknown, 2);
  assert.equal(dashboard(db).slots[0].checked_in, 0);
});

test('field test: 1000 guests x 3 stations x 3 meals, mixed offline replay', () => {
  const db = freshDb();
  const N = 1000;
  importGuests(db, makeRoster(N));
  seedMealSlots(db, ['2026-10-01', '2026-10-02'], MEALS);
  const guests = db.prepare('SELECT guest_id FROM guests ORDER BY guest_id').all();
  const stations = ['gate-a', 'gate-b', 'gate-c'];

  const all = [];
  for (const day of ['2026-10-01', '2026-10-02']) {
    for (const meal of MEALS) {
      guests.forEach((g, i) => {
        all.push({
          event_id: newEventId(),
          guest_id: g.guest_id,
          slot_id: `${day}_${meal}`,
          scanned_at: `${day}T12:${String(i % 60).padStart(2, '0')}:00Z`,
          station_id: stations[i % stations.length],
        });
      });
    }
  }

  const start = performance.now();
  const t0 = recordEvents(db, { events: all.slice(0, 3000) });
  const t1 = recordEvents(db, { events: all.slice(3000) });
  const replay = recordEvents(db, { events: all.slice(500, 1500) }); // replayed batch, must be ignored
  const ms = performance.now() - start;

  assert.equal(t0.summary.accepted + t1.summary.accepted, all.length);
  assert.equal(replay.summary.accepted, 0);
  assert.equal(replay.summary.duplicate, 1000);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM checkins').get().n, all.length);

  const csv = exportCsv(db);
  assert.equal(csv.trim().split('\n').length, all.length + 1);

  const dash = dashboard(db);
  for (const s of dash.slots) assert.equal(s.checked_in, N);

  console.log(
    `    ${all.length} events in ${ms.toFixed(0)}ms ` +
      `(${Math.round(all.length / (ms / 1000))} events/s), ` +
      `replay of 1000 dropped by dedup`,
  );
});
