const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const PATIENT_COLORS = ['#2F6F62', '#E8A33D', '#D9645B', '#5B7FBF', '#8B6FB3', '#3F9B7A', '#C77DAA'];

// 복약 시점 7종 및 색상 타입 (식전: pre/빨강, 식후: post/파랑, 취침전: bed/초록)
const TIMING_SLOTS = [
  { slot: '아침식전', type: 'pre',  defaultTime: '07:30' },
  { slot: '아침식후', type: 'post', defaultTime: '08:30' },
  { slot: '점심식전', type: 'pre',  defaultTime: '11:30' },
  { slot: '점심식후', type: 'post', defaultTime: '12:30' },
  { slot: '저녁식전', type: 'pre',  defaultTime: '17:30' },
  { slot: '저녁식후', type: 'post', defaultTime: '18:30' },
  { slot: '취침전',   type: 'bed',  defaultTime: '22:00' },
];


let state = { patients: [], medications: [], logs: {}, diets: [], exercises: [], appointments: [] };
let activeTab = 'all';
let editingMedId = null;
let editingDietId = null;
let dietStatusDraft = 'ok';
let bulkDaysDraft = [0, 1, 2, 3, 4, 5, 6];
let bulkItemsDraft = [];

// 병원 일정(캘린더) 상태 변수
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth(); // 0 ~ 11
let selectedCalDate = null; // YYYY-MM-DD
let editingAptId = null;
let aptDoctorsDraft = [];

// 목록 접기/펼치기 상태 (세로 스크롤을 줄이기 위해 기본 접어둠)
let isDietCollapsed = true;
let isMedsCollapsed = true;
let currentBulkSlot = '아침식후';
let currentMedSlot = '아침식후';
let medTimeSlotsDraft = {};


const STATUS_LABEL = { ok: '먹어도 돼요', caution: '주의해서 조금만', avoid: '먹으면 안 돼요' };
const STATUS_ICON = { ok: '✅', caution: '⚠️', avoid: '⛔' };

function pad(n) { return String(n).padStart(2, '0'); }
function dateKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function nowHM() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function todayKey() { return dateKey(new Date()); }

// 복약 시점(식전/식후/취침전) 자동 판별 및 객체 반환
function inferTiming(timeStr, customSlot) {
  if (customSlot) {
    const match = TIMING_SLOTS.find((s) => s.slot === customSlot);
    if (match) return match;
  }
  if (!timeStr) return TIMING_SLOTS[1]; // 기본: 아침식후
  const [h, m] = timeStr.split(':').map(Number);
  const totalMin = (h || 0) * 60 + (m || 0);

  let slotName = '아침식후';
  if (totalMin >= 300 && totalMin < 495) slotName = '아침식전';       // 05:00 ~ 08:15
  else if (totalMin >= 495 && totalMin < 660) slotName = '아침식후';  // 08:15 ~ 11:00
  else if (totalMin >= 660 && totalMin < 735) slotName = '점심식전';  // 11:00 ~ 12:15
  else if (totalMin >= 735 && totalMin < 960) slotName = '점심식후';  // 12:15 ~ 16:00
  else if (totalMin >= 960 && totalMin < 1095) slotName = '저녁식전'; // 16:00 ~ 18:15
  else if (totalMin >= 1095 && totalMin < 1260) slotName = '저녁식후';// 18:15 ~ 21:00
  else slotName = '취침전';                                          // 21:00 ~ 04:59

  return TIMING_SLOTS.find((s) => s.slot === slotName) || TIMING_SLOTS[1];
}


async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error('API 오류');
  return res.json();
}

const STORAGE_BACKUP_KEY = 'yaksok_data_backup_v1';

async function loadData() {
  try {
    state = await api('/api/data');

    // 1) 서버에 데이터가 있으면 브라우저 localStorage에 실시간 백업 보관
    if (state.patients && state.patients.length > 0) {
      try {
        localStorage.setItem(STORAGE_BACKUP_KEY, JSON.stringify(state));
      } catch (e) {
        console.warn('로컬 백업 저장 실패:', e);
      }
    } 
    // 2) 서버가 새로 재배포되어 비어있는데, 브라우저에 저장된 백업이 있다면 즉시 자동 복원!
    else {
      const cached = localStorage.getItem(STORAGE_BACKUP_KEY);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed && Array.isArray(parsed.patients) && parsed.patients.length > 0) {
            console.log('서버 초기화 감지: 로컬에 보관된 소중한 데이터를 서버로 자동 복원합니다...');
            await api('/api/data/restore', {
              method: 'POST',
              body: JSON.stringify(parsed)
            });
            state = parsed;
          }
        } catch (e) {
          console.warn('로컬 백업 복원 중 오류:', e);
        }
      }
    }
  } catch (e) {
    console.error('데이터 불러오기 실패, 로컬 캐시 확인:', e);
    const cached = localStorage.getItem(STORAGE_BACKUP_KEY);
    if (cached) {
      try { state = JSON.parse(cached); } catch (_) {}
    }
  }
  render();
}

let pendingTarget = null;

// ---------------- 렌더링 ----------------
function render() {
  renderTabs();
  const hasPatients = state.patients.length > 0;
  document.getElementById('emptyState').classList.toggle('hidden', hasPatients);
  document.getElementById('mainContent').classList.toggle('hidden', !hasPatients);
  if (!hasPatients) return;
  renderToday();
  renderWeek();
  renderCalendar();
  renderAppointments();
  renderExcelSection();
  renderDiet();
  renderMeds();
  renderExercises();
  renderReminderSettings();
  renderDeleteBtn();

  if (pendingTarget) {
    const targetToExec = pendingTarget;
    setTimeout(() => executeScrollToTarget(targetToExec), 200);
  }
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
      const customSlot = med.timeSlots ? med.timeSlots[time] : null;
      items.push({ key, time, medId: med.id, medName: med.name, dosage: med.dosage, patientId: patient.id, patientName: patient.name, color: patient.color, taken: !!state.logs[key], slot: customSlot });
    });
  });
  items.sort((a, b) => timeToMin(a.time) - timeToMin(b.time));
  return items;
}

