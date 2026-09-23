import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { newGuestId, newFallbackCode } from './codes.js';

const HEADER_ALIASES = {
  name: ['name', 'full_name', 'fullname', 'guest', 'guest_name'],
  group_name: ['group', 'group_name', 'team', 'org', 'organization', 'company'],
  dietary: ['dietary', 'diet', 'dietary_notes', 'notes', 'allergies'],
  contact: ['contact', 'email', 'phone', 'mobile'],
  id_card: ['id_card', 'id_number', 'national_id', 'identity', 'id_no', 'passport'],
  photo: ['photo', 'picture', 'photo_url', 'image', 'avatar'],
  guest_id: ['guest_id', 'uuid'],
  staff_id: ['staff_id'],
  role: ['role', 'position', 'job', 'title'],
};

function resolveHeaders(headers) {
  const normalized = headers.map((h) => String(h).trim().toLowerCase());
  const map = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = normalized.findIndex((h) => aliases.includes(h));
    if (idx !== -1) map[field] = headers[idx];
  }
  return map;
}

export function importGuests(db, csvText, { replace = false, force = false } = {}) {
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  const existingCheckins = db.prepare('SELECT COUNT(*) AS n FROM checkins').get().n;
  if (replace && existingCheckins > 0 && !force) {
    throw new Error(
      `refusing to replace the roster: ${existingCheckins} check-ins already recorded. ` +
        `Pass --force to delete them as well.`,
    );
  }
  if (replace) {
    db.transaction(() => {
      db.prepare('DELETE FROM checkins').run();
      db.prepare('DELETE FROM guests').run();
    })();
  }

  if (rows.length === 0) return { inserted: 0, updated: 0, skipped: 0, replaced: replace };

  const headerMap = resolveHeaders(Object.keys(rows[0]));
  if (!headerMap.name) {
    throw new Error(
      `CSV must have a name column. Found headers: ${Object.keys(rows[0]).join(', ')}`,
    );
  }

  const existsById = db.prepare('SELECT guest_id FROM guests WHERE guest_id = ?');
  const codeExists = db.prepare('SELECT 1 FROM guests WHERE code = ?');
  const insert = db.prepare(`
    INSERT INTO guests (guest_id, name, group_name, dietary, contact, id_card, photo, code)
    VALUES (@guest_id, @name, @group_name, @dietary, @contact, @id_card, @photo, @code)
  `);
  const update = db.prepare(`
    UPDATE guests SET name=@name, group_name=@group_name, dietary=@dietary,
      contact=@contact, id_card=@id_card, photo=@photo
    WHERE guest_id=@guest_id
  `);

  const uniqueCode = () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = newFallbackCode();
      if (!codeExists.get(code)) return code;
    }
    throw new Error('could not generate a unique fallback code');
  };

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const run = db.transaction(() => {
    for (const row of rows) {
      const name = String(row[headerMap.name] ?? '').trim();
      if (!name) {
        skipped++;
        continue;
      }
      const group_name = headerMap.group_name ? String(row[headerMap.group_name] ?? '').trim() : null;
      const dietary = headerMap.dietary ? String(row[headerMap.dietary] ?? '').trim() : null;
      const contact = headerMap.contact ? String(row[headerMap.contact] ?? '').trim() : null;
      const id_card = headerMap.id_card ? String(row[headerMap.id_card] ?? '').trim() : null;
      const photo = headerMap.photo ? String(row[headerMap.photo] ?? '').trim() : null;
      const providedId = headerMap.guest_id ? String(row[headerMap.guest_id] ?? '').trim() : '';

      if (providedId && existsById.get(providedId)) {
        update.run({ guest_id: providedId, name, group_name, dietary, contact, id_card, photo });
        updated++;
        continue;
      }

      const guest_id = providedId || newGuestId();
      insert.run({ guest_id, name, group_name, dietary, contact, id_card, photo, code: uniqueCode() });
      inserted++;
    }
  });

  run();
  return { inserted, updated, skipped, replaced: replace };
}

export function importStaff(db, csvText) {
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
  if (rows.length === 0) return { inserted: 0, updated: 0, skipped: 0 };

  const headerMap = resolveHeaders(Object.keys(rows[0]));
  if (!headerMap.name) {
    throw new Error(
      `CSV must have a name column. Found headers: ${Object.keys(rows[0]).join(', ')}`,
    );
  }

  const existsById = db.prepare('SELECT staff_id FROM staff WHERE staff_id = ?');
  const insert = db.prepare(`
    INSERT INTO staff (staff_id, name, role, contact)
    VALUES (@staff_id, @name, @role, @contact)
  `);
  const update = db.prepare(`
    UPDATE staff SET name=@name, role=@role, contact=@contact WHERE staff_id=@staff_id
  `);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const run = db.transaction(() => {
    for (const row of rows) {
      const name = String(row[headerMap.name] ?? '').trim();
      if (!name) {
        skipped++;
        continue;
      }
      const role = headerMap.role ? String(row[headerMap.role] ?? '').trim() : null;
      const contact = headerMap.contact ? String(row[headerMap.contact] ?? '').trim() : null;
      const staff_id = headerMap.staff_id && String(row[headerMap.staff_id] ?? '').trim()
        ? String(row[headerMap.staff_id]).trim()
        : `staff_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

      if (existsById.get(staff_id)) {
        update.run({ staff_id, name, role, contact });
        updated++;
        continue;
      }
      insert.run({ staff_id, name, role, contact });
      inserted++;
    }
  });

  run();
  return { inserted, updated, skipped };
}

export function seedMealSlots(db, days, meals) {
  const upsert = db.prepare(`
    INSERT INTO meal_slots (slot_id, day, meal, label)
    VALUES (@slot_id, @day, @meal, @label)
    ON CONFLICT(day, meal) DO UPDATE SET label=excluded.label
  `);
  let count = 0;
  const run = db.transaction(() => {
    for (const day of days) {
      for (const meal of meals) {
        upsert.run({
          slot_id: `${day}_${meal}`,
          day,
          meal,
          label: `${day} ${meal}`,
        });
        count++;
      }
    }
  });
  run();
  return count;
}
