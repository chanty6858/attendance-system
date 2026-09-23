import {
  kvGet,
  kvSet,
  outboxAdd,
  outboxAll,
  outboxCount,
  outboxDelete,
  guestOutboxAdd,
  guestOutboxAll,
  guestOutboxCount,
  guestOutboxDelete,
} from '/idb.js';
import { hmacSha256Hex, randomUUID } from '/crypto-util.js';

const $ = (sel) => document.querySelector(sel);
const QR_PREFIX = 'GAT1';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SCAN_COOLDOWN_MS = 4000;
const RESCAN_SAME_MS = 15000;

const state = {
  manifest: null,
  guestsById: new Map(),
  guestsByCode: new Map(),
  config: { station_id: null, station_name: '—', staff_id: null, staff_name: '' },
  slotId: null,
  serverChecked: new Set(),
  localChecked: new Set(),
  lastScan: { text: '', at: 0 },
  scanning: false,
  stream: null,
  rafId: null,
  processing: false,
  regStream: null,
  capturedPhoto: '',
  lastRegistered: null,
};

// ---------- helpers ----------
async function hmacHex16(text) {
  const secret = state.manifest?.qr_secret;
  if (!secret) return null;
  if (globalThis.crypto?.subtle) {
    try {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
      );
      const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
      return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    } catch {
      // fall through to the pure-JS implementation
    }
  }
  return hmacSha256Hex(secret, text).slice(0, 16);
}

async function parsePayload(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split(':');
  if (parts.length !== 3 || parts[0] !== QR_PREFIX) return null;
  const [, guestId, sig] = parts;
  const expected = await hmacHex16(guestId);
  if (expected && expected !== sig) return null;
  return { guestId };
}

function newLocalCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!state.guestsByCode.has(code)) return code;
  }
  throw new Error('could not generate a unique code');
}

async function qrPayloadFor(guestId) {
  const sig = await hmacHex16(guestId);
  if (!sig) throw new Error('cannot sign QR while offline without a cached guest list');
  return `${QR_PREFIX}:${guestId}:${sig}`;
}

function renderQr(container, text) {
  if (typeof globalThis.qrcode !== 'function') {
    throw new Error('QR generator not loaded — refresh the page and try again.');
  }
  const qr = globalThis.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  container.innerHTML = qr.createSvgTag(5, 2);
}