function renderToday() {
  const list = document.getElementById('todayList');
  const emptyMsg = document.getElementById('todayEmptyMsg');
  const badge = document.getElementById('todayProgressBadge');
  const all = scheduleToday();
  const items = activeTab === 'all' ? all : all.filter((i) => i.patientId === activeTab);
  list.innerHTML = '';

  const totalCount = items.length;
  const takenCount = items.filter((i) => i.taken).length;
  if (badge) {
    if (totalCount > 0) {
      badge.textContent = `${takenCount}/${totalCount} 완료`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // 엄마아빠를 위한 원클릭 시점별(식전/식후) 일괄 복약 버튼 바 렌더링
  renderQuickBatchBar(items);

  if (items.length === 0) {
    emptyMsg.textContent = (activeTab === 'all' ? '오늘 예정된 약이 없어요.' : '이 가족 구성원은 오늘 예정된 약이 없어요.') + ' 아래에서 약을 등록해보세요.';
    emptyMsg.classList.remove('hidden');
    return;
  }
  emptyMsg.classList.add('hidden');
  items.forEach((item) => list.appendChild(renderTodayItem(item)));
}

// ---------------- 원클릭 시점별(식전/식후) 일괄 복약 바 (아침/점심/저녁 3칸 모바일 최적화) ----------------
function renderQuickBatchBar(items) {
  const wrap = document.getElementById('quickTimingBatchWrap');
  const bar = document.getElementById('quickTimingBatchBar');
  if (!wrap || !bar) return;
  if (!items || items.length === 0) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  bar.innerHTML = '';

  // 시점별로 그룹핑
  const groups = {};
  TIMING_SLOTS.forEach((ts) => { groups[ts.slot] = []; });
  items.forEach((item) => {
    const timing = inferTiming(item.time, item.slot);
    const slotName = timing.slot;
    if (!groups[slotName]) groups[slotName] = [];
    groups[slotName].push(item);
  });

  // 아침, 점심, 저녁 3줄 구조 정의
  const mealSections = [
    {
      meal: '아침',
      slots: [
        { slot: '아침식전', label: '식전완료', type: 'pre' },
        { slot: '아침식후', label: '식후완료', type: 'post' },
      ],
    },
    {
      meal: '점심',
      slots: [
        { slot: '점심식전', label: '식전완료', type: 'pre' },
        { slot: '점심식후', label: '식후완료', type: 'post' },
      ],
    },
    {
      meal: '저녁',
      slots: [
        { slot: '저녁식전', label: '식전완료', type: 'pre' },
        { slot: '저녁식후', label: '식후완료', type: 'post' },
      ],
    },
  ];

  // 취침전 약이 등록되어 있는 경우 취침전 행 추가
  if (groups['취침전'] && groups['취침전'].length > 0) {
    mealSections.push({
      meal: '취침',
      slots: [
        { slot: '취침전', label: '취침전완료', type: 'bed' },
      ],
    });
  }

  mealSections.forEach((section) => {
    const row = document.createElement('div');
    row.className = 'quick-batch-row';

    const label = document.createElement('div');
    label.className = 'quick-batch-meal-badge';
    label.textContent = section.meal;
    row.appendChild(label);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'quick-batch-btn-group' + (section.slots.length === 1 ? ' single' : '');

    section.slots.forEach((s) => {
      const slotItems = groups[s.slot] || [];
      const total = slotItems.length;
      const taken = slotItems.filter((i) => i.taken).length;
      const isAllDone = total > 0 && taken === total;

      const btn = document.createElement('button');
      btn.type = 'button';

      if (total === 0) {
        btn.className = `quick-batch-btn ${s.type} empty`;
        btn.disabled = true;
        btn.innerHTML = `<span>-</span> <span>${s.label.replace('완료', '')} 없음</span>`;
        btn.title = `${section.meal} ${s.label.replace('완료', '')}에 예정된 약이 없습니다`;
      } else {
        btn.className = `quick-batch-btn ${s.type}` + (isAllDone ? ' all-done' : '');
        if (isAllDone) {
          btn.innerHTML = `<span>✓</span> <span>${s.label}</span> <span class="badge-count">${taken}/${total}</span>`;
          btn.title = `클릭하면 ${s.slot} 완료를 취소합니다`;
        } else {
          btn.innerHTML = `<span>👉</span> <span>${s.label}</span> <span class="badge-count">${taken}/${total}</span>`;
          btn.title = `클릭하면 ${s.slot} 약 ${total}개를 한 번에 완료 체크합니다`;
        }
        btn.onclick = () => toggleBatchSlot(s.slot, slotItems, isAllDone);
      }
      btnGroup.appendChild(btn);
    });

    row.appendChild(btnGroup);
    bar.appendChild(row);
  });
}

async function toggleBatchSlot(slotName, slotItems, isAllDone) {
  const targetTaken = !isAllDone;
  const date = todayKey();
  const batchItems = slotItems.map((i) => ({ medId: i.medId, time: i.time }));

  // 낙관적 UI 업데이트: 로컬 state.logs 즉시 반영
  batchItems.forEach((b) => {
    const key = `${date}|${b.medId}|${b.time}`;
    if (targetTaken) state.logs[key] = true;
    else delete state.logs[key];
  });
  render();

  try {
    await api('/api/logs/batch', {
      method: 'POST',
      body: JSON.stringify({ date, items: batchItems, taken: targetTaken })
    });
  } catch (e) {
    console.error('일괄 체크 실패:', e);
    alert('일괄 체크 중 통신 오류가 발생했습니다.');
    loadData();
  }
}

function renderTodayItem(item) {
  const li = document.createElement('li');
  li.className = 'today-item';
  li.id = `today-item-${item.medId}-${(item.time || '').replace(':', '')}`;
  li.setAttribute('data-med-id', item.medId);
  li.setAttribute('data-target-id', `med_${item.medId}_${item.time}`);

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
  const timeText = item.time;
  const timing = inferTiming(timeText, item.slot);
  const timingBadgeHtml = `<span class="timing-badge timing-${timing.type}">${timing.slot}</span>`;
  titleRow.innerHTML = `${timingBadgeHtml}<span class="time-mono">${escapeHtml(timeText)}</span><span>${escapeHtml(item.medName)}</span>` + (item.dosage ? `<span class="muted-text" style="margin:0">· ${escapeHtml(item.dosage)}</span>` : '');
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

// ---------------- 아코디언 (접기/펼치기) 제어 ----------------
function updateCollapsibleStates() {
  const dietBody = document.getElementById('dietCollapseBody');
  const dietArrow = document.getElementById('dietCollapseArrow');
  const dietHeader = document.getElementById('dietHeaderToggle');
  if (dietBody && dietArrow) {
    dietBody.classList.toggle('collapsed', isDietCollapsed);
    dietArrow.textContent = isDietCollapsed ? '▶' : '▼';
    if (dietHeader) dietHeader.classList.toggle('open', !isDietCollapsed);
  }

  const medsBody = document.getElementById('medsCollapseBody');
  const medsArrow = document.getElementById('medsCollapseArrow');
  const medsHeader = document.getElementById('medsHeaderToggle');
  if (medsBody && medsArrow) {
    medsBody.classList.toggle('collapsed', isMedsCollapsed);
    medsArrow.textContent = isMedsCollapsed ? '▶' : '▼';
    if (medsHeader) medsHeader.classList.toggle('open', !isMedsCollapsed);
  }
}

function toggleDietCollapse(forceState) {
  isDietCollapsed = typeof forceState === 'boolean' ? forceState : !isDietCollapsed;
  updateCollapsibleStates();
}

function toggleMedsCollapse(forceState) {
  isMedsCollapsed = typeof forceState === 'boolean' ? forceState : !isMedsCollapsed;
  updateCollapsibleStates();
}


// ---------------- 병원 방문 일정 (캘린더) ----------------
function renderCalendar() {
  const label = document.getElementById('calCurrentMonthLabel');
  const grid = document.getElementById('calendarGrid');
  if (!label || !grid) return;

  label.textContent = `${calYear}년 ${calMonth + 1}월`;
  grid.innerHTML = '';

  const firstDay = new Date(calYear, calMonth, 1).getDay(); // 0(일) ~ 6(토)
  const lastDate = new Date(calYear, calMonth + 1, 0).getDate(); // 이번달 말일
  const prevLastDate = new Date(calYear, calMonth, 0).getDate(); // 지난달 말일

  const tKey = todayKey();
  const allApts = state.appointments || [];
  const apts = activeTab === 'all' ? allApts : allApts.filter((a) => a.patientId === activeTab);

  // 지난달 채우기
  for (let i = firstDay - 1; i >= 0; i--) {
    const dNum = prevLastDate - i;
    const btn = document.createElement('div');
    btn.className = 'cal-day other-month';
    btn.innerHTML = `<span class="cal-day-num">${dNum}</span>`;
    grid.appendChild(btn);
  }

  // 이번달 날짜 채우기
  for (let day = 1; day <= lastDate; day++) {
    const dayDate = new Date(calYear, calMonth, day);
    const dayKey = dateKey(dayDate);
    const dayOfWeek = dayDate.getDay();

    const btn = document.createElement('button');
    btn.type = 'button';
    let cls = 'cal-day';
    if (dayOfWeek === 0) cls += ' sun';
    if (dayOfWeek === 6) cls += ' sat';
    if (dayKey === tKey) cls += ' today';
    if (selectedCalDate === dayKey) cls += ' selected';

    const dayApts = apts.filter((a) => a.date === dayKey);
    if (dayApts.length > 0) cls += ' has-apt';

    btn.className = cls;

    let inner = `<span class="cal-day-num">${day}</span>`;
    if (dayApts.length > 0) {
      inner += `<span class="cal-apt-dot" title="${dayApts.length}건 진료">🏥</span>`;
    }
    btn.innerHTML = inner;

    btn.onclick = () => {
      if (selectedCalDate === dayKey) {
        selectedCalDate = null; // 선택 해제
      } else {
        selectedCalDate = dayKey;
      }
      renderCalendar();
      renderAppointments();
    };

    grid.appendChild(btn);
  }

  // 다음달 채우기 (7열 그리드 맞추기)
  const totalCells = firstDay + lastDate;
  const remaining = (7 - (totalCells % 7)) % 7;
  for (let i = 1; i <= remaining; i++) {
    const btn = document.createElement('div');
    btn.className = 'cal-day other-month';
    btn.innerHTML = `<span class="cal-day-num">${i}</span>`;
    grid.appendChild(btn);
  }
}

function renderAppointments() {
  const list = document.getElementById('aptList');
  const emptyMsg = document.getElementById('aptEmptyMsg');
  const banner = document.getElementById('aptSelectedDateInfo');
  const badge = document.getElementById('aptCountBadge');
  if (!list) return;
  list.innerHTML = '';

  const allApts = state.appointments || [];
  const tabApts = activeTab === 'all' ? allApts : allApts.filter((a) => a.patientId === activeTab);

  if (badge) {
    if (tabApts.length > 0) {
      badge.textContent = `${tabApts.length}건`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // 선택 날짜 배너 표시
  if (selectedCalDate) {
    banner.classList.remove('hidden');
    banner.innerHTML = `
      <span>📅 ${selectedCalDate} 진료 일정 (${itemsCount(tabApts, selectedCalDate)}건)</span>
      <button id="calClearDateBtn" class="btn-pill btn-small btn-outline" type="button" style="padding:2px 8px; font-size:0.75rem;">전체 보기</button>
    `;
    const clearBtn = document.getElementById('calClearDateBtn');
    if (clearBtn) clearBtn.onclick = clearSelectedCalDate;
  } else {
    banner.classList.add('hidden');
  }

  // 날짜 필터링
  let items = selectedCalDate ? tabApts.filter((a) => a.date === selectedCalDate) : [...tabApts];

  // 날짜 오름차순 정렬 (가장 가까운 일정 순)
  items.sort((a, b) => a.date.localeCompare(b.date));

  if (items.length === 0) {
    emptyMsg.classList.remove('hidden');
    emptyMsg.textContent = selectedCalDate
      ? `${selectedCalDate} 에는 등록된 병원 일정이 없어요.`
      : (activeTab === 'all' ? '등록된 병원 진료 일정이 없어요.' : '이 가족 구성원의 병원 진료 일정이 없어요.') + " '+ 병원 일정 추가'로 일정을 등록해보세요.";
    return;
  }
  emptyMsg.classList.add('hidden');

  const todayStr = todayKey();
  items.forEach((apt) => {
    const patient = state.patients.find((p) => p.id === apt.patientId);
    const card = document.createElement('div');
    card.className = 'apt-card';
    card.id = `apt-card-${apt.id}`;
    card.setAttribute('data-apt-id', apt.id);
    card.setAttribute('data-target-id', `apt_${apt.id}`);

    // D-Day 계산
    const diffDays = Math.round((new Date(apt.date + 'T00:00:00') - new Date(todayStr + 'T00:00:00')) / (1000 * 60 * 60 * 24));
    let dDayText = '';
    let dDayClass = 'upcoming';
    if (diffDays === 0) {
      dDayText = '오늘 방문!';
      dDayClass = 'today';
    } else if (diffDays === 1) {
      dDayText = '내일 방문';
      dDayClass = 'today';
    } else if (diffDays > 1) {
      dDayText = `D-${diffDays}`;
      dDayClass = 'upcoming';
    } else {
      dDayText = `방문 완료 (${Math.abs(diffDays)}일 전)`;
      dDayClass = 'past';
    }

    // 진료 및 검사 목록 HTML
    const doctorsHtml = (apt.doctors || []).map((doc) => {
      const isExam = doc.type === 'exam';
      const typeBadge = isExam
        ? `<span class="apt-cat-chip exam">🔬 검사</span>`
        : `<span class="apt-cat-chip clinic">🩺 진료</span>`;
      const cleanName = (doc.name || '').trim();
      let displayName = cleanName;
      if (isExam) {
        if (!displayName.endsWith('검사')) displayName = `${displayName} 검사`;
      } else {
        if (!displayName.endsWith('교수')) displayName = `${displayName} 교수`;
      }

      return `
        <div class="apt-doc-item">
          <div class="apt-doc-main">
            ${typeBadge}
            <span class="apt-doc-time">${doc.time || ''}</span>
            <span class="apt-doc-name">${escapeHtml(displayName)}</span>
            ${doc.dept ? `<span class="apt-doc-dept">· ${escapeHtml(doc.dept)}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');

    card.innerHTML = `
      <div class="apt-card-head">
        <div class="apt-hospital-title">
          <span>🏥</span>
          <span>${escapeHtml(apt.hospitalName)}</span>
          <span class="apt-dday-badge ${dDayClass}">${dDayText}</span>
        </div>
        <div class="med-item-actions">
          <button class="btn-pill btn-small btn-outline apt-notif-btn" type="button" title="이 진료/검사 일정 알림 지금 즉시 발송">📢 알림 발송</button>
          <button class="btn-pill btn-small btn-outline apt-edit-btn" type="button">수정</button>
          <button class="danger-btn apt-del-btn" type="button">🗑</button>
        </div>
      </div>
      <div class="apt-meta-row">
        ${patient ? `<span class="apt-patient-tag"><span class="dot" style="background:${patient.color}"></span>${escapeHtml(patient.name)}</span> · ` : ''}
        <span>📅 ${apt.date} (${WEEKDAYS[new Date(apt.date + 'T00:00:00').getDay()]})</span>
        ${apt.fastingRequired ? `<span class="apt-fasting-tag">⚠️ 금식 확인 필요</span>` : ''}
      </div>

      <div class="apt-doc-list">
        ${doctorsHtml}
      </div>

      <div class="apt-meta-row" style="font-size:0.78rem;">
        ${apt.notifyPrevDay !== false ? `<span>🔔 전날 ${apt.prevDayTime || '21:00'} 알림</span>` : ''}
        ${apt.hoursBefore ? `<span>· ⏰ 진료 ${apt.hoursBefore}시간 전 알림</span>` : ''}
        ${apt.notify30Min !== false ? `<span>· ⏰ 30분 전 추가 알림</span>` : ''}
      </div>
      ${apt.note ? `<div class="apt-note-text">📝 ${escapeHtml(apt.note)}</div>` : ''}
    `;

    const notifBtn = card.querySelector('.apt-notif-btn');
    if (notifBtn) notifBtn.onclick = () => sendAptNotificationNow(apt);
    card.querySelector('.apt-edit-btn').onclick = () => openAptModal(apt);
    card.querySelector('.apt-del-btn').onclick = () => removeApt(apt.id);
    list.appendChild(card);
  });
}

function itemsCount(arr, dateStr) {
  return arr.filter((a) => a.date === dateStr).length;
}

function clearSelectedCalDate() {
  selectedCalDate = null;
  renderCalendar();
  renderAppointments();
}

// ---------------- 병원 일정 모달 ----------------
function openAptModal(apt) {
  editingAptId = apt ? apt.id : null;
  document.getElementById('aptModalTitle').textContent = apt ? '병원 진료 일정 수정' : '병원 진료 일정 등록';

  // 가족 select 옵션
  const pSelect = document.getElementById('aptPatientSelect');
  pSelect.innerHTML = '';
  state.patients.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    pSelect.appendChild(opt);
  });
  if (apt) {
    pSelect.value = apt.patientId;
  } else if (activeTab !== 'all') {
    pSelect.value = activeTab;
  }

  document.getElementById('aptHospitalInput').value = apt ? apt.hospitalName : '';
  document.getElementById('aptDateInput').value = apt ? apt.date : todayKey();
  document.getElementById('aptNotifyPrevDay').checked = apt ? apt.notifyPrevDay !== false : true;
  document.getElementById('aptPrevDayTime').value = apt && apt.prevDayTime ? apt.prevDayTime : '21:00';
  document.getElementById('aptHoursBeforeSelect').value = apt && apt.hoursBefore ? String(apt.hoursBefore) : '3';
  const noti30MinEl = document.getElementById('aptNotify30Min');
  if (noti30MinEl) noti30MinEl.checked = apt ? apt.notify30Min !== false : true;
  document.getElementById('aptFastingCheck').checked = apt ? !!apt.fastingRequired : true;
  document.getElementById('aptNoteInput').value = apt ? (apt.note || '') : '';

  // 진료 및 검사 리스트 세팅 (기존 데이터는 모두 진료로 유지)
  if (apt && Array.isArray(apt.doctors) && apt.doctors.length > 0) {
    aptDoctorsDraft = apt.doctors.map((d) => ({
      id: d.id,
      type: d.type === 'exam' ? 'exam' : 'clinic',
      name: d.name,
      time: d.time || '10:00',
      dept: d.dept || ''
    }));
  } else {
    aptDoctorsDraft = [
      { type: 'clinic', name: '', time: '10:00', dept: '' }
    ];
  }
  renderAptDoctors();

  document.getElementById('aptModal').classList.remove('hidden');
}

function renderAptDoctors() {
  const wrap = document.getElementById('aptDoctorItems');
  wrap.innerHTML = '';
  aptDoctorsDraft.forEach((doc, idx) => {
    if (!doc.type) doc.type = 'clinic';
    const isExam = doc.type === 'exam';

    const cardRow = document.createElement('div');
    cardRow.className = 'apt-doc-edit-card';
    cardRow.style.cssText = 'background: var(--surface-alt); padding: 8px 10px; border-radius: 8px; margin-bottom: 8px; border: 1px solid var(--line);';

    // 카테고리 선택 바 (진료 / 검사) & 삭제 버튼
    const topRow = document.createElement('div');
    topRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;';

    const toggleGroup = document.createElement('div');
    toggleGroup.className = 'apt-type-toggle-group';

    const clinicBtn = document.createElement('button');
    clinicBtn.type = 'button';
    clinicBtn.className = `apt-type-toggle-btn ${!isExam ? 'active clinic' : ''}`;
    clinicBtn.innerHTML = '🩺 진료 (교수)';
    clinicBtn.title = '진료로 선택 시 뒤에 자동으로 교수 호칭이 붙습니다';
    clinicBtn.onclick = () => {
      if (doc.type === 'clinic') return;
      doc.type = 'clinic';
      // 검사 -> 진료 전환 시: '검사' 접미사를 '교수'로 교체하거나 '교수' 추가
      let cur = (doc.name || '').trim();
      if (cur.endsWith('검사')) {
        cur = cur.replace(/\s*검사$/, '').trim();
      }
      if (cur && !cur.endsWith('교수')) {
        cur = `${cur} 교수`;
      }
      doc.name = cur;
      renderAptDoctors();
    };

    const examBtn = document.createElement('button');
    examBtn.type = 'button';
    examBtn.className = `apt-type-toggle-btn ${isExam ? 'active exam' : ''}`;
    examBtn.innerHTML = '🔬 검사';
    examBtn.title = '검사로 선택 시 뒤에 자동으로 검사 호칭이 붙습니다';
    examBtn.onclick = () => {
      if (doc.type === 'exam') return;
      doc.type = 'exam';
      // 진료 -> 검사 전환 시: '교수' 접미사를 '검사'로 교체하거나 '검사' 추가
      let cur = (doc.name || '').trim();
      if (cur.endsWith('교수')) {
        cur = cur.replace(/\s*교수$/, '').trim();
      }
      if (cur && !cur.endsWith('검사')) {
        cur = `${cur} 검사`;
      }
      doc.name = cur;
      renderAptDoctors();
    };

    toggleGroup.appendChild(clinicBtn);
    toggleGroup.appendChild(examBtn);
    topRow.appendChild(toggleGroup);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'bulk-item-remove';
    removeBtn.textContent = '✕ 삭제';
    removeBtn.style.cssText = 'font-size: 0.75rem; color: var(--danger); background: none; border: none; cursor: pointer; padding: 2px 6px;';
    removeBtn.onclick = () => {
      if (aptDoctorsDraft.length <= 1) {
        alert('진료 및 검사 일정은 최소 1개 이상 입력해야 합니다.');
        return;
      }
      aptDoctorsDraft.splice(idx, 1);
      renderAptDoctors();
    };
    topRow.appendChild(removeBtn);

    cardRow.appendChild(topRow);

    // 인풋 행 (이름, 시간, 장소)
    const inputsRow = document.createElement('div');
    inputsRow.style.cssText = 'display: flex; gap: 6px; align-items: center;';

    const nameInput = document.createElement('input');
    nameInput.className = 'field-input';
    nameInput.placeholder = isExam ? '검사명 (예: CT, 심초음파)' : '의사/교수명 (예: 하태용 교수)';
    nameInput.value = doc.name;
    nameInput.style.cssText = 'flex: 2.2; margin-top: 0; background: var(--surface);';
    nameInput.oninput = (e) => { aptDoctorsDraft[idx].name = e.target.value; };

    const timeInput = document.createElement('input');
    timeInput.type = 'time';
    timeInput.className = 'field-input time-input';
    timeInput.value = doc.time || '10:00';
    timeInput.style.cssText = 'flex: 1.3; margin-top: 0; background: var(--surface);';
    timeInput.oninput = (e) => { aptDoctorsDraft[idx].time = e.target.value; };

    const deptInput = document.createElement('input');
    deptInput.className = 'field-input';
    deptInput.placeholder = isExam ? '검사실/장소' : '진료과/장소';
    deptInput.value = doc.dept || '';
    deptInput.style.cssText = 'flex: 2; margin-top: 0; background: var(--surface);';
    deptInput.oninput = (e) => { aptDoctorsDraft[idx].dept = e.target.value; };

    inputsRow.appendChild(nameInput);
    inputsRow.appendChild(timeInput);
    inputsRow.appendChild(deptInput);

    cardRow.appendChild(inputsRow);
    wrap.appendChild(cardRow);
  });
}

async function saveApt() {
  const patientId = document.getElementById('aptPatientSelect').value;
  const hospitalName = document.getElementById('aptHospitalInput').value.trim();
  const date = document.getElementById('aptDateInput').value;
  const notifyPrevDay = document.getElementById('aptNotifyPrevDay').checked;
  const prevDayTime = document.getElementById('aptPrevDayTime').value || '21:00';
  const hoursBefore = Number(document.getElementById('aptHoursBeforeSelect').value || 3);
  const noti30MinEl = document.getElementById('aptNotify30Min');
  const notify30Min = noti30MinEl ? noti30MinEl.checked : true;
  const fastingRequired = document.getElementById('aptFastingCheck').checked;
  const note = document.getElementById('aptNoteInput').value.trim();

  const validDoctors = aptDoctorsDraft.filter((d) => d.name.trim()).map((d) => {
    const isExam = d.type === 'exam';
    let name = d.name.trim();
    if (isExam) {
      if (name.endsWith('교수')) name = name.replace(/\s*교수$/, '').trim();
      if (!name.endsWith('검사')) name = `${name} 검사`;
    } else {
      if (name.endsWith('검사')) name = name.replace(/\s*검사$/, '').trim();
      if (!name.endsWith('교수')) name = `${name} 교수`;
    }
    return {
      ...d,
      type: isExam ? 'exam' : 'clinic',
      name
    };
  });

  if (!patientId || !hospitalName || !date || validDoctors.length === 0) {
    alert('병원 이름, 날짜, 그리고 최소 1개 이상의 진료/검사 일정을 입력해주세요.');
    return;
  }

  const payload = {
    patientId,
    hospitalName,
    date,
    doctors: validDoctors,
    notifyPrevDay,
    prevDayTime,
    hoursBefore,
    notify30Min,
    fastingRequired,
    note
  };

  if (editingAptId) {
    const updated = await api(`/api/appointments/${editingAptId}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    state.appointments = (state.appointments || []).map((a) => (a.id === editingAptId ? updated : a));
  } else {
    const created = await api('/api/appointments', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (!state.appointments) state.appointments = [];
    state.appointments.push(created);
  }

  closeModal('aptModal');
  renderCalendar();
  renderAppointments();
}

async function sendAptNotificationNow(apt) {
  const patient = state.patients.find((p) => p.id === apt.patientId);
  const patientName = patient ? patient.name : '가족';
  const docSummary = (apt.doctors || []).map((d) => {
    const isExam = d.type === 'exam';
    const name = (d.name || '').trim();
    const formattedName = isExam
      ? (name.endsWith('검사') ? name : `${name} 검사`)
      : (name.endsWith('교수') ? name : `${name} 교수`);
    return `${isExam ? '[검사]' : '[진료]'}${formattedName}${d.dept ? '·' + d.dept : ''}(${d.time})`;
  }).join(', ');
  const fasting = apt.fastingRequired ? ' ⚠️ 금식 여부를 꼭 확인하세요!' : '';
  const note = apt.note ? ` (${apt.note})` : '';

  const confirmMsg = `[${apt.hospitalName}] 진료/검사 일정을 지금 등록된 모든 기기에 알림으로 발송할까요?\n\n일정: ${docSummary}`;
  if (!confirm(confirmMsg)) return;

  try {
    const res = await api('/api/send-custom-push', {
      method: 'POST',
      body: JSON.stringify({
        title: `[병원 안내] ${patientName}님 ${apt.hospitalName} 진료/검사`,
        body: `${patientName}님 ${apt.hospitalName} 진료/검사 일정: ${docSummary}.${fasting}${note}`,
        target: `apt_${apt.id}`,
        url: `/?target=apt_${apt.id}`
      })
    });
    alert(`📢 병원 알림을 성공적으로 발송했습니다! (수신 기기: ${res.sentTo || 0}대)`);
  } catch (err) {
    alert('알림 발송 중 오류가 발생했습니다: ' + err.message);
  }
}

async function removeApt(id) {
  if (!confirm('이 병원 일정을 삭제할까요?')) return;
  await api(`/api/appointments/${id}`, { method: 'DELETE' });
  state.appointments = (state.appointments || []).filter((a) => a.id !== id);
  render();
}


// ---------------- 식단(음식) ----------------
function renderDiet() {
  const askBox = document.getElementById('dietAskBox');
  const askMsg = document.getElementById('dietSelectMsg');
  const addBtn = document.getElementById('addDietBtn');
  const listMsg = document.getElementById('dietListSelectMsg');
  const list = document.getElementById('dietList');
  const countBadge = document.getElementById('dietCountBadge');

  if (countBadge) {
    countBadge.classList.toggle('hidden', activeTab === 'all');
    countBadge.textContent = state.diets.filter((d) => d.patientId === activeTab).length + '건';
  }
  updateCollapsibleStates();

  if (activeTab === 'all') {
    askBox.classList.add('hidden');
    askMsg.classList.remove('hidden');
    addBtn.classList.add('hidden');
    listMsg.classList.remove('hidden');
    list.innerHTML = '';
    return;
  }
  askBox.classList.remove('hidden');
  askMsg.classList.add('hidden');
  addBtn.classList.remove('hidden');
  listMsg.classList.add('hidden');

  document.getElementById('dietAskResult').classList.add('hidden');
  document.getElementById('dietAskInput').value = '';

  const items = state.diets.filter((d) => d.patientId === activeTab);
  list.innerHTML = '';
  if (items.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted-text';
    p.textContent = '등록된 음식이 없어요. "음식 추가"로 먹어도 되는 것/안 되는 것을 등록해두세요.';
    list.appendChild(p);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'med-item';
    const info = document.createElement('div');
    info.className = 'diet-item-row';
    info.innerHTML = `
      <span class="diet-status-dot" style="background:${statusColor(item.status)}"></span>
      <div>
        <p class="med-item-name">${escapeHtml(item.name)} <span class="diet-answer-status ${item.status}" style="margin-left:6px">${STATUS_LABEL[item.status]}</span></p>
        ${item.note ? `<p class="med-item-days">${escapeHtml(item.note)}</p>` : ''}
      </div>
    `;
    const actions = document.createElement('div');
    actions.className = 'med-item-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'btn-pill btn-small btn-outline';
    editBtn.textContent = '수정';
    editBtn.onclick = () => openDietModal(item);
    const delBtn = document.createElement('button');
    delBtn.className = 'danger-btn';
    delBtn.textContent = '🗑';
    delBtn.onclick = () => removeDiet(item.id);
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function statusColor(status) {
  return status === 'ok' ? 'var(--primary)' : status === 'caution' ? 'var(--accent)' : 'var(--danger)';
}

function askDiet() {
  const q = document.getElementById('dietAskInput').value.trim();
  const resultBox = document.getElementById('dietAskResult');
  if (!q) return;
  const items = state.diets.filter((d) => d.patientId === activeTab);
  const norm = (s) => s.replace(/\s/g, '').toLowerCase();
  const nq = norm(q);
  const matches = items.filter((d) => {
    const nn = norm(d.name);
    return nn.includes(nq) || nq.includes(nn);
  });

  resultBox.classList.remove('hidden');
  if (matches.length === 0) {
    resultBox.innerHTML = `
      <div class="diet-answer-item">
        <span class="diet-answer-icon">🤔</span>
        <div class="diet-answer-body">
          <p class="diet-answer-name">"${escapeHtml(q)}"에 대한 정보가 아직 없어요</p>
          <p class="diet-answer-note">아래 "식단 목록 관리"에서 등록해두시면 다음부턴 바로 답해드려요. 확실하지 않으면 담당 의사·약사님께 확인해보세요.</p>
        </div>
      </div>`;
    return;
  }
  resultBox.innerHTML = matches.map((m) => `
    <div class="diet-answer-item">
      <span class="diet-answer-icon">${STATUS_ICON[m.status]}</span>
      <div class="diet-answer-body">
        <p class="diet-answer-name">${escapeHtml(m.name)}</p>
        <p class="diet-answer-status ${m.status}">${STATUS_LABEL[m.status]}</p>
        ${m.note ? `<p class="diet-answer-note">${escapeHtml(m.note)}</p>` : ''}
      </div>
    </div>
  `).join('');
}

function openDietModal(item) {
  editingDietId = item ? item.id : null;
  document.getElementById('dietModalTitle').textContent = item ? '음식 정보 수정' : '음식 추가';
  document.getElementById('dietNameInput').value = item ? item.name : '';
  document.getElementById('dietNoteInput').value = item ? item.note : '';
  dietStatusDraft = item ? item.status : 'ok';
  renderDietStatusToggles();
  document.getElementById('dietModal').classList.remove('hidden');
}
function renderDietStatusToggles() {
  const wrap = document.getElementById('dietStatusRow');
  wrap.innerHTML = '';
  ['ok', 'caution', 'avoid'].forEach((s) => {
    const btn = document.createElement('button');
    btn.className = 'status-toggle' + (dietStatusDraft === s ? ` active-${s}` : '');
    btn.textContent = `${STATUS_ICON[s]} ${STATUS_LABEL[s]}`;
    btn.onclick = () => { dietStatusDraft = s; renderDietStatusToggles(); };
    wrap.appendChild(btn);
  });
}
async function saveDiet() {
  const name = document.getElementById('dietNameInput').value.trim();
  const note = document.getElementById('dietNoteInput').value.trim();
  if (!name) { alert('음식 이름을 입력해주세요.'); return; }
  const payload = { patientId: activeTab, name, status: dietStatusDraft, note };
  if (editingDietId) {
    const updated = await api(`/api/diets/${editingDietId}`, { method: 'PUT', body: JSON.stringify(payload) });
    state.diets = state.diets.map((d) => (d.id === editingDietId ? updated : d));
  } else {
    const created = await api('/api/diets', { method: 'POST', body: JSON.stringify(payload) });
    state.diets.push(created);
  }
  isDietCollapsed = false;
  closeModal('dietModal');
  render();
}
async function removeDiet(id) {
  if (!confirm('이 음식 정보를 삭제할까요?')) return;
  await api(`/api/diets/${id}`, { method: 'DELETE' });
  state.diets = state.diets.filter((d) => d.id !== id);
  render();
}

// ---------------- 엑셀로 한 번에 등록 ----------------
let excelParsed = null; // 서버가 파싱해준 결과
let excelIncluded = { medications: [], diets: [] }; // 체크박스 상태

function renderExcelSection() {
  const box = document.getElementById('excelBox');
  const msg = document.getElementById('excelSelectMsg');
  if (activeTab === 'all') {
    box.classList.add('hidden');
    msg.classList.remove('hidden');
    return;
  }
  box.classList.remove('hidden');
  msg.classList.add('hidden');
}

document.getElementById('excelPickBtn').onclick = () => document.getElementById('excelFileInput').click();
document.getElementById('excelFileInput').onchange = (e) => {
  const file = e.target.files[0];
  document.getElementById('excelFileName').textContent = file ? file.name : '';
  document.getElementById('excelUploadBtn').disabled = !file;
  document.getElementById('excelPreview').classList.add('hidden');
};

document.getElementById('excelUploadBtn').onclick = async () => {
  const file = document.getElementById('excelFileInput').files[0];
  if (!file) return;
  const btn = document.getElementById('excelUploadBtn');
  btn.disabled = true;
  btn.textContent = '읽는 중...';
  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/parse-excel', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) { alert(data.error || '엑셀을 읽는 중 문제가 생겼어요.'); return; }
    excelParsed = data;
    excelIncluded.medications = data.medications.map((r) => r.valid);
    excelIncluded.diets = data.diets.map((r) => r.valid);
    renderExcelPreview();
  } catch (e) {
    alert('업로드 중 문제가 생겼어요. 인터넷 연결을 확인해주세요.');
  } finally {
    btn.disabled = false;
    btn.textContent = '업로드해서 미리보기';
  }
};

function renderExcelPreview() {
  const wrap = document.getElementById('excelPreview');
  wrap.classList.remove('hidden');
  wrap.innerHTML = '';

  if (!excelParsed || (excelParsed.medications.length === 0 && excelParsed.diets.length === 0)) {
    wrap.innerHTML = '<p class="excel-empty-note">읽을 수 있는 내용이 없었어요. 템플릿 형식과 같은지 확인해주세요.</p>';
    return;
  }

  if (excelParsed.medications.length > 0) {
    const group = document.createElement('div');
    group.className = 'excel-preview-group';
    group.innerHTML = `<p class="excel-preview-title">복약 일정 ${excelParsed.medications.length}개</p>`;
    excelParsed.medications.forEach((r, idx) => group.appendChild(renderExcelMedRow(r, idx)));
    wrap.appendChild(group);
  }
  if (excelParsed.diets.length > 0) {
    const group = document.createElement('div');
    group.className = 'excel-preview-group';
    group.innerHTML = `<p class="excel-preview-title">식단 목록 ${excelParsed.diets.length}개</p>`;
    excelParsed.diets.forEach((r, idx) => group.appendChild(renderExcelDietRow(r, idx)));
    wrap.appendChild(group);
  }

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn-pill btn-primary btn-block mt';
  confirmBtn.textContent = '체크된 항목 등록하기';
  confirmBtn.onclick = confirmExcelImport;
  wrap.appendChild(confirmBtn);
}

function renderExcelMedRow(r, idx) {
  const row = document.createElement('label');
  row.className = 'excel-row' + (r.valid ? '' : ' invalid');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = excelIncluded.medications[idx];
  cb.disabled = !r.valid;
  cb.onchange = (e) => { excelIncluded.medications[idx] = e.target.checked; };
  const text = document.createElement('div');
  text.className = 'excel-row-text';
  text.innerHTML = r.valid
    ? `<b>${escapeHtml((r.timesDisplay || r.times).join(', '))}</b> · ${escapeHtml(r.name)}${r.dosage ? ' · ' + escapeHtml(r.dosage) : ''} · ${r.days.length === 7 ? '매일' : r.days.map((d) => WEEKDAYS[d]).join(' ')}`
    : `${escapeHtml(r.name || '(이름 없음)')} <span class="excel-row-warning">${r.row}행: 시간 또는 이름을 확인해주세요 (입력값: "${escapeHtml(r.timeRaw)}")</span>`;
  row.appendChild(cb);
  row.appendChild(text);
  return row;
}

function renderExcelDietRow(r, idx) {
  const row = document.createElement('label');
  row.className = 'excel-row' + (r.valid ? '' : ' invalid');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = excelIncluded.diets[idx];
  cb.disabled = !r.valid;
  cb.onchange = (e) => { excelIncluded.diets[idx] = e.target.checked; };
  const text = document.createElement('div');
  text.className = 'excel-row-text';
  text.innerHTML = r.valid
    ? `${STATUS_ICON[r.status]} <b>${escapeHtml(r.name)}</b> · ${STATUS_LABEL[r.status]}${r.note ? ' · ' + escapeHtml(r.note) : ''}`
    : `${escapeHtml(r.name || '(이름 없음)')} <span class="excel-row-warning">${r.row}행: 상태(허용/주의/금지)를 확인해주세요 (입력값: "${escapeHtml(r.statusRaw)}")</span>`;
  row.appendChild(cb);
  row.appendChild(text);
  return row;
}

async function confirmExcelImport() {
  const meds = excelParsed.medications.filter((r, idx) => r.valid && excelIncluded.medications[idx]);
  const diets = excelParsed.diets.filter((r, idx) => r.valid && excelIncluded.diets[idx]);
  if (meds.length === 0 && diets.length === 0) { alert('등록할 항목을 선택해주세요.'); return; }

  let dup = 0;
  for (const m of meds) {
    const created = await api('/api/medications', { method: 'POST', body: JSON.stringify({ patientId: activeTab, name: m.name, dosage: m.dosage, times: m.times, days: m.days }) });
    if (created.duplicate) { dup += 1; } else { state.medications.push(created); }
  }
  for (const d of diets) {
    const created = await api('/api/diets', { method: 'POST', body: JSON.stringify({ patientId: activeTab, name: d.name, status: d.status, note: d.note }) });
    if (created.duplicate) { dup += 1; } else { state.diets.push(created); }
  }

  excelParsed = null;
  document.getElementById('excelPreview').classList.add('hidden');
  document.getElementById('excelFileInput').value = '';
  document.getElementById('excelFileName').textContent = '';
  document.getElementById('excelUploadBtn').disabled = true;
  const newCount = meds.length + diets.length - dup;
  alert(dup > 0 ? `${newCount}개 항목을 등록했어요. (이미 등록된 ${dup}개는 중복이라 건너뛰었어요)` : `${newCount}개 항목을 등록했어요.`);
  render();
}

// ---------------- 시간대별 여러 약 한번에 등록 ----------------

function renderBulkTimingPresets() {
  const container = document.getElementById('bulkTimingPresets');
  if (!container) return;
  container.innerHTML = '';
  TIMING_SLOTS.forEach((ts) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `timing-preset-btn ${ts.type}` + (currentBulkSlot === ts.slot ? ' active' : '');
    btn.textContent = ts.slot;
    btn.onclick = () => {
      currentBulkSlot = ts.slot;
      document.getElementById('bulkTimeInput').value = ts.defaultTime;
      renderBulkTimingPresets();
    };
    container.appendChild(btn);
  });
}

function openBulkMedModal() {
  currentBulkSlot = '아침식후';
  document.getElementById('bulkTimeInput').value = '08:30';
  renderBulkTimingPresets();
  bulkDaysDraft = [0, 1, 2, 3, 4, 5, 6];
  bulkItemsDraft = [{ name: '', dosage: '' }, { name: '', dosage: '' }];
  renderBulkDays();
  renderBulkItems();
  document.getElementById('bulkMedModal').classList.remove('hidden');
}
function renderBulkDays() {
  const wrap = document.getElementById('bulkDaysRow');
  wrap.innerHTML = '';
  WEEKDAYS.forEach((w, i) => {
    const btn = document.createElement('button');
    btn.className = 'day-toggle' + (bulkDaysDraft.includes(i) ? ' active' : '');
    btn.textContent = w;
    btn.onclick = () => {
      bulkDaysDraft = bulkDaysDraft.includes(i) ? bulkDaysDraft.filter((x) => x !== i) : [...bulkDaysDraft, i].sort();
      renderBulkDays();
    };
    wrap.appendChild(btn);
  });
}
function renderBulkItems() {
  const wrap = document.getElementById('bulkItemsList');
  wrap.innerHTML = '';
  bulkItemsDraft.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'bulk-item-row';
    const nameInput = document.createElement('input');
    nameInput.className = 'field-input bulk-item-name';
    nameInput.placeholder = '약 이름 (예: 혈압약)';
    nameInput.value = item.name;
    nameInput.oninput = (e) => { bulkItemsDraft[idx].name = e.target.value; };
    const dosageInput = document.createElement('input');
    dosageInput.className = 'field-input bulk-item-dosage';
    dosageInput.placeholder = '수량 (예: 1정)';
    dosageInput.value = item.dosage;
    dosageInput.oninput = (e) => { bulkItemsDraft[idx].dosage = e.target.value; };
    const removeBtn = document.createElement('button');
    removeBtn.className = 'bulk-item-remove';
    removeBtn.textContent = '✕';
    removeBtn.onclick = () => { bulkItemsDraft.splice(idx, 1); renderBulkItems(); };
    row.appendChild(nameInput);
    row.appendChild(dosageInput);
    row.appendChild(removeBtn);
    wrap.appendChild(row);
  });
}
async function saveBulkMed() {
  const time = document.getElementById('bulkTimeInput').value;
  const items = bulkItemsDraft.filter((it) => it.name.trim());
  if (!time || items.length === 0 || bulkDaysDraft.length === 0) {
    alert('시간, 요일, 그리고 약 이름을 최소 1개는 입력해주세요.');
    return;
  }
  const res = await api('/api/medications/bulk', { method: 'POST', body: JSON.stringify({ patientId: activeTab, time, days: bulkDaysDraft, items }) });
  state.medications.push(...res.created);
  if (res.skipped > 0) alert(`${res.created.length}개 등록, 이미 등록된 ${res.skipped}개는 건너뛰었어요.`);
  isMedsCollapsed = false;
  closeModal('bulkMedModal');
  render();
}

function renderMeds() {
  const addBtn = document.getElementById('addMedBtn');
  const selectMsg = document.getElementById('medsSelectMsg');
  const list = document.getElementById('medsList');
  const countBadge = document.getElementById('medsCountBadge');
  list.innerHTML = '';

  if (countBadge) {
    countBadge.classList.toggle('hidden', activeTab === 'all');
    countBadge.textContent = state.medications.filter((m) => m.patientId === activeTab).length + '건';
  }
  updateCollapsibleStates();

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
    row.id = `med-item-${m.id}`;
    row.setAttribute('data-med-id', m.id);
    row.setAttribute('data-target-id', `med_${m.id}`);
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

// ---------------- 운동 알림 (권고 - 반복 없음) ----------------
let editingExerciseId = null;
let exerciseTimesDraft = [];
let exerciseDaysDraft = [0, 1, 2, 3, 4, 5, 6];

function renderExercises() {
  const addBtn = document.getElementById('addExerciseBtn');
  const selectMsg = document.getElementById('exerciseSelectMsg');
  const hint = document.getElementById('exerciseHint');
  const list = document.getElementById('exerciseList');
  list.innerHTML = '';

  if (activeTab === 'all') {
    addBtn.classList.add('hidden');
    selectMsg.classList.remove('hidden');
    hint.classList.add('hidden');
    return;
  }
  addBtn.classList.remove('hidden');
  selectMsg.classList.add('hidden');
  hint.classList.remove('hidden');

  const items = state.exercises.filter((e) => e.patientId === activeTab);
  if (items.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted-text';
    p.textContent = '등록된 운동 알림이 없어요.';
    list.appendChild(p);
    return;
  }
  items.forEach((ex) => {
    const row = document.createElement('div');
    row.className = 'med-item';
    row.id = `ex-item-${ex.id}`;
    row.setAttribute('data-ex-id', ex.id);
    row.setAttribute('data-target-id', `ex_${ex.id}`);
    const info = document.createElement('div');
    info.innerHTML = `
      <p class="med-item-name">🏃 ${escapeHtml(ex.name)}</p>
      <p class="med-item-times">${ex.times.join(', ')}</p>
      <p class="med-item-days">${ex.days.length === 7 ? '매일' : ex.days.slice().sort().map((d) => WEEKDAYS[d]).join(' ')}</p>
    `;
    const actions = document.createElement('div');
    actions.className = 'med-item-actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'btn-pill btn-small btn-outline';
    editBtn.textContent = '수정';
    editBtn.onclick = () => openExerciseModal(ex);
    const delBtn = document.createElement('button');
    delBtn.className = 'danger-btn';
    delBtn.textContent = '🗑';
    delBtn.onclick = () => removeExercise(ex.id);
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function openExerciseModal(ex) {
  editingExerciseId = ex ? ex.id : null;
  document.getElementById('exerciseModalTitle').textContent = ex ? '운동 정보 수정' : '운동 추가';
  document.getElementById('exerciseNameInput').value = ex ? ex.name : '';
  exerciseTimesDraft = ex ? [...ex.times] : [];
  exerciseDaysDraft = ex ? [...ex.days] : [0, 1, 2, 3, 4, 5, 6];
  renderExerciseTimeChips();
  renderExerciseDayToggles();
  document.getElementById('exerciseModal').classList.remove('hidden');
}
function renderExerciseTimeChips() {
  const wrap = document.getElementById('exerciseTimesChips');
  wrap.innerHTML = '';
  exerciseTimesDraft.forEach((t) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escapeHtml(t)} <button>✕</button>`;
    chip.querySelector('button').onclick = () => { exerciseTimesDraft = exerciseTimesDraft.filter((x) => x !== t); renderExerciseTimeChips(); };
    wrap.appendChild(chip);
  });
}
function renderExerciseDayToggles() {
  const wrap = document.getElementById('exerciseDaysRow');
  wrap.innerHTML = '';
  WEEKDAYS.forEach((w, i) => {
    const btn = document.createElement('button');
    btn.className = 'day-toggle' + (exerciseDaysDraft.includes(i) ? ' active' : '');
    btn.textContent = w;
    btn.onclick = () => {
      exerciseDaysDraft = exerciseDaysDraft.includes(i) ? exerciseDaysDraft.filter((x) => x !== i) : [...exerciseDaysDraft, i].sort();
      renderExerciseDayToggles();
    };
    wrap.appendChild(btn);
  });
}
async function saveExercise() {
  const name = document.getElementById('exerciseNameInput').value.trim();
  if (!name || exerciseTimesDraft.length === 0 || exerciseDaysDraft.length === 0) {
    alert('운동 이름, 시간, 요일을 모두 입력해주세요.');
    return;
  }
  const payload = { patientId: activeTab, name, times: exerciseTimesDraft, days: exerciseDaysDraft };
  if (editingExerciseId) {
    const updated = await api(`/api/exercises/${editingExerciseId}`, { method: 'PUT', body: JSON.stringify(payload) });
    state.exercises = state.exercises.map((e) => (e.id === editingExerciseId ? updated : e));
  } else {
    const created = await api('/api/exercises', { method: 'POST', body: JSON.stringify(payload) });
    state.exercises.push(created);
  }
  closeModal('exerciseModal');
  render();
}
async function removeExercise(id) {
  if (!confirm('이 운동 알림을 삭제할까요?')) return;
  await api(`/api/exercises/${id}`, { method: 'DELETE' });
  state.exercises = state.exercises.filter((e) => e.id !== id);
  render();
}

// ---------------- 재알림 간격 설정 ----------------
function renderReminderSettings() {
  const box = document.getElementById('reminderBox');
  const msg = document.getElementById('reminderSelectMsg');
  if (activeTab === 'all') {
    box.classList.add('hidden');
    msg.classList.remove('hidden');
    return;
  }
  box.classList.remove('hidden');
  msg.classList.add('hidden');
  const patient = state.patients.find((p) => p.id === activeTab);
  document.getElementById('reminderIntervalInput').value = (patient && patient.reminderIntervalMin) || 15;
}
async function saveReminderInterval() {
  const val = Number(document.getElementById('reminderIntervalInput').value) || 15;
  const updated = await api(`/api/patients/${activeTab}`, { method: 'PUT', body: JSON.stringify({ reminderIntervalMin: val }) });
  state.patients = state.patients.map((p) => (p.id === activeTab ? updated : p));
  alert('재알림 간격을 저장했어요.');
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


function renderMedTimingPresets() {
  const container = document.getElementById('medTimingPresets');
  if (!container) return;
  container.innerHTML = '';
  TIMING_SLOTS.forEach((ts) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `timing-preset-btn ${ts.type}` + (currentMedSlot === ts.slot ? ' active' : '');
    btn.textContent = ts.slot;
    btn.onclick = () => {
      currentMedSlot = ts.slot;
      document.getElementById('medTimeInput').value = ts.defaultTime;
      renderMedTimingPresets();
    };
    container.appendChild(btn);
  });
}

function openMedModal(med) {
  editingMedId = med ? med.id : null;
  document.getElementById('medModalTitle').textContent = med ? '약 정보 수정' : '약 추가';
  document.getElementById('medNameInput').value = med ? med.name : '';
  document.getElementById('medDosageInput').value = med ? med.dosage : '';
  medTimesDraft = med ? [...med.times] : [];
  medTimeSlotsDraft = med && med.timeSlots ? { ...med.timeSlots } : {};
  currentMedSlot = '아침식후';
  document.getElementById('medTimeInput').value = '08:30';
  renderMedTimingPresets();
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
    chip.innerHTML = `${escapeHtml(t)} <button>✕</button>`;
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
  const payload = { patientId: activeTab, name, dosage, times: medTimesDraft, timeSlots: medTimeSlotsDraft, days: medDaysDraft };
  if (editingMedId) {
    const updated = await api(`/api/medications/${editingMedId}`, { method: 'PUT', body: JSON.stringify(payload) });
    state.medications = state.medications.map((m) => (m.id === editingMedId ? updated : m));
  } else {
    const created = await api('/api/medications', { method: 'POST', body: JSON.stringify(payload) });
    if (created.duplicate) {
      alert('이미 같은 이름·시간·요일로 등록된 약이 있어요.');
    } else {
      state.medications.push(created);
    }
  }
  isMedsCollapsed = false;
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
  const testBtn = document.getElementById('testPushBtn');

  if (testBtn) {
    testBtn.onclick = async () => {
      try {
        testBtn.disabled = true;
        testBtn.textContent = '발송 중...';
        const res = await api('/api/test-push', { method: 'POST' });
        alert(`🎉 테스트 알림을 발송했습니다! (수신 기기: ${res.sentTo || 0}대)\n잠시 후 폰 화면 상단 알림을 확인해보세요.`);
      } catch (e) {
        alert('테스트 알림 발송 중 문제가 생겼어요.');
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = '🔔 테스트';
      }
    };
  }

  if (!btn) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    btn.textContent = '이 브라우저는 지원하지 않아요';
    btn.disabled = true;
    return;
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const existing = await reg.pushManager.getSubscription();

    // 1. 이미 알림 권한이 있는 경우: 서버에 구독 정보 자동 동기화 (서버 재배포 시 구독 유실 완벽 복구!)
    if (Notification.permission === 'granted') {
      btn.textContent = '알림 켜짐';
      btn.classList.add('btn-primary');
      btn.classList.remove('btn-outline');

      try {
        let sub = existing;
        if (!sub) {
          const { publicKey } = await api('/api/vapid-public-key');
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          });
        }
        if (sub) {
          await api('/api/subscribe', {
            method: 'POST',
            body: JSON.stringify({ subscription: sub, deviceName: navigator.userAgent.slice(0, 40) }),
          });
          console.log('푸시 구독 서버 자동 동기화 완료');
        }
      } catch (err) {
        console.warn('푸시 구독 자동 동기화 실패:', err);
      }
    }
  } catch (e) {
    console.error('서비스워커 등록 실패:', e);
  }

  btn.onclick = async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { alert('알림 권한이 필요해요.'); return; }
      const { publicKey } = await api('/api/vapid-public-key');
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const res = await api('/api/subscribe', {
        method: 'POST',
        body: JSON.stringify({ subscription: sub, deviceName: navigator.userAgent.slice(0, 40) }),
      });
      btn.textContent = '알림 켜짐';
      btn.classList.add('btn-primary');
      btn.classList.remove('btn-outline');
      alert(`알림이 정상적으로 등록되었습니다! (연결된 기기: ${res.count || 1}대) 🎉`);
    } catch (e) {
      console.error(e);
      alert('알림 설정 중 문제가 생겼어요.');
    }
  };
}

