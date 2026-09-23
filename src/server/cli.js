#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb, MEALS } from './db.js';
import { importGuests, importStaff, seedMealSlots } from './import.js';
import { generateBadgesPdf } from './badges.js';
import { newStationId, newStaffId } from './codes.js';

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { flags, positional };
}

const [, , command, ...rest] = process.argv;
const { flags, positional } = parseFlags(rest);
const db = openDb(flags.db);

const commands = {
  import() {
    const file = positional[0] || flags.file;
    if (!file) throw new Error('usage: import <file.csv> [--replace] [--force]');
    const res = importGuests(db, readFileSync(resolve(file), 'utf8'), {
      replace: Boolean(flags.replace),
      force: Boolean(flags.force),
    });
    const prefix = res.replaced ? 'replaced roster — ' : '';
    console.log(`${prefix}imported: ${res.inserted} new, ${res.updated} updated, ${res.skipped} skipped`);
  },
  'import-staff'() {
    const file = positional[0] || flags.file;
    if (!file) throw new Error('usage: import-staff <file.csv>');
    const res = importStaff(db, readFileSync(resolve(file), 'utf8'));
    console.log(`staff imported: ${res.inserted} new, ${res.updated} updated, ${res.skipped} skipped`);
  },
  slots() {
    const days = String(flags.days || positional[0] || '').split(',').filter(Boolean);
    if (!days.length) throw new Error('usage: slots --days 2026-10-01,2026-10-02 [--meals breakfast,lunch,dinner]');
    const meals = flags.meals ? String(flags.meals).split(',') : MEALS;
    console.log(`seeded ${seedMealSlots(db, days, meals)} meal slots`);
  },
  'stations-add'() {
    const names = positional.length ? positional : String(flags.names || '').split(',').filter(Boolean);
    if (!names.length) throw new Error('usage: stations-add "Gate A" "Gate B"');
    const ins = db.prepare('INSERT INTO stations (station_id, name) VALUES (?, ?)');
    for (const n of names) {
      const id = newStationId();
      ins.run(id, n.trim());
      console.log(`station ${id}  ${n.trim()}`);
    }
  },
  'staff-add'() {
    const names = positional.length ? positional : String(flags.names || '').split(',').filter(Boolean);
    if (!names.length) throw new Error('usage: staff-add "Dara" "Sokha"');
    const ins = db.prepare('INSERT INTO staff (staff_id, name) VALUES (?, ?)');
    for (const n of names) {
      const id = newStaffId();
      ins.run(id, n.trim());
      console.log(`staff ${id}  ${n.trim()}`);
    }
  },
  async badges() {
    const out = flags.out || 'out/badges.pdf';
    const info = await generateBadgesPdf(db, { outPath: out, title: flags.title || 'Guest Badge' });
    console.log(`badges: ${info.guests} guests, ${info.pages} pages -> ${info.path}`);
  },
  stats() {
    const g = db.prepare('SELECT COUNT(*) n FROM guests').get().n;
    const s = db.prepare('SELECT COUNT(*) n FROM meal_slots').get().n;
    const c = db.prepare('SELECT COUNT(*) n FROM checkins').get().n;
    const st = db.prepare('SELECT COUNT(*) n FROM stations').get().n;
    console.log(`guests=${g} slots=${s} stations=${st} checkins=${c}`);
  },
};

const fn = commands[command];
if (!fn) {
  console.error(`commands: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

try {
  await fn();
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
