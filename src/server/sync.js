import { SLOT_ORDER_SQL } from './db.js';

export function recordEvents(db, { station_id = null, staff_id = null, events = [] } = {}) {
  const guestExists = db.prepare('SELECT 1 FROM guests WHERE guest_id = ?');
  const slotExists = db.prepare('SELECT 1 FROM meal_slots WHERE slot_id = ?');
  const byEvent = db.prepare('SELECT * FROM checkins WHERE event_id = ?');
  const byGuestSlot = db.prepare('SELECT * FROM checkins WHERE guest_id = ? AND slot_id = ?');
  const insert = db.prepare(`
    INSERT INTO checkins (event_id, guest_id, slot_id, scanned_at, station_id, staff_id)
    VALUES (@event_id, @guest_id, @slot_id, @scanned_at, @station_id, @staff_id)
  `);

  const results = [];

  const run = db.transaction(() => {
    for (const ev of events) {
      const eventId = ev?.event_id;
      const guestId = ev?.guest_id;
      const slotId = ev?.slot_id;
      const scannedAt = ev?.scanned_at || new Date().toISOString();

      if (!eventId || !guestId || !slotId) {
        results.push({ event_id: eventId, status: 'invalid' });
        continue;
      }
      if (byEvent.get(eventId)) {
        results.push({ event_id: eventId, status: 'duplicate', reason: 'event_id' });
        continue;
      }
      if (!guestExists.get(guestId)) {
        results.push({ event_id: eventId, status: 'unknown', reason: 'guest' });
        continue;
      }
      if (!slotExists.get(slotId)) {
        results.push({ event_id: eventId, status: 'unknown', reason: 'slot' });
        continue;
      }
      const existing = byGuestSlot.get(guestId, slotId);
      if (existing) {
        results.push({
          event_id: eventId,
          status: 'duplicate',
          reason: 'already_checked_in',
          scanned_at: existing.scanned_at,
        });
        continue;
      }
      insert.run({
        event_id: eventId,
        guest_id: guestId,
        slot_id: slotId,
        scanned_at: scannedAt,
        station_id: ev.station_id || station_id,
        staff_id: ev.staff_id || staff_id,
      });
      results.push({ event_id: eventId, status: 'accepted' });
    }
  });

  run();

  const summary = { accepted: 0, duplicate: 0, unknown: 0, invalid: 0 };
  for (const r of results) summary[r.status] = (summary[r.status] || 0) + 1;
  return { results, summary };
}

export function dashboard(db, { slot_id } = {}) {
  const slots = db
    .prepare(
      `SELECT slot_id, day, meal, label FROM meal_slots
       ORDER BY day, ${SLOT_ORDER_SQL}`,
    )
    .all();

  const filter = slot_id ? 'WHERE c.slot_id = @slot' : '';
  const params = slot_id ? { slot: slot_id } : {};

  const totalsBySlot = db
    .prepare(
      `SELECT c.slot_id, COUNT(*) AS checked_in
       FROM checkins c ${filter}
       GROUP BY c.slot_id`,
    )
    .all(params);
  const totalMap = Object.fromEntries(totalsBySlot.map((r) => [r.slot_id, r.checked_in]));

  const byStation = db
    .prepare(
      `SELECT c.slot_id, COALESCE(s.name, 'unassigned') AS station, COUNT(*) AS count
       FROM checkins c
       LEFT JOIN stations s ON s.station_id = c.station_id
       ${filter}
       GROUP BY c.slot_id, station
       ORDER BY c.slot_id, count DESC`,
    )
    .all(params);

  const totalGuests = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;

  return {
    total_guests: totalGuests,
    slots: slots.map((s) => ({
      ...s,
      checked_in: totalMap[s.slot_id] || 0,
      stations: byStation.filter((b) => b.slot_id === s.slot_id).map((b) => ({ name: b.station, count: b.count })),
    })),
    generated_at: new Date().toISOString(),
  };
}

export function exportCsv(db, { slot_id } = {}) {
  const rows = db
    .prepare(
      `SELECT g.name, g.group_name, g.dietary, m.day, m.meal, c.scanned_at,
              COALESCE(s.name,'') AS station, COALESCE(st.name,'') AS staff
       FROM checkins c
       JOIN guests g ON g.guest_id = c.guest_id
       JOIN meal_slots m ON m.slot_id = c.slot_id
       LEFT JOIN stations s ON s.station_id = c.station_id
       LEFT JOIN staff st ON st.staff_id = c.staff_id
       ${slot_id ? 'WHERE c.slot_id = ?' : ''}
       ORDER BY m.day, m.meal, g.name COLLATE NOCASE`,
    )
    .all(...(slot_id ? [slot_id] : []));

  const header = ['name', 'group', 'dietary', 'day', 'meal', 'scanned_at', 'station', 'staff'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.name, r.group_name, r.dietary, r.day, r.meal, r.scanned_at, r.station, r.staff].map(esc).join(','));
  }
  return lines.join('\n') + '\n';
}