// 앱 화면 복귀 시 구독 자동 재동기화 (PWA 백그라운드 깨어남 대응)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Notification.permission === 'granted' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        api('/api/subscribe', {
          method: 'POST',
          body: JSON.stringify({ subscription: sub, deviceName: navigator.userAgent.slice(0, 40) }),
        }).catch(() => {});
      }
    }).catch(() => {});
  }
});

// ---------------- 초기화 ----------------
document.getElementById('emptyAddBtn').onclick = openPatientModal;
document.getElementById('patientSaveBtn').onclick = savePatient;
document.getElementById('addMedBtn').onclick = (e) => { e.stopPropagation(); openBulkMedModal(); };
document.getElementById('medTimeAddBtn').onclick = () => {
  const t = document.getElementById('medTimeInput').value;
  if (t && !medTimesDraft.includes(t)) { medTimesDraft.push(t); renderTimeChips(); }
};
document.getElementById('medSaveBtn').onclick = saveMed;
document.getElementById('dietAskBtn').onclick = askDiet;
document.getElementById('dietAskInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') askDiet(); });
document.getElementById('addDietBtn').onclick = (e) => { e.stopPropagation(); openDietModal(null); };
document.getElementById('dietSaveBtn').onclick = saveDiet;
document.getElementById('bulkAddRowBtn').onclick = () => { bulkItemsDraft.push({ name: '', dosage: '' }); renderBulkItems(); };
document.getElementById('bulkSaveBtn').onclick = saveBulkMed;
document.getElementById('addExerciseBtn').onclick = () => openExerciseModal(null);
document.getElementById('exerciseTimeAddBtn').onclick = () => {
  const t = document.getElementById('exerciseTimeInput').value;
  if (t && !exerciseTimesDraft.includes(t)) { exerciseTimesDraft.push(t); renderExerciseTimeChips(); }
};
document.getElementById('exerciseSaveBtn').onclick = saveExercise;
document.getElementById('reminderSaveBtn').onclick = saveReminderInterval;
document.querySelectorAll('[data-close-modal]').forEach((btn) => {
  btn.onclick = () => closeModal(btn.getAttribute('data-close-modal'));
});


