#!/usr/bin/env node
// Simulates a day of check-ins from 3 stations whose phones were offline,
// then syncs each station's queue in batches. Populates the dashboard.
// Usage: node scripts/simulate-day.mjs [baseUrl] [slotMeal] [turnoutPct]
const base = process.argv[2] || 'http://localhost:8090';
const meal = process.argv[3] || 'lunch';
const turnout = Number(process.argv[4] || 85) / 100;

const manifest = await (await fetch(base + '/api/manifest')).json();
const slot = manifest.slots.find((s) => s.meal === meal);
if (!slot) throw new Error(`no slot for meal ${meal}`);

const stations = manifest.stations;
const guests = manifest.guests;
const total = guests.length;
const attending = Math.round(total * turnout);

const shuffled = [...guests].sort(() => Math.random() - 0.5).slice(0, attending);

// Each station's phone collects a local (offline) queue.
const queues = stations.map(() => []);

shuffled.forEach((g, i) => {
  const station = stations[i % stations.length];
  const queue = queues[stations.indexOf(station)];
  queue.push({
    event_id: crypto.randomUUID(),
    guest_id: g.guest_id,
    slot_id: slot.slot_id,
    scanned_at: new Date(Date.now() - (attending - i) * 1000).toISOString(),
  });
});

// A few guests are scanned twice (once per door) to exercise dedup.
for (let i = 0; i < 25; i++) {
  const g = shuffled[i];
  const station = stations[(i + 1) % stations.length];
  queues[stations.indexOf(station)].push({
    event_id: crypto.randomUUID(),
    guest_id: g.guest_id,
    slot_id: slot.slot_id,
    scanned_at: new Date().toISOString(),
  });
}

const summary = { accepted: 0, duplicate: 0, unknown: 0, invalid: 0 };
for (let s = 0; s < stations.length; s++) {
  const queue = queues[s];
  const batches = 4;
  const size = Math.ceil(queue.length / batches);
  for (let b = 0; b < batches; b++) {
    const events = queue.slice(b * size, (b + 1) * size);
    if (!events.length) continue;
    const res = await fetch(base + '/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ station_id: stations[s].station_id, events }),
    });
    const data = await res.json();
    for (const [k, v] of Object.entries(data.summary)) summary[k] += v;
  }
}

const dash = await (await fetch(base + '/api/dashboard')).json();
const slotDash = dash.slots.find((s) => s.slot_id === slot.slot_id);
console.log(`slot: ${slot.label}`);
console.log(`guests on roster: ${total}, simulated attendees: ${attending}`);
console.log('sync summary:', summary);
console.log(
  `dashboard ${slot.slot_id}: ${slotDash.checked_in} checked in ` +
    `(${((slotDash.checked_in / total) * 100).toFixed(1)}%)`,
);
console.log('by station:', JSON.stringify(slotDash.stations));
