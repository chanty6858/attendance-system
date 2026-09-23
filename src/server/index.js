import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { createReadStream, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, MEALS, SLOT_ORDER_SQL } from './db.js';
import { importGuests, seedMealSlots } from './import.js';
import { generateBadgesPdf } from './badges.js';
import { recordEvents, dashboard, exportCsv } from './sync.js';
import { createGuest, createGuests, readPhoto } from './guests.js';
import { newStationId, newStaffId, secret } from './codes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, '../web');

export async function buildServer({ db = openDb(), adminToken = process.env.ADMIN_TOKEN || '' } = {}) {
  const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });

  await app.register(fastifyStatic, { root: WEB_ROOT, prefix: '/' });

  // Accept a raw CSV body (used by the admin import endpoint) as well as JSON.
  for (const type of ['text/csv', 'text/plain', 'application/csv']) {
    app.addContentTypeParser(type, { parseAs: 'string' }, (_req, body, done) => done(null, body));
  }

  const requireAdmin = async (req, reply) => {
    if (!adminToken) return;
    if (req.headers['x-admin-token'] !== adminToken) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  app.get('/api/slots', async () => ({
    slots: db.prepare(`SELECT slot_id, day, meal, label FROM meal_slots ORDER BY day, ${SLOT_ORDER_SQL}`).all(),
  }));

  app.get('/api/stations', async () => ({
    stations: db.prepare('SELECT station_id, name, active FROM stations ORDER BY name').all(),
  }));

  app.get('/api/staff', async () => ({
    staff: db.prepare('SELECT staff_id, name, role FROM staff ORDER BY name').all(),
  }));

  // Everything a phone needs to work offline: guest roster + slots.
  app.get('/api/manifest', async () => ({
    server_time: new Date().toISOString(),
    qr_secret: secret(),
    guests: db
      .prepare('SELECT guest_id, name, group_name, dietary, id_card, photo, code FROM guests ORDER BY name COLLATE NOCASE')
      .all(),
    slots: db.prepare(`SELECT slot_id, day, meal, label FROM meal_slots ORDER BY day, ${SLOT_ORDER_SQL}`).all(),
    stations: db.prepare('SELECT station_id, name FROM stations WHERE active=1 ORDER BY name').all(),
    staff: db.prepare('SELECT staff_id, name, role FROM staff ORDER BY name').all(),
  }));

  app.post('/api/sync', async (req) => {
    const { station_id, staff_id, events, guests } = req.body || {};
    const guestResult = guests?.length ? createGuests(db, guests) : null;
    const eventResult = recordEvents(db, { station_id, staff_id, events: events || [] });
    return guestResult ? { ...eventResult, guests: guestResult } : eventResult;
  });

  // Walk-in registration (works offline too: guest_id + code are client-generated).
  app.post('/api/guests', async (req, reply) => {
    try {
      const { guest, created } = createGuest(db, req.body || {});
      return reply.code(created ? 201 : 200).send({ guest, created });
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.get('/api/photo/:file', async (req, reply) => {
    const bytes = readPhoto(req.params.file);
    if (!bytes) return reply.code(404).send({ error: 'not_found' });
    const ext = req.params.file.split('.').pop().toLowerCase();
    const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    reply.header('cache-control', 'public, max-age=86400');
    return reply.type(type).send(bytes);
  });

  app.get('/api/dashboard', async (req) => dashboard(db, { slot_id: req.query.slot_id }));

  app.get('/api/checked-in', async (req, reply) => {
    const slot = req.query.slot_id;
    if (!slot) return reply.code(400).send({ error: 'slot_id required' });
    const rows = db.prepare('SELECT guest_id FROM checkins WHERE slot_id = ?').all(slot);
    return { slot_id: slot, guest_ids: rows.map((r) => r.guest_id) };
  });

  app.get('/api/export.csv', async (req, reply) => {
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="attendance.csv"');
    return exportCsv(db, { slot_id: req.query.slot_id });
  });

  app.get('/api/guest/:code', async (req, reply) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const guest = db
      .prepare('SELECT guest_id, name, group_name, dietary, id_card, photo, code FROM guests WHERE code = ?')
      .get(code);
    if (!guest) return reply.code(404).send({ error: 'not_found' });
    return guest;
  });

  // ---- admin ----
  app.post('/api/admin/import', { preHandler: requireAdmin }, async (req, reply) => {
    const isObject = req.body !== null && typeof req.body === 'object';
    const csvText = typeof req.body === 'string' ? req.body : req.body?.csv;
    if (!csvText) return reply.code(400).send({ error: 'expected raw CSV body or {csv}' });
    try {
      return importGuests(db, csvText, {
        // Only honour these when a JSON object was sent — a raw CSV string has
        // its own `replace`/`force` properties (String.prototype) that must not leak in.
        replace: isObject ? Boolean(req.body.replace) : false,
        force: isObject ? Boolean(req.body.force) : false,
      });
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post('/api/admin/slots', { preHandler: requireAdmin }, async (req, reply) => {
    const { days, meals } = req.body || {};
    if (!Array.isArray(days) || days.length === 0) {
      return reply.code(400).send({ error: 'days[] required, e.g. ["2026-10-01"]' });
    }
    const chosenMeals = Array.isArray(meals) && meals.length ? meals : MEALS;
    const count = seedMealSlots(db, days, chosenMeals);
    return { seeded: count };
  });

  app.post('/api/admin/stations', { preHandler: requireAdmin }, async (req, reply) => {
    const names = req.body?.names || (req.body?.name ? [req.body.name] : []);
    if (!names.length) return reply.code(400).send({ error: 'name or names[] required' });
    const ins = db.prepare('INSERT INTO stations (station_id, name) VALUES (?, ?)');
    const created = [];
    const run = db.transaction(() => {
      for (const name of names) {
        const id = newStationId();
        ins.run(id, String(name).trim());
        created.push({ station_id: id, name });
      }
    });
    run();
    return { created };
  });

  app.post('/api/admin/staff', { preHandler: requireAdmin }, async (req, reply) => {
    const names = req.body?.names || (req.body?.name ? [req.body.name] : []);
    if (!names.length) return reply.code(400).send({ error: 'name or names[] required' });
    const ins = db.prepare('INSERT INTO staff (staff_id, name) VALUES (?, ?)');
    const created = [];
    const run = db.transaction(() => {
      for (const name of names) {
        const id = newStaffId();
        ins.run(id, String(name).trim());
        created.push({ staff_id: id, name });
      }
    });
    run();
    return { created };
  });

  app.get('/api/admin/badges.pdf', { preHandler: requireAdmin }, async (req, reply) => {
    const outPath = resolve('out/badges.pdf');
    const info = await generateBadgesPdf(db, { outPath });
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', 'inline; filename="badges.pdf"');
    return reply.send(createReadStream(info.path));
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
    if (req.url === '/dashboard' || req.url.startsWith('/dashboard')) {
      return reply.type('text/html').send(readFileSync(resolve(WEB_ROOT, 'dashboard.html')));
    }
    return reply.type('text/html').send(readFileSync(resolve(WEB_ROOT, 'index.html')));
  });

  return app;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  const app = await buildServer();
  app.listen({ port, host }).then(() => {
    console.log(`Attendance server on http://${host}:${port}`);
  });
}