// 복약 관리 및 식단 관리 접기/펼치기 토글
const dietToggle = document.getElementById('dietHeaderToggle');
if (dietToggle) {
  dietToggle.onclick = () => toggleDietCollapse();
  dietToggle.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDietCollapse(); } };
}
const medsToggle = document.getElementById('medsHeaderToggle');
if (medsToggle) {
  medsToggle.onclick = () => toggleMedsCollapse();
  medsToggle.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMedsCollapse(); } };
}

// 병원 일정(캘린더) 이벤트 리스너
const addAptBtn = document.getElementById('addAptBtn');
if (addAptBtn) addAptBtn.onclick = () => openAptModal(null);

const addClinicBtn = document.getElementById('aptAddClinicBtn');
if (addClinicBtn) {
  addClinicBtn.onclick = () => {
    aptDoctorsDraft.push({ type: 'clinic', name: '', time: '10:00', dept: '' });
    renderAptDoctors();
  };
}

const addExamBtn = document.getElementById('aptAddExamBtn');
if (addExamBtn) {
  addExamBtn.onclick = () => {
    aptDoctorsDraft.push({ type: 'exam', name: '', time: '10:00', dept: '' });
    renderAptDoctors();
  };
}

const aptAddDocBtn = document.getElementById('aptAddDoctorBtn');
if (aptAddDocBtn) {
  aptAddDocBtn.onclick = () => {
    aptDoctorsDraft.push({ type: 'clinic', name: '', time: '10:00', dept: '' });
    renderAptDoctors();
  };
}