function currentSlot() {
  const slots = state.manifest?.slots || [];
  if (!slots.length) return null;
  const now = new Date();
  const iso = now.toISOString().slice(0, 10);
  const hour = now.getHours();
  const meal = hour < 11 ? 'breakfast' : hour < 16 ? 'lunch' : 'dinner';
  return (
    slots.find((s) => s.day === iso && s.meal === meal) ||
    slots.find((s) => s.day === iso) ||
    slots[0]
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function biHtml(en, km) {
  return escapeHtml(en) + (km ? `<span class="km">${escapeHtml(km)}</span>` : '');
}

function biInline(en, km) {
  return escapeHtml(en) + (km ? ` <span class="km inline">${escapeHtml(km)}</span>` : '');
}

function setResult(en, km = '', kind = '', photo = '') {
  const el = $('#result');
  el.className = 'result' + (kind ? ' ' + kind : '');
  $('#resultText').innerHTML = biHtml(en, km);
  const img = $('#resultPhoto');
  if (photo) {
    img.src = photo;
    img.classList.remove('hidden');
  } else {
    img.removeAttribute('src');
    img.classList.add('hidden');
  }
}

function setNet() {
  const el = $('#netBadge');
  const online = navigator.onLine;
  el.innerHTML = biInline(online ? 'online' : 'offline', online ? 'អនឡាញ' : 'អត់អ៊ីនធឺណិត');
  el.className = 'net ' + (online ? 'online' : 'offline');
}

async function updatePending() {
  const [n, g] = await Promise.all([outboxCount(), guestOutboxCount()]);
  const parts = [];
  if (n) parts.push(biInline(`${n} scan${n > 1 ? 's' : ''}`, 'ស្កេន'));
  if (g) parts.push(biInline(`${g} new guest${g > 1 ? 's' : ''}`, 'ភ្ញៀវថ្មី'));
  $('#pendingBadge').innerHTML = parts.length
    ? `${parts.join(' · ')} <span class="km inline">រង់ចាំផ្ញើ</span>`
    : biInline('all synced', 'ផ្ញើរួចទាំងអស់');
}

// ---------- manifest ----------
async function refreshManifest() {
  try {
    const res = await fetch('/api/manifest', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    await kvSet('manifest', data);
    applyManifest(data);
    return true;
  } catch {
    const cached = await kvGet('manifest');
    if (cached) applyManifest(cached);
    return false;
  }
}

function applyManifest(data) {
  state.manifest = data;
  state.guestsById = new Map(data.guests.map((g) => [g.guest_id, g]));
  state.guestsByCode = new Map(data.guests.map((g) => [g.code.toUpperCase(), g]));
  fillSetupOptions(data);
}

function fillSetupOptions(data) {
  const ss = $('#stationSelect');
  const st = $('#staffSelect');
  if (!ss.options.length) {
    ss.innerHTML = data.stations.map((s) => `<option value="${s.station_id}">${escapeHtml(s.name)}</option>`).join('');
    st.innerHTML = data.staff.map((s) => `<option value="${s.staff_id}">${escapeHtml(s.name)}</option>`).join('');
  }
  const slotSel = $('#slotSelect');
  slotSel.innerHTML = (data.slots || [])
    .map((s) => `<option value="${s.slot_id}">${escapeHtml(s.label || s.slot_id)}</option>`)
    .join('');
  if (state.slotId) slotSel.value = state.slotId;
}

// ---------- config ----------
async function loadConfig() {
  const cfg = (await kvGet('config')) || {};
  Object.assign(state.config, cfg);
  state.slotId = await kvGet('slot_id');
  const base = (await kvGet('base_checked')) || {};
  for (const [slot, ids] of Object.entries(base)) {
    if (slot === state.slotId) ids.forEach((id) => state.serverChecked.add(id));
  }
}

async function saveConfig() {
  await kvSet('config', state.config);
  await kvSet('slot_id', state.slotId);
}

// ---------- check-in ----------
function slotKey(guestId, slotId) {
  return `${guestId}|${slotId}`;
}

async function checkInGuest(guest, source) {
  const slotId = state.slotId;
  if (!slotId) {
    setResult('No meal slot selected', 'មិនបានជ្រើសអាហារ', 'red');
    return;
  }
  const key = slotKey(guest.guest_id, slotId);
  if (state.localChecked.has(key) || state.serverChecked.has(key)) {
    setResult(`${guest.name} — already checked in`, `${guest.name} — បានកត់ត្រារួចហើយ`, 'amber', guest.photo);
    return;
  }
  const event = {
    event_id: randomUUID(),
    guest_id: guest.guest_id,
    slot_id: slotId,
    scanned_at: new Date().toISOString(),
    station_id: state.config.station_id,
    staff_id: state.config.staff_id,
    _name: guest.name,
    _source: source,
  };
  await outboxAdd(event);
  state.localChecked.add(key);
  setResult(`✓ ${guest.name}`, 'បានកត់ត្រាជោគជ័យ', 'green', guest.photo);
  await updatePending();
  syncNow();
}

async function handlePayloadText(text) {
  const parsed = await parsePayload(text);
  if (!parsed) {
    setResult('Unrecognized QR code', 'QR មិនត្រឹមត្រូវ', 'red');
    return;
  }
  const guest = state.guestsById.get(parsed.guestId);
  if (!guest) {
    setResult('Unknown guest — not on roster', 'មិនស្គាល់ — គ្មានក្នុងបញ្ជី', 'red');
    return;
  }
  await checkInGuest(guest, 'qr');
}

function handleManualCode(raw) {
  const code = String(raw || '').trim().toUpperCase().replace(/[\s-]/g, '');
  const guest = state.guestsByCode.get(code);
  if (!guest) {
    setResult(`No guest with code ${code}`, `គ្មានភ្ញៀវកូដ ${code}`, 'red');
    return;
  }
  checkInGuest(guest, 'manual');
}

// ---------- camera ----------
async function startCamera() {
  if (state.scanning) return;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch (err) {
    setResult('Camera unavailable — use fallback code', 'កាមេរ៉ាមិនដំណើរការ — សូមប្រើកូដបម្រុង', 'red');
    return;
  }
  const video = $('#video');
  video.srcObject = state.stream;
  await video.play();
  state.scanning = true;
  $('#toggleCam').textContent = 'Stop camera';
  decodeLoop();
}

function stopCamera() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  state.scanning = false;
  $('#toggleCam').textContent = 'Start camera';
}

function decodeLoop() {
  const video = $('#video');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const tick = () => {
    if (!state.scanning) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA && !state.processing) {
      const w = 480;
      const h = Math.round((video.videoHeight / video.videoWidth) * w) || 360;
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const code = globalThis.jsQR?.(img.data, w, h, { inversionAttempts: 'dontInvert' });
      if (code?.data) onDecoded(code.data);
    }
    state.rafId = requestAnimationFrame(tick);
  };
  state.rafId = requestAnimationFrame(tick);
}

function onDecoded(text) {
  const now = Date.now();
  const same = text === state.lastScan.text && now - state.lastScan.at < RESCAN_SAME_MS;
  if (same || now - state.lastScan.at < SCAN_COOLDOWN_MS) return;
  state.lastScan = { text, at: now };
  state.processing = true;
  handlePayloadText(text).finally(() => {
    setTimeout(() => { state.processing = false; }, 600);
  });
}

// ---------- sync ----------
let syncing = false;
async function syncNow() {
  if (syncing || !navigator.onLine) return;
  const [events, pendingGuests] = await Promise.all([outboxAll(), guestOutboxAll()]);
  if (!events.length && !pendingGuests.length) return;
  syncing = true;
  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        station_id: state.config.station_id,
        staff_id: state.config.staff_id,
        guests: pendingGuests.map((g) => ({
          guest_id: g.guest_id,
          code: g.code,
          name: g.name,
          group_name: g.group_name,
          dietary: g.dietary,
          contact: g.contact,
          id_card: g.id_card,
          photo: g.photo,
        })),
        events: events.map(({ _name, _source, ...rest }) => rest),
      }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (data.results?.length) await outboxDelete(data.results.map((r) => r.event_id));
    if (data.guests?.results?.length) {
      const done = data.guests.results.filter((r) => r.status !== 'invalid').map((r) => r.guest_id);
      await guestOutboxDelete(done);
    }
    await updatePending();
    refreshServerChecked();
  } catch {
    // keep in outbox; retry later
  } finally {
    syncing = false;
  }
}

