#!/usr/bin/env node
// Generates a synthetic guest roster CSV for load-testing / dry-runs.
// Usage: node scripts/make-roster.mjs --n 1000 --out data/guests.csv
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[i + 1];
  }
  return flags;
}

const flags = parseFlags(process.argv.slice(2));
const n = Number(flags.n || 1000);
const out = resolve(flags.out || 'data/guests.csv');

const FIRST = ['Dara', 'Sokha', 'Nita', 'Vibol', 'Chenda', 'Rithy', 'Sophea', 'Kosal', 'Bopha', 'Chan', 'Mony', 'Piseth', 'Theary', 'Veasna', 'Chanthou', 'Sothea', 'Ravy', 'Thida', 'Narith', 'Sreyleak'];
const LAST = ['Sok', 'Chan', 'Meas', 'Kim', 'Rin', 'Prak', 'Long', 'Chea', 'Heng', 'Lim', 'Nou', 'Ouk', 'Pen', 'Sam', 'Tep', 'Ung', 'Vy', 'Yin', 'Chhim', 'Keo'];
const GROUPS = ['Organizing Committee', 'VIP', 'Volunteers', 'Guests', 'Speakers', 'Sponsors', 'Press', 'Staff'];
const DIET = ['none', 'none', 'none', 'vegetarian', 'halal', 'gluten-free', 'vegan'];

const esc = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const pick = (arr, i) => arr[i % arr.length];

const lines = ['name,group,dietary,contact,id_card,photo'];
for (let i = 1; i <= n; i++) {
  const name = `${pick(FIRST, i * 7 + 3)} ${pick(LAST, i * 11 + 5)}`;
  const group = pick(GROUPS, i * 13 + 1);
  const diet = pick(DIET, i * 5 + 2);
  const idCard = String(100000000 + i * 137);
  lines.push([esc(name), esc(group), diet, `guest${i}@example.com`, idCard, `https://i.pravatar.cc/150?u=g${i}`].join(','));
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${n} guests -> ${out}`);
