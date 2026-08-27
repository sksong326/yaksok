const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const PATIENT_COLORS = ['#2F6F62', '#E8A33D', '#D9645B', '#5B7FBF', '#8B6FB3', '#3F9B7A', '#C77DAA'];

let state = { patients: [], medications: [], logs: {} };
let activeTab = 'all';
let editingMedId = null;

function pad(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function nowHM() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function todayKey() { return dateKey(new Date()); }

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error('API 오류');
  return res.json();
}

async function loadData() {
  state = await api('/api/data');
  render();
}

// ---------------- 렌더링 ----------------
function render() {
  renderTabs();
  const hasPatients = state.patients.length > 0;
  document.getElementById('emptyState').classList.toggle('hidden', hasPatients);
  document.getElementById('mainContent').classList.toggle('hidden', !hasPatients);
  if (!hasPatients) return;
  renderToday();
  renderWeek();
  renderMeds();
  renderDeleteBtn();
}

function renderTabs() {
  const el = document.getElementById('tabs');
  el.innerHTML = '';
  el.appendChild(makeTabChip('전체', 'all', null));
  state.patients.forEach((p) => el.appendChild(makeTabChip(p.name, p.id, p.color)));
  const addBtn = document.createElement('button');
  addBtn.className = 'tab-chip dashed';
  addBtn.textContent = '+ 가족 추가';
  addBtn.onclick = () => openPatientModal();
  el.appendChild(addBtn);
}

function makeTabChip(label, id, color) {
  const btn = document.createElement('button');
  btn.className = 'tab-chip' + (activeTab === id ? ' active' : '');
  if (color) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = color;
    btn.appendChild(dot);
  }
  btn.appendChild(document.createTextNode(label));
  btn.onclick = () => { activeTab = id; render(); };
  return btn;
}

function scheduleToday() {
  const items = [];
  const tKey = todayKey();
  const wd = new Date().getDay();
  state.medications.forEach((med) => {
    if (!med.days.includes(wd)) return;
    const patient = state.patients.find((p) => p.id === med.patientId);
    if (!patient) return;
    med.times.forEach((time) => {
      const key = `${tKey}|${med.id}|${time}`;
      items.push({ key, time, medId: med.id, medName: med.name, dosage: med.dosage, patientId: patient.id, patientName: patient.name, color: patient.color, taken: !!state.logs[key] });
    });
  });
  items.sort((a, b) => timeToMin(a.time) - timeToMin(b.time));
  return items;
}

function renderToday() {
  const list = document.getElementById('todayList');
  const emptyMsg = document.getElementById('todayEmptyMsg');
  const all = scheduleToday();
  const items = activeTab === 'all' ? all : all.filter((i) => i.patientId === activeTab);
  list.innerHTML = '';
  if (items.length === 0) {
    emptyMsg.textContent = (activeTab === 'all' ? '오늘 예정된 약이 없어요.' : '이 가족 구성원은 오늘 예정된 약이 없어요.') + ' 아래에서 약을 등록해보세요.';
    emptyMsg.classList.remove('hidden');
    return;
  }
  emptyMsg.classList.add('hidden');
  items.forEach((item) => list.appendChild(renderTodayItem(item)));
}

function renderTodayItem(item) {
  const li = document.createElement('li');
  li.className = 'today-item';

  const pocket = document.createElement('button');
  pocket.className = 'pocket-btn' + (item.taken ? ' taken' : '');
  pocket.style.background = item.taken ? item.color : 'transparent';
  pocket.style.borderColor = item.taken ? item.color : '';
  pocket.innerHTML = item.taken ? '✓' : '';
  pocket.style.color = '#fff';
  pocket.onclick = () => toggleTaken(item);
  li.appendChild(pocket);

  const main = document.createElement('div');
  main.className = 'today-item-main';
  const titleRow = document.createElement('div');
  titleRow.className = 'today-item-title-row';
  titleRow.innerHTML = `<span class="time-mono">${item.time}</span><span>${escapeHtml(item.medName)}</span>` + (item.dosage ? `<span class="muted-text" style="margin:0">· ${escapeHtml(item.dosage)}</span>` : '');
  main.appendChild(titleRow);
  if (activeTab === 'all') {
    const tag = document.createElement('div');
    tag.className = 'patient-tag';
    tag.innerHTML = `<span class="dot" style="background:${item.color}"></span>${escapeHtml(item.patientName)}`;
    main.appendChild(tag);
  }
  li.appendChild(main);

  const isPast = timeToMin(item.time) < timeToMin(nowHM());
  const status = item.taken ? 'taken' : isPast ? 'overdue' : 'upcoming';
  const badge = document.createElement('span');
  badge.className = 'badge badge-' + status;
  badge.textContent = status === 'taken' ? '완료' : status === 'overdue' ? '놓침' : '예정';
  li.appendChild(badge);

  return li;
}