const aptSaveBtn = document.getElementById('aptSaveBtn');
if (aptSaveBtn) aptSaveBtn.onclick = saveApt;

const calPrevBtn = document.getElementById('calPrevMonthBtn');
if (calPrevBtn) {
  calPrevBtn.onclick = () => {
    calMonth--;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    renderCalendar();
  };
}

const calNextBtn = document.getElementById('calNextMonthBtn');
if (calNextBtn) {
  calNextBtn.onclick = () => {
    calMonth++;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    renderCalendar();
  };
}

const calTodayBtn = document.getElementById('calTodayBtn');
if (calTodayBtn) {
  calTodayBtn.onclick = () => {
    const now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
    selectedCalDate = null;
    renderCalendar();
    renderAppointments();
  };
}

// ---- 데이터 백업 & 수동 복원 ----
function downloadBackupJson() {
  const backupStr = JSON.stringify(state, null, 2);
  const blob = new Blob([backupStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `약속_가족복약_안전백업_${todayKey()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function restoreBackupFromFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const parsed = JSON.parse(ev.target.result);
      if (!parsed || !Array.isArray(parsed.patients)) {
        alert('올바른 약속 백업 파일(.json)이 아닙니다.');
        return;
      }
      if (!confirm(`백업 파일에서 데이터(${parsed.patients.length}명 가족, ${parsed.medications ? parsed.medications.length : 0}개 복약, ${parsed.appointments ? parsed.appointments.length : 0}개 진료)를 복원할까요?`)) {
        return;
      }
      await api('/api/data/restore', {
        method: 'POST',
        body: JSON.stringify(parsed)
      });
      state = parsed;
      try { localStorage.setItem(STORAGE_BACKUP_KEY, JSON.stringify(parsed)); } catch (_) {}
      alert('데이터가 성공적으로 복원되었습니다! 🎉');
      render();
    } catch (err) {
      alert('백업 파일을 읽는 중 오류가 발생했습니다: ' + err.message);
    }
  };
  reader.readAsText(file);
}

const backupDlBtn = document.getElementById('backupDownloadBtn');
if (backupDlBtn) backupDlBtn.onclick = downloadBackupJson;

const backupRestoreBtn = document.getElementById('backupRestorePickBtn');
const backupFileInput = document.getElementById('backupFileInput');
if (backupRestoreBtn && backupFileInput) {
  backupRestoreBtn.onclick = () => backupFileInput.click();
  backupFileInput.onchange = restoreBackupFromFile;
}

// ---------------- 알림 클릭 시 특정 항목 자동 스크롤 및 하이라이트 ----------------
function applyHighlight(el) {
  if (!el) return;
  el.classList.remove('highlight-pulse');
  void el.offsetWidth; // reflow 트리거
  el.classList.add('highlight-pulse');
  setTimeout(() => {
    el.classList.remove('highlight-pulse');
  }, 3800);
}

function handleTargetNavigation(target, url) {
  if (!target && url) {
    try {
      const u = new URL(url, window.location.origin);
      target = u.searchParams.get('target');
    } catch (_) {}
  }
  if (!target) return;
  pendingTarget = target;
  executeScrollToTarget(target);
}

function executeScrollToTarget(target) {
  if (!target) return false;

  // 1) apt_ 로 시작하는 병원 일정 타겟
  if (target.startsWith('apt_')) {
    const aptId = target.replace('apt_', '');
    const apt = (state.appointments || []).find((a) => a.id === aptId);
    if (apt) {
      if (activeTab !== 'all' && apt.patientId !== activeTab) {
        activeTab = apt.patientId;
        renderTabs();
      }
      if (apt.date) {
        const d = new Date(apt.date + 'T00:00:00');
        calYear = d.getFullYear();
        calMonth = d.getMonth();
        selectedCalDate = apt.date;
        renderCalendar();
      }
      renderAppointments();
    }
    const el = document.getElementById(`apt-card-${aptId}`) || document.querySelector(`[data-apt-id="${aptId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      applyHighlight(el);
      pendingTarget = null;
      return true;
    }
  }

  // 2) med_ 로 시작하는 복약 타겟
  if (target.startsWith('med_')) {
    const rest = target.replace('med_', '');
    const parts = rest.split('_');
    const medId = parts[0];
    const time = parts[1];

    let el = null;
    if (time) {
      el = document.getElementById(`today-item-${medId}-${time.replace(':', '')}`);
    }
    if (!el) {
      el = document.querySelector(`[data-med-id="${medId}"]`);
    }

    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      applyHighlight(el);
      pendingTarget = null;
      return true;
    }

    // 오늘의 복약 목록에 없으면 복약 관리 섹션 열기
    const med = (state.medications || []).find((m) => m.id === medId);
    if (med) {
      if (activeTab !== med.patientId) {
        activeTab = med.patientId;
        renderTabs();
        render();
      }
      if (isMedsCollapsed) {
        toggleMedsCollapse();
      }
      setTimeout(() => {
        const medEl = document.getElementById(`med-item-${medId}`) || document.querySelector(`[data-med-id="${medId}"]`);
        if (medEl) {
          medEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          applyHighlight(medEl);
        }
      }, 250);
      pendingTarget = null;
      return true;
    }
  }

  // 3) ex_ 로 시작하는 운동 타겟
  if (target.startsWith('ex_')) {
    const exId = target.replace('ex_', '');
    const ex = (state.exercises || []).find((e) => e.id === exId);
    if (ex && activeTab !== ex.patientId) {
      activeTab = ex.patientId;
      renderTabs();
      render();
    }
    const el = document.getElementById(`ex-item-${exId}`) || document.querySelector(`[data-target-id="ex_${exId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      applyHighlight(el);
      pendingTarget = null;
      return true;
    }
  }

  // 4) 일반 섹션 타겟 (today, apt, calendar, diet)
  if (target === 'today') {
    const el = document.getElementById('todayList') || document.getElementById('quickTimingBatchWrap');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      applyHighlight(el);
      pendingTarget = null;
      return true;
    }
  } else if (target === 'apt' || target === 'calendar') {
    const el = document.getElementById('aptList') || document.querySelector('.calendar-card');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      applyHighlight(el);
      pendingTarget = null;
      return true;
    }
  } else if (target === 'diet') {
    if (isDietCollapsed) toggleDietCollapse();
    setTimeout(() => {
      const el = document.getElementById('dietList');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        applyHighlight(el);
      }
    }, 250);
    pendingTarget = null;
    return true;
  }

  return false;
}

// 서비스워커 메시지 리스너 (앱이 이미 열려 있을 때 알림 탭 처리)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && (event.data.type === 'NAVIGATE_TARGET' || event.data.type === 'NOTIFICATION_CLICK')) {
      handleTargetNavigation(event.data.target, event.data.url);
    }
  });
}

// 앱 실행 시 URL 쿼리 파라미터(?target=...) 감지 및 스크롤 예약
const initialParams = new URLSearchParams(window.location.search);
const initialTarget = initialParams.get('target');
if (initialTarget) {
  pendingTarget = initialTarget;
  try {
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);
  } catch (_) {}
}

// ---------------- 수동 직접 알림 모달 제어 ----------------
function initManualPush() {
  const openBtn = document.getElementById('manualPushBtn');
  const modal = document.getElementById('manualPushModal');
  const titleInput = document.getElementById('manualPushTitleInput');
  const bodyInput = document.getElementById('manualPushBodyInput');
  const targetSelect = document.getElementById('manualPushTargetSelect');
  const sendBtn = document.getElementById('manualPushSendBtn');

  if (openBtn) {
    openBtn.onclick = () => {
      modal.classList.remove('hidden');
    };
  }

  // 템플릿 버튼 클릭 시 인풋 자동 채우기
  document.querySelectorAll('.quick-msg-btn').forEach((btn) => {
    btn.onclick = () => {
      const title = btn.getAttribute('data-title') || '';
      const body = btn.getAttribute('data-body') || '';
      const target = btn.getAttribute('data-target') || 'today';
      if (titleInput) titleInput.value = title;
      if (bodyInput) bodyInput.value = body;
      if (targetSelect) targetSelect.value = target;
    };
  });

  if (sendBtn) {
    sendBtn.onclick = async () => {
      const title = (titleInput ? titleInput.value : '').trim();
      const body = (bodyInput ? bodyInput.value : '').trim();
      const target = targetSelect ? targetSelect.value : 'today';

      if (!title || !body) {
        alert('알림 제목과 내용을 모두 입력해주세요.');
        return;
      }

      try {
        sendBtn.disabled = true;
        sendBtn.textContent = '🚀 발송 중...';

        const res = await api('/api/send-custom-push', {
          method: 'POST',
          body: JSON.stringify({
            title,
            body,
            target: target !== 'none' ? target : '',
            url: target !== 'none' ? `/?target=${target}` : '/'
          })
        });

        alert(`🎉 알림을 성공적으로 발송했습니다! (수신 기기: ${res.sentTo || 0}대)\n가족들의 기기 화면을 확인해보세요.`);
        closeModal('manualPushModal');
      } catch (e) {
        alert('알림 발송 중 오류가 발생했습니다: ' + e.message);
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = '🚀 지금 모든 기기로 알림 보내기';
      }
    };
  }
}

loadData();
initPush();
initManualPush();
setInterval(loadData, 30000); // 30초마다 최신 데이터로 갱신 (다른 기기에서 체크한 것도 반영)