async function refreshServerChecked() {
  if (!navigator.onLine || !state.slotId) return;
  try {
    const res = await fetch(`/api/checked-in?slot_id=${encodeURIComponent(state.slotId)}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    for (const id of data.guest_ids) {
      const key = slotKey(id, state.slotId);
      if (!state.serverChecked.has(key)) {
        state.serverChecked.add(key);
        state.localChecked.delete(key);
      }
    }
    const base = (await kvGet('base_checked')) || {};
    base[state.slotId] = [...state.serverChecked].map((k) => k.split('|')[0]);
    await kvSet('base_checked', base);
  } catch { /* offline */ }
}

// ---------- screens ----------
function showScanner() {
  $('#setupScreen').classList.add('hidden');
  $('#scanScreen').classList.remove('hidden');
  $('#stationLabel').textContent = `${state.config.station_name} · ${state.config.staff_name}`;
  startCamera();
}

function showSetup(msg, msgKm = '') {
  stopCamera();
  $('#scanScreen').classList.add('hidden');
  $('#setupScreen').classList.remove('hidden');
  $('#setupMsg').innerHTML = msg ? biHtml(msg, msgKm) : '';
}

// ---------- register / walk-in ----------
function setRegMsg(en, km = '') {
  $('#regMsg').innerHTML = biHtml(en, km);
}

async function startRegCamera() {
  if (state.regStream) return;
  try {
    state.regStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'user' } },
      audio: false,
    });
    const video = $('#regVideo');
    video.srcObject = state.regStream;
    await video.play();
  } catch {
    setRegMsg('Camera unavailable — you can register without a photo.', 'កាមេរ៉ាមិនដំណើរការ — អាចចុះឈ្មោះដោយគ្មានរូបថត។');
  }
}

function stopRegCamera() {
  if (state.regStream) state.regStream.getTracks().forEach((t) => t.stop());
  state.regStream = null;
}

function capturePhoto() {
  const video = $('#regVideo');
  if (!video.videoWidth) {
    setRegMsg('Camera is not ready yet.', 'កាមេរ៉ាមិនទាន់រួចរាល់។');
    return;
  }
  const size = 480;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const side = Math.min(vw, vh);
  ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, size, size);
  state.capturedPhoto = canvas.toDataURL('image/jpeg', 0.8);
  const shot = $('#regShot');
  shot.src = state.capturedPhoto;
  shot.classList.remove('hidden');
  $('#retakeBtn').classList.remove('hidden');
  $('#captureBtn').textContent = 'Recapture';
  updateSubmitState();
}

function retakePhoto() {
  state.capturedPhoto = '';
  $('#regShot').classList.add('hidden');
  $('#retakeBtn').classList.add('hidden');
  $('#captureBtn').textContent = 'Capture photo';
  updateSubmitState();
}

function updateSubmitState() {
  $('#submitRegister').disabled = !$('#regName').value.trim();
}

function showRegister() {
  stopCamera();
  $('#scanScreen').classList.add('hidden');
  $('#registerScreen').classList.remove('hidden');
  resetRegisterForm();
  startRegCamera();
  updateSubmitState();
}

function resetRegisterForm() {
  for (const id of ['regName', 'regGroup', 'regIdCard', 'regDietary', 'regContact']) $('#' + id).value = '';
  $('#regCheckin').checked = true;
  state.capturedPhoto = '';
  $('#regShot').classList.add('hidden');
  $('#retakeBtn').classList.add('hidden');
  $('#captureBtn').textContent = 'Capture photo';
  $('#qrCard').classList.add('hidden');
  setRegMsg('');
}

async function submitRegistration() {
  const name = $('#regName').value.trim();
  if (!name) {
    setRegMsg('Please enter a name.', 'សូមបញ្ចូលឈ្មោះ។');
    return;
  }
  $('#submitRegister').disabled = true;
  try {
    const guestId = randomUUID();
    const code = newLocalCode();
    const payload = await qrPayloadFor(guestId);
    const guest = {
      guest_id: guestId,
      name,
      group_name: $('#regGroup').value.trim() || null,
      dietary: $('#regDietary').value.trim() || null,
      contact: $('#regContact').value.trim() || null,
      id_card: $('#regIdCard').value.trim() || null,
      photo: state.capturedPhoto || '',
      code,
      qr_payload: payload,
    };
    state.guestsById.set(guestId, guest);
    state.guestsByCode.set(code, guest);
    await guestOutboxAdd(guest);

    if ($('#regCheckin').checked) await checkInGuest(guest, 'register');

    state.lastRegistered = guest;
    renderQr($('#qrHolder'), payload);
    $('#qrName').textContent = guest.name;
    $('#qrCode').textContent = guest.code;
    $('#qrCard').classList.remove('hidden');
    setRegMsg('Guest added. QR is ready.', 'ភ្ញៀវបានបន្ថែម។ QR រួចរាល់។');
    syncNow();
    updatePending();
  } catch (err) {
    setRegMsg(err.message);
  } finally {
    updateSubmitState();
  }
}

function buildQrSvg(text) {
  if (typeof globalThis.qrcode !== 'function') throw new Error('QR generator not loaded.');
  const qr = globalThis.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag(5, 2);
}

function printBadge(guest) {
  const w = window.open('', '_blank');
  if (!w) {
    setRegMsg('Allow pop-ups to print the badge.', 'សូមអនុញ្ញាត pop-up ដើម្បីបោះពុម្ពប័ណ្ណ។');
    return;
  }
  const svg = buildQrSvg(guest.qr_payload);
  const photo = guest.photo ? `<img class="p" src="${escapeHtml(guest.photo)}" alt="">` : '';
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(guest.name)}</title>
<style>
  @page{size:A6;margin:8mm;}
  body{font-family:system-ui,-apple-system,sans-serif;text-align:center;margin:0;padding:12px;color:#111;}
  .p{width:110px;height:110px;border-radius:50%;object-fit:cover;}
  .n{font-size:22px;font-weight:800;margin:8px 0 2px;}
  .g{color:#555;font-size:13px;margin-bottom:6px;}
  svg{width:220px;height:220px;}
  .c{font-family:ui-monospace,monospace;font-size:22px;letter-spacing:3px;color:#333;margin-top:6px;}
  .t{color:#888;font-size:10px;margin-top:8px;}
</style></head><body>
  ${photo}
  <div class="n">${escapeHtml(guest.name)}</div>
  <div class="g">${escapeHtml(guest.group_name || '')}</div>
  ${svg}
  <div class="c">${escapeHtml(guest.code)}</div>
  <div class="t">FALLBACK CODE · កូដបម្រុង</div>
  <script>window.onload=function(){setTimeout(function(){window.print();},400);};<\/script>
</body></html>`);
  w.document.close();
}

function closeRegister() {
  stopRegCamera();
  state.lastRegistered = null;
  $('#registerScreen').classList.add('hidden');
  $('#scanScreen').classList.remove('hidden');
  $('#stationLabel').textContent = `${state.config.station_name} · ${state.config.staff_name}`;
  startCamera();
}

function showContextNotice() {
  const el = $('#ctxBanner');
  if (!el) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    el.innerHTML =
      '⚠️ ' +
      biHtml(
        'Camera needs HTTPS. Open this page over https:// to scan or take photos. Registration still works (photo optional) and you can enter fallback codes manually.',
        'កាមេរ៉ាត្រូវការ HTTPS។ សូមបើកតាម https:// ដើម្បីស្កេន ឬថតរូប។ ការចុះឈ្មោះនៅតែដំណើរការ (រូបថតស្រេចចិត្ត) និងអាចបញ្ចូលកូដបម្រុងដោយដៃ។',
      );
    el.classList.remove('hidden');
  }
}