async function toggleTaken(item) {
  const res = await api('/api/logs/toggle', { method: 'POST', body: JSON.stringify({ date: todayKey(), medId: item.medId, time: item.time }) });
  state.logs[item.key] = res.taken || undefined;
  if (!res.taken) delete state.logs[item.key];
  render();
}

function dayStats(patientId, dateObj) {
  const wd = dateObj.getDay();
  const key = dateKey(dateObj);
  let total = 0, taken = 0;
  state.medications.filter((m) => m.patientId === patientId && m.days.includes(wd)).forEach((m) => {
    m.times.forEach((t) => {
      total += 1;
      if (state.logs[`${key}|${m.id}|${t}`]) taken += 1;
    });
  });
  return { total, taken };
}

function renderWeek() {
  const wrap = document.getElementById('weekList');
  wrap.innerHTML = '';
  const today = new Date();
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); days.push(d); }

  state.patients.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'week-card';
    const head = document.createElement('div');
    head.className = 'week-card-head';
    head.innerHTML = `<span class="dot" style="background:${p.color}"></span>${escapeHtml(p.name)}`;
    card.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'week-grid';
    days.forEach((d) => {
      const stats = dayStats(p.id, d);
      const isToday = dateKey(d) === todayKey();
      const col = document.createElement('div');
      col.className = 'week-day';
      const label = document.createElement('span');
      label.className = 'week-day-label';
      label.textContent = WEEKDAYS[d.getDay()];
      const pocket = document.createElement('span');
      pocket.className = 'week-pocket';
      pocket.title = stats.total ? `${stats.taken}/${stats.total}` : '예정 없음';
      if (stats.total === 0) {
        // 기본 스타일 유지 (예정 없음)
      } else if (stats.taken === stats.total) {
        pocket.style.background = p.color;
        pocket.style.borderColor = p.color;
        pocket.style.borderStyle = 'solid';
      } else if (isToday) {
        pocket.style.borderColor = 'var(--accent)';
        pocket.style.borderStyle = 'solid';
      } else {
        pocket.style.background = 'rgba(217,100,91,0.25)';
        pocket.style.borderColor = 'var(--danger)';
        pocket.style.borderStyle = 'solid';
      }
      col.appendChild(label);
      col.appendChild(pocket);
      grid.appendChild(col);
    });
    card.appendChild(grid);
    wrap.appendChild(card);
  });
}

