import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../src/server/db.js';
import { buildServer } from '../src/server/index.js';

function freshDb() {
  const path = resolve('out/http-test.db');
  mkdirSync('out', { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  return openDb(path);
}

async function app(adminToken = '') {
  return buildServer({ db: freshDb(), adminToken });
}

test('admin routes require the token (and do not hang)', async () => {
  const server = await app('secret');
  const noToken = await server.inject({ method: 'POST', url: '/api/admin/stations', payload: { name: 'X' } });
  assert.equal(noToken.statusCode, 401);

  const wrong = await server.inject({
    method: 'POST',
    url: '/api/admin/stations',
    headers: { 'x-admin-token': 'nope' },
    payload: { name: 'X' },
  });
  assert.equal(wrong.statusCode, 401);

  const ok = await server.inject({
    method: 'POST',
    url: '/api/admin/stations',
    headers: { 'x-admin-token': 'secret' },
    payload: { name: 'Gate A' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().created[0].name, 'Gate A');

  const slots = await server.inject({
    method: 'POST',
    url: '/api/admin/slots',
    headers: { 'x-admin-token': 'secret' },
    payload: { days: ['2026-10-01'] },
  });
  assert.equal(slots.statusCode, 200);
  assert.equal(slots.json().seeded, 3);

  await server.close();
});

test('admin protect directly (adminToken provided)', async () => {
  const server = await app('secret');
  const res = await server.inject({ method: 'GET', url: '/api/admin/badges.pdf', headers: { 'x-admin-token': 'nope' } });
  assert.equal(res.statusCode, 401);
  await server.close();
});

test('admin routes are open when no ADMIN_TOKEN is configured', async () => {
  const server = await app('');
  const res = await server.inject({ method: 'POST', url: '/api/admin/stations', payload: { name: 'Open Gate' } });
  assert.equal(res.statusCode, 200);
  await server.close();
});

test('end-to-end over HTTP: register guest + sync check-in + dashboard + export', async () => {
  const server = await app('');
  await server.inject({ method: 'POST', url: '/api/admin/slots', payload: { days: ['2026-10-01'] } });

  const guest = await server.inject({ method: 'POST', url: '/api/guests', payload: { name: 'Http Guest', id_card: '777' } });
  assert.equal(guest.statusCode, 201);
  const g = guest.json().guest;
  assert.ok(g.qr_payload.startsWith('GAT1:'));

  const sync = await server.inject({
    method: 'POST',
    url: '/api/sync',
    payload: {
      guests: [{ guest_id: 'aaaa-bbbb', name: 'Offline Guest' }],
      events: [
        { event_id: 'e1', guest_id: g.guest_id, slot_id: '2026-10-01_lunch', scanned_at: new Date().toISOString() },
        { event_id: 'e2', guest_id: 'aaaa-bbbb', slot_id: '2026-10-01_lunch', scanned_at: new Date().toISOString() },
      ],
    },
  });
  assert.equal(sync.statusCode, 200);
  assert.equal(sync.json().summary.accepted, 2);
  assert.equal(sync.json().guests.summary.created, 1);

  const dash = await server.inject({ method: 'GET', url: '/api/dashboard' });
  const lunch = dash.json().slots.find((s) => s.meal === 'lunch');
  assert.equal(lunch.checked_in, 2);
  assert.equal(dash.json().total_guests, 2);

  const csv = await server.inject({ method: 'GET', url: '/api/export.csv' });
  assert.equal(csv.statusCode, 200);
  assert.equal(csv.body.trim().split('\n').length, 3);

  await server.close();
});

test('admin import accepts a raw CSV body and JSON', async () => {
  const server = await app('secret');
  const raw = await server.inject({
    method: 'POST',
    url: '/api/admin/import',
    headers: { 'x-admin-token': 'secret', 'content-type': 'text/csv' },
    payload: 'name,group,id_card\nA Guest,Guests,111\nB Guest,Guests,222\n',
  });
  assert.equal(raw.statusCode, 200, 'raw text/csv body is parsed');
  assert.equal(raw.json().inserted, 2);
  assert.equal(raw.json().replaced, false, 'a raw CSV body must not trigger a replace');

  const second = await server.inject({
    method: 'POST',
    url: '/api/admin/import',
    headers: { 'x-admin-token': 'secret', 'content-type': 'text/csv' },
    payload: 'name,group,id_card\nD Guest,Guests,444\n',
  });
  assert.equal(second.json().inserted, 1, 'raw import adds to the roster');

  const json = await server.inject({
    method: 'POST',
    url: '/api/admin/import',
    headers: { 'x-admin-token': 'secret' },
    payload: { csv: 'name\nC Guest\n' },
  });
  assert.equal(json.statusCode, 200);
  assert.equal(json.json().inserted, 1);

  const list = await server.inject({ method: 'GET', url: '/api/manifest' });
  assert.equal(list.json().guests.length, 4, 'roster accumulated, not wiped');
  await server.close();
});

test('static app shell and health are served', async () => {
  const server = await app('');
  assert.equal((await server.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
  const home = await server.inject({ method: 'GET', url: '/' });
  assert.equal(home.statusCode, 200);
  assert.match(home.body, /Register new guest/);
  await server.close();
});