// ---------- wiring ----------
async function init() {
  setNet();
  showContextNotice();
  await loadConfig();
  const online = await refreshManifest();
  await updatePending();

  if (state.config.station_id && state.manifest) {
    if (state.slotId) $('#slotSelect').value = state.slotId;
    showScanner();
  } else {
    showSetup(
      online ? '' : 'Offline — showing cached roster if available.',
      online ? '' : 'អត់អ៊ីនធឺណិត — បង្ហាញបញ្ជីឈ្មោះដែលបានរក្សាទុក (បើមាន)។',
    );
  }

  $('#saveSetup').addEventListener('click', async () => {
    const stationId = $('#stationSelect').value;
    const stationName = $('#stationSelect').selectedOptions[0]?.textContent || '—';
    let staffId = $('#staffSelect').value;
    let staffName = $('#staffSelect').selectedOptions[0]?.textContent || '';
    const custom = $('#staffCustom').value.trim();
    if (custom) {
      const found = state.manifest?.staff.find((s) => s.name.toLowerCase() === custom.toLowerCase());
      staffId = found?.staff_id || null;
      staffName = custom;
    }
    state.config = { station_id: stationId, station_name: stationName, staff_id: staffId, staff_name: staffName };
    state.slotId = $('#slotSelect').value;
    await saveConfig();
    showScanner();
  });

  $('#editSetup').addEventListener('click', () => showSetup(''));
  $('#syncManifest').addEventListener('click', async () => {
    const ok = await refreshManifest();
    $('#setupMsg').innerHTML = ok ? biHtml('Guest list refreshed.', 'បញ្ជីឈ្មោះត្រូវបានផ្ទុកឡើងវិញ។') : biHtml('Could not reach server (offline).', 'មិនអាចទាក់ទងម៉ាស៊ីនមេ (អត់អ៊ីនធឺណិត)។');
  });
  $('#slotSelect').addEventListener('change', async (e) => {
    state.slotId = e.target.value;
    await kvSet('slot_id', state.slotId);
    state.serverChecked = new Set();
    const base = (await kvGet('base_checked')) || {};
    (base[state.slotId] || []).forEach((id) => state.serverChecked.add(slotKey(id, state.slotId)));
    refreshServerChecked();
  });

  $('#toggleCam').addEventListener('click', () => (state.scanning ? stopCamera() : startCamera()));
  $('#manualForm').addEventListener('submit', (e) => {
    e.preventDefault();
    handleManualCode($('#manualCode').value);
    $('#manualCode').value = '';
  });

  $('#openRegister').addEventListener('click', showRegister);
  $('#cancelRegister').addEventListener('click', closeRegister);
  $('#captureBtn').addEventListener('click', capturePhoto);
  $('#retakeBtn').addEventListener('click', retakePhoto);
  $('#regName').addEventListener('input', updateSubmitState);
  $('#submitRegister').addEventListener('click', submitRegistration);
  $('#qrCheckin').addEventListener('click', () => {
    if (state.lastRegistered) checkInGuest(state.lastRegistered, 'register');
  });
  $('#qrPrint').addEventListener('click', () => {
    if (!state.lastRegistered) return;
    try {
      printBadge(state.lastRegistered);
    } catch (err) {
      setRegMsg(err.message);
    }
  });
  $('#qrDone').addEventListener('click', closeRegister);

  window.addEventListener('online', () => { setNet(); syncNow(); });
  window.addEventListener('offline', () => setNet());

  setInterval(() => syncNow(), 30000);
  setInterval(() => refreshServerChecked(), 45000);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/sw.js', { updateViaCache: 'none' })
    .then((reg) => reg.update().catch(() => {}))
    .catch(() => {});
}

document.addEventListener('error', (e) => {
  if (e.target?.id === 'resultPhoto') e.target.classList.add('hidden');
}, true);

init();