function renderMeds() {
  const addBtn = document.getElementById('addMedBtn');
  const selectMsg = document.getElementById('medsSelectMsg');
  const list = document.getElementById('medsList');
  list.innerHTML = '';

  if (activeTab === 'all') {
    addBtn.classList.add('hidden');
    selectMsg.classList.remove('hidden');
    return;
  }
  addBtn.classList.remove('hidden');
  selectMsg.classList.add('hidden');

  const meds = state.medications.filter((m) => m.patientId === activeTab);
  if (meds.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted-text';
    p.textContent = '등록된 약이 없어요. "약 추가"로 첫 약속을 만들어보세요.';
    list.appendChild(p);
    return;
  }
  meds.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'med-item';
    const info = document.createElement('div');
    info.innerHTML = `
      <p class="med-item-name">${escapeHtml(m.name)}${m.dosage ? ' · ' + escapeHtml(m.dosage) : ''}</p>
      <p class="med-item-times">${m.times.join(', ')}</p>
      <p class="med-item-days">${m.days.length === 7 ? '매일' : m.days.slice().sort().map((d) => WEEKDAYS[d]).join(' ')}</p>
    `;
    const actions = document.createElement('div');
    actions.className = 'med-item-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'btn-pill btn-small btn-outline';
    editBtn.textContent = '수정';
    editBtn.onclick = () => openMedModal(m);
    const delBtn = document.createElement('button');
    delBtn.className = 'danger-btn';
    delBtn.textContent = '🗑';
    delBtn.onclick = () => removeMed(m.id);
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function renderDeleteBtn() {
  const btn = document.getElementById('deletePatientBtn');
  if (activeTab === 'all') { btn.classList.add('hidden'); return; }
  const p = state.patients.find((x) => x.id === activeTab);
  if (!p) { btn.classList.add('hidden'); return; }
  btn.classList.remove('hidden');
  btn.textContent = `${p.name} 삭제하기`;
  btn.onclick = () => removePatient(p.id);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- 가족(환자) ----------------
function openPatientModal() {
  document.getElementById('patientNameInput').value = '';
  document.getElementById('patientModal').classList.remove('hidden');
}
async function savePatient() {
  const name = document.getElementById('patientNameInput').value.trim();
  if (!name) return;
  const color = PATIENT_COLORS[state.patients.length % PATIENT_COLORS.length];
  const patient = await api('/api/patients', { method: 'POST', body: JSON.stringify({ name, color }) });
  state.patients.push(patient);
  activeTab = patient.id;
  closeModal('patientModal');
  render();
}
async function removePatient(id) {
  if (!confirm('정말 삭제할까요? 등록된 약 정보도 함께 삭제돼요.')) return;
  await api(`/api/patients/${id}`, { method: 'DELETE' });
  state.patients = state.patients.filter((p) => p.id !== id);
  state.medications = state.medications.filter((m) => m.patientId !== id);
  activeTab = 'all';
  render();
}

// ---------------- 약 일정 ----------------
let medTimesDraft = [];
let medDaysDraft = [0, 1, 2, 3, 4, 5, 6];

function openMedModal(med) {
  editingMedId = med ? med.id : null;
  document.getElementById('medModalTitle').textContent = med ? '약 정보 수정' : '약 추가';
  document.getElementById('medNameInput').value = med ? med.name : '';
  document.getElementById('medDosageInput').value = med ? med.dosage : '';
  medTimesDraft = med ? [...med.times] : [];
  medDaysDraft = med ? [...med.days] : [0, 1, 2, 3, 4, 5, 6];
  renderTimeChips();
  renderDayToggles();
  document.getElementById('medModal').classList.remove('hidden');
}
function renderTimeChips() {
  const wrap = document.getElementById('medTimesChips');
  wrap.innerHTML = '';
  medTimesDraft.forEach((t) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${t} <button>✕</button>`;
    chip.querySelector('button').onclick = () => { medTimesDraft = medTimesDraft.filter((x) => x !== t); renderTimeChips(); };
    wrap.appendChild(chip);
  });
}
function renderDayToggles() {
  const wrap = document.getElementById('medDaysRow');
  wrap.innerHTML = '';
  WEEKDAYS.forEach((w, i) => {
    const btn = document.createElement('button');
    btn.className = 'day-toggle' + (medDaysDraft.includes(i) ? ' active' : '');
    btn.textContent = w;
    btn.onclick = () => {
      medDaysDraft = medDaysDraft.includes(i) ? medDaysDraft.filter((x) => x !== i) : [...medDaysDraft, i].sort();
      renderDayToggles();
    };
    wrap.appendChild(btn);
  });
}
async function saveMed() {
  const name = document.getElementById('medNameInput').value.trim();
  const dosage = document.getElementById('medDosageInput').value.trim();
  if (!name || medTimesDraft.length === 0 || medDaysDraft.length === 0) {
    alert('약 이름, 시간, 요일을 모두 입력해주세요.');
    return;
  }
  const payload = { patientId: activeTab, name, dosage, times: medTimesDraft, days: medDaysDraft };
  if (editingMedId) {
    const updated = await api(`/api/medications/${editingMedId}`, { method: 'PUT', body: JSON.stringify(payload) });
    state.medications = state.medications.map((m) => (m.id === editingMedId ? updated : m));
  } else {
    const created = await api('/api/medications', { method: 'POST', body: JSON.stringify(payload) });
    state.medications.push(created);
  }
  closeModal('medModal');
  render();
}
async function removeMed(id) {
  if (!confirm('이 약을 삭제할까요?')) return;
  await api(`/api/medications/${id}`, { method: 'DELETE' });
  state.medications = state.medications.filter((m) => m.id !== id);
  render();
}

function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// ---------------- 푸시 알림 ----------------
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function initPush() {
  const btn = document.getElementById('notifBtn');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    btn.textContent = '이 브라우저는 지원하지 않아요';
    btn.disabled = true;
    return;
  }
  const reg = await navigator.serviceWorker.register('/sw.js');
  const existing = await reg.pushManager.getSubscription();
  if (existing && Notification.permission === 'granted') {
    btn.textContent = '알림 켜짐';
    btn.classList.add('btn-primary');
    btn.classList.remove('btn-outline');
  }
  btn.onclick = async () => {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { alert('알림 권한이 필요해요.'); return; }
      const { publicKey } = await api('/api/vapid-public-key');
      const sub = existing || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      await api('/api/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub, deviceName: navigator.userAgent.slice(0, 40) }) });
      btn.textContent = '알림 켜짐';
      btn.classList.add('btn-primary');
      btn.classList.remove('btn-outline');
    } catch (e) {
      console.error(e);
      alert('알림 설정 중 문제가 생겼어요.');
    }
  };
}

// ---------------- 초기화 ----------------
document.getElementById('emptyAddBtn').onclick = openPatientModal;
document.getElementById('patientSaveBtn').onclick = savePatient;
document.getElementById('addMedBtn').onclick = () => openMedModal(null);
document.getElementById('medTimeAddBtn').onclick = () => {
  const t = document.getElementById('medTimeInput').value;
  if (t && !medTimesDraft.includes(t)) { medTimesDraft.push(t); medTimesDraft.sort(); renderTimeChips(); }
};
document.getElementById('medSaveBtn').onclick = saveMed;
document.querySelectorAll('[data-close-modal]').forEach((btn) => {
  btn.onclick = () => closeModal(btn.getAttribute('data-close-modal'));
});

loadData();
initPush();
setInterval(loadData, 30000); // 30초마다 최신 데이터로 갱신 (다른 기기에서 체크한 것도 반영)
