const $ = (s) => document.querySelector(s);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function bi(en, km) {
  return `${esc(en)}<span class="km">${esc(km)}</span>`;
}

function setNet() {
  const el = $('#netBadge');
  const online = navigator.onLine;
  el.innerHTML = `${online ? 'online' : 'offline'}<span class="km inline">${online ? 'អនឡាញ' : 'អត់អ៊ីនធឺណិត'}</span>`;
  el.className = 'net ' + (online ? 'online' : 'offline');
}

async function loadSlots() {
  const sel = $('#slotSelect');
  if (sel.options.length) return;
  const res = await fetch('/api/slots');
  const { slots } = await res.json();
  sel.innerHTML =
    '<option value="">All meals / អាហារទាំងអស់</option>' +
    slots.map((s) => `<option value="${s.slot_id}">${esc(s.label || s.slot_id)}</option>`).join('');
}

async function load() {
  const slot = $('#slotSelect').value;
  const q = slot ? `?slot_id=${encodeURIComponent(slot)}` : '';
  const res = await fetch('/api/dashboard' + q, { cache: 'no-store' });
  const data = await res.json();

  $('#cards').innerHTML = data.slots
    .map((s) => {
      const pct = data.total_guests ? Math.round((s.checked_in / data.total_guests) * 100) : 0;
      return `<div class="card">
        <h3>${esc(s.label || s.slot_id)}</h3>
        <div class="big">${s.checked_in}<span class="sub"> / ${data.total_guests}</span></div>
        <div class="sub">${pct}% of roster<span class="km inline">នៃបញ្ជី</span></div>
      </div>`;
    })
    .join('');

  const rows = data.slots
    .filter((s) => s.stations.length)
    .map(
      (s) => `<h3 style="margin-top:22px">${esc(s.label || s.slot_id)}</h3>
      <table><thead><tr>
        <th>Station<span class="km inline">ច្រកទ្វារ</span></th>
        <th>Check-ins<span class="km inline">កត់ត្រា</span></th>
      </tr></thead><tbody>
      ${s.stations.map((b) => `<tr><td>${esc(b.name)}</td><td>${b.count}</td></tr>`).join('')}
      </tbody></table>`,
    )
    .join('');
  $('#detail').innerHTML = rows || `<p class="sub">${bi('No check-ins yet.', 'មិនទាន់មានការកត់ត្រា។')}</p>`;
  $('#updated').innerHTML = bi(
    'updated ' + new Date(data.generated_at).toLocaleTimeString(),
    'ធ្វើបច្ចុប្បន្នភាព',
  );
}

async function init() {
  setNet();
  await loadSlots();
  await load();
  $('#refresh').addEventListener('click', load);
  $('#slotSelect').addEventListener('change', () => {
    const slot = $('#slotSelect').value;
    $('#exportLink').href = '/api/export.csv' + (slot ? `?slot_id=${encodeURIComponent(slot)}` : '');
    load();
  });
  window.addEventListener('online', setNet);
  window.addEventListener('offline', setNet);
  setInterval(load, 20000);
}

init();
