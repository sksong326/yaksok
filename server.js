const fs = require('fs');
const path = require('path');
const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const multer = require('multer');
const ExcelJS = require('exceljs');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- VAPID (푸시 인증) 설정 ----
// 배포할 때는 Render 등 호스팅의 "환경 변수(Environment Variables)"에
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT 를 넣어주는 걸 권장해요.
// 값이 없으면 아래 기본 키로 동작하니, 일단 테스트하는 데는 문제 없어요.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BEcXFFQxUVoo8ivDZfCW6_Xg8tgQ2vzG1FjAd42F0BWqFZ_at2a07XNZc0jG0Q61Fl2nuzB1gU1HvPafRqQ-WXI';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'PGLG9lJ1eD7RgWRMYE52L0NnzuA9DhokyOIIUcnuSSg';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:example@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ---- 아주 단순한 파일 기반 저장소 ----
function loadData() {
  const fallback = { patients: [], medications: [], logs: {}, subscriptions: [], diets: [], exercises: [], appointments: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    return { ...fallback, ...parsed };
  } catch (e) {
    return fallback;
  }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

// 서버 시간대와 무관하게 항상 한국 시간 기준으로 계산
function nowKST() {
  const now = new Date();
  const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  return kst;
}
function dateKeyKST(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function hmKST(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---- 엑셀 업로드에서 읽은 값 정규화 ----
function normalizeTime(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date) return `${pad(raw.getHours())}:${pad(raw.getMinutes())}`;
  const s = String(raw).trim();
  let m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)?/);
  if (m) {
    let h = Number(m[1]); const mm = Number(m[2]); const ap = (m[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || mm > 59) return null;
    return `${pad(h)}:${pad(mm)}`;
  }
  const num = Number(s);
  if (!isNaN(num) && num >= 0 && num < 1) {
    const totalMin = Math.round(num * 24 * 60);
    return `${pad(Math.floor(totalMin / 60))}:${pad(totalMin % 60)}`;
  }
  return null;
}

// "08:00", "8:00 AM", "0.5"(엑셀 시간 형식) 등을 "HH:mm"으로 정규화
function parseTimeToken(token) {
  return normalizeTime(token);
}

function timeToMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function normalizeDays(raw) {
  const all = [0, 1, 2, 3, 4, 5, 6];
  if (!raw) return all;
  const s = String(raw).trim();
  if (!s || s.includes('매일')) return all;
  if (s.includes('평일')) return [1, 2, 3, 4, 5];
  if (s.includes('주말')) return [0, 6];
  const map = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
  const days = [];
  for (const ch of s) {
    if (map[ch] !== undefined && !days.includes(map[ch])) days.push(map[ch]);
  }
  return days.length ? days.sort((a, b) => a - b) : all;
}

// 하나의 셀에 컴마(,)나 슬래시(/), 줄바꿈 등으로 여러 시간이 들어온 경우
// (예: "08:00,13:00,19:00" = 아침/점심/저녁 같이 먹는 약) 모두 분리해서 정규화
function normalizeTimes(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  const parts = String(raw).split(/[,\n\/、·；;]+/).map((s) => s.trim()).filter(Boolean);
  const times = [];
  for (const p of parts) {
    const t = parseTimeToken(p);
    if (t && !times.includes(t)) times.push(t);
  }
  return times.sort((a, b) => timeToMinutes(a) - timeToMinutes(b));
}

// 하나의 셀에 컴마(,)로 여러 음식 이름이 들어온 경우
// (예: "사과, 바나나, 포도") 각각 개별 항목으로 분리
function splitNames(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  return String(raw).split(/[,、，]+/).map((s) => s.trim()).filter(Boolean);
}

function normalizeStatus(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.includes('금지') || s.includes('안됨') || s.includes('안돼')) return 'avoid';
  if (s.includes('주의') || s.includes('조심')) return 'caution';
  if (s.includes('허용') || s.includes('가능') || s.includes('괜찮')) return 'ok';
  return null;
}

function cellText(cell) {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return cell;
  if (typeof cell === 'object' && cell.text !== undefined) return cell.text;
  if (typeof cell === 'object' && cell.result !== undefined) return cell.result;
  return cell;
}

function sheetToRows(worksheet) {
  if (!worksheet) return [];
  const rows = [];
  const headerRow = worksheet.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = String(cellText(cell.value) || '').trim();
  });
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = { __row: rowNumber };
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const key = headers[colNumber];
      if (key) obj[key] = cellText(cell.value);
    });
    rows.push(obj);
  });
  return rows;
}

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.post('/api/parse-excel', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없어요.' });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);

    const medSheet = workbook.worksheets.find((s) => s.name.includes('복약')) || workbook.worksheets[0];
    const dietSheet = workbook.worksheets.find((s) => s.name.includes('식단'));

    // 복약: 한 행의 "시간" 칸에 콤마로 여러 시간을 적으면(예: 08:00,13:00,19:00)
    // 아침/점심/저녁처럼 하루에 여러 번 먹는 약 하나를 한 줄로 등록할 수 있어요.
    const medications = sheetToRows(medSheet).map((r) => {
      const timeRaw = r['시간'] ?? r['time'] ?? '';
      const name = String(r['약이름'] ?? r['약 이름'] ?? r['name'] ?? '').trim();
      const dosage = String(r['수량'] ?? r['dosage'] ?? '').trim();
      const daysRaw = r['요일'] ?? r['days'] ?? '';
      const times = normalizeTimes(timeRaw);
      const days = normalizeDays(daysRaw);
      return { row: r.__row, name, dosage, times, timesDisplay: times, timeRaw: String(timeRaw || ''), days, valid: !!(name && times.length) };
    }).filter((r) => r.name || r.timeRaw);

    // 식단: 한 행의 "음식이름" 칸에 콤마로 여러 음식을 적으면(예: 사과, 바나나, 포도)
    // 같은 상태/메모로 각각 개별 항목으로 나눠서 등록해요.
    const diets = dietSheet ? sheetToRows(dietSheet).flatMap((r) => {
      const nameRaw = r['음식이름'] ?? r['음식 이름'] ?? r['name'] ?? '';
      const statusRaw = r['상태'] ?? r['status'] ?? '';
      const note = String(r['메모'] ?? r['note'] ?? '').trim();
      const status = normalizeStatus(statusRaw);
      const names = splitNames(nameRaw);
      if (names.length === 0) {
        return [{ row: r.__row, name: '', statusRaw: String(statusRaw || ''), status, note, valid: false }];
      }
      return names.map((name) => ({ row: r.__row, name, statusRaw: String(statusRaw || ''), status, note, valid: !!(name && status) }));
    }).filter((r) => r.name || r.statusRaw) : [];

    res.json({ medications, diets });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: '엑셀 파일을 읽는 중 문제가 생겼어요. 템플릿 형식과 같은지 확인해주세요.' });
  }
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.get('/api/data', (req, res) => {
  const data = loadData();
  const { subscriptions, ...safe } = data; // 구독 정보는 클라이언트로 보내지 않음
  res.json(safe);
});

// ---- 환자(가족) ----
const DEFAULT_REMINDER_INTERVAL_MIN = 15;

app.post('/api/patients', (req, res) => {
  const data = loadData();
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const patient = { id: uid('p'), name, color: color || '#2F6F62', reminderIntervalMin: DEFAULT_REMINDER_INTERVAL_MIN };
  data.patients.push(patient);
  saveData(data);
  res.json(patient);
});

// ---- 재알림 간격 등 환자 설정 변경 ----
app.put('/api/patients/:id', (req, res) => {
  const data = loadData();
  const idx = data.patients.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const { name, color, reminderIntervalMin } = req.body;
  const patient = data.patients[idx];
  data.patients[idx] = {
    ...patient,
    ...(name ? { name } : {}),
    ...(color ? { color } : {}),
    ...(reminderIntervalMin !== undefined ? { reminderIntervalMin: Math.max(1, Number(reminderIntervalMin) || DEFAULT_REMINDER_INTERVAL_MIN) } : {}),
  };
  saveData(data);
  res.json(data.patients[idx]);
});

app.delete('/api/patients/:id', (req, res) => {
  const data = loadData();
  data.patients = data.patients.filter((p) => p.id !== req.params.id);
  data.medications = data.medications.filter((m) => m.patientId !== req.params.id);
  data.exercises = (data.exercises || []).filter((e) => e.patientId !== req.params.id);
  data.diets = (data.diets || []).filter((d) => d.patientId !== req.params.id);
  data.appointments = (data.appointments || []).filter((a) => a.patientId !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

// ---- 복약 일정 ----
// 같은 가족(patientId) + 약이름 + 시간구성 + 요일이 이미 있으면 중복으로 판단
function medsMatch(a, b) {
  if (a.patientId !== b.patientId) return false;
  if (String(a.name).trim().toLowerCase() !== String(b.name).trim().toLowerCase()) return false;
  const at = [...a.times].sort().join('|');
  const bt = [...b.times].sort().join('|');
  if (at !== bt) return false;
  const ad = [...a.days].sort().join('|');
  const bd = [...b.days].sort().join('|');
  return ad === bd;
}
function findDuplicateMedication(data, candidate) {
  return data.medications.find((m) => medsMatch(m, candidate));
}
function findDuplicateDiet(data, patientId, name) {
  const n = String(name).trim().toLowerCase();
  return data.diets.find((d) => d.patientId === patientId && String(d.name).trim().toLowerCase() === n);
}

app.post('/api/medications', (req, res) => {
  const data = loadData();
  const { patientId, name, dosage, times, timeSlots, days } = req.body;
  if (!patientId || !name || !Array.isArray(times) || times.length === 0) {
    return res.status(400).json({ error: 'invalid medication' });
  }
  const finalDays = days && days.length ? days : [0, 1, 2, 3, 4, 5, 6];
  const dup = findDuplicateMedication(data, { patientId, name, times, days: finalDays });
  if (dup) return res.json({ ...dup, duplicate: true });
  const med = { id: uid('m'), patientId, name, dosage: dosage || '', times, timeSlots: timeSlots || {}, days: finalDays };
  data.medications.push(med);
  saveData(data);
  res.json(med);
});

// ---- 복약 일정: 시간대별 여러 약 한번에 등록 ----
app.post('/api/medications/bulk', (req, res) => {
  const data = loadData();
  const { patientId, time, timeSlots, days, items } = req.body;
  if (!patientId || !time || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'invalid bulk medication' });
  }
  const finalDays = days && days.length ? days : [0, 1, 2, 3, 4, 5, 6];
  const created = [];
  let skipped = 0;
  items.filter((it) => it.name && it.name.trim()).forEach((it) => {
    const candidate = { patientId, name: it.name.trim(), times: [time], days: finalDays };
    if (findDuplicateMedication(data, candidate) || created.some((c) => medsMatch(c, candidate))) {
      skipped += 1;
      return;
    }
    created.push({
      id: uid('m'),
      patientId,
      name: it.name.trim(),
      dosage: (it.dosage || '').trim(),
      times: [time],
      timeSlots: timeSlots || {},
      days: finalDays,
    });
  });
  data.medications.push(...created);
  saveData(data);
  res.json({ created, skipped });
});

app.put('/api/medications/:id', (req, res) => {
  const data = loadData();
  const idx = data.medications.findIndex((m) => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  data.medications[idx] = { ...data.medications[idx], ...req.body, id: req.params.id };
  saveData(data);
  res.json(data.medications[idx]);
});

app.delete('/api/medications/:id', (req, res) => {
  const data = loadData();
  data.medications = data.medications.filter((m) => m.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

// ---- 운동 알림 (권고사항 - 놓쳐도 반복 알림 없음) ----
app.post('/api/exercises', (req, res) => {
  const data = loadData();
  const { patientId, name, times, days } = req.body;
  if (!patientId || !name || !Array.isArray(times) || times.length === 0) {
    return res.status(400).json({ error: 'invalid exercise' });
  }
  const ex = { id: uid('ex'), patientId, name: name.trim(), times, days: days && days.length ? days : [0, 1, 2, 3, 4, 5, 6] };
  data.exercises.push(ex);
  saveData(data);
  res.json(ex);
});

app.put('/api/exercises/:id', (req, res) => {
  const data = loadData();
  const idx = data.exercises.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  data.exercises[idx] = { ...data.exercises[idx], ...req.body, id: req.params.id };
  saveData(data);
  res.json(data.exercises[idx]);
});

app.delete('/api/exercises/:id', (req, res) => {
  const data = loadData();
  data.exercises = data.exercises.filter((e) => e.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

// ---- 복약 체크(로그) ----
app.post('/api/logs/toggle', (req, res) => {
  const data = loadData();
  const { date, medId, time } = req.body;
  const key = `${date}|${medId}|${time}`;
  if (data.logs[key]) delete data.logs[key];
  else data.logs[key] = true;
  saveData(data);
  res.json({ key, taken: !!data.logs[key] });
});

// ---- 일괄 복약 체크 (원클릭 식전/식후 완료) ----
app.post('/api/logs/batch', (req, res) => {
  const data = loadData();
  const { date, items, taken } = req.body;
  if (!date || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'invalid batch' });
  }
  const shouldTake = taken !== undefined ? !!taken : items.some((it) => !data.logs[`${date}|${it.medId}|${it.time}`]);
  items.forEach((it) => {
    const key = `${date}|${it.medId}|${it.time}`;
    if (shouldTake) {
      data.logs[key] = true;
    } else {
      delete data.logs[key];
    }
  });
  saveData(data);
  res.json({ ok: true, taken: shouldTake, count: items.length });
});

// ---- 데이터 소실 방지용 자동 복원 / 수동 복원 ----
app.post('/api/data/restore', (req, res) => {
  const data = loadData();
  const incoming = req.body;
  if (incoming && Array.isArray(incoming.patients) && incoming.patients.length > 0) {
    const subscriptions = data.subscriptions || [];
    const restored = {
      patients: incoming.patients || [],
      medications: incoming.medications || [],
      logs: incoming.logs || {},
      diets: incoming.diets || [],
      exercises: incoming.exercises || [],
      appointments: incoming.appointments || [],
      subscriptions,
    };
    saveData(restored);
    return res.json({ ok: true, message: '데이터가 안전하게 복원되었습니다.' });
  }
  res.status(400).json({ error: '유효한 복원 데이터가 아닙니다.' });
});

// ---- 식단(음식 허용/금지) 목록 ----
// status: 'ok' (먹어도 됨) | 'caution' (주의) | 'avoid' (금지)
app.post('/api/diets', (req, res) => {
  const data = loadData();
  const { patientId, name, status, note } = req.body;
  if (!patientId || !name || !['ok', 'caution', 'avoid'].includes(status)) {
    return res.status(400).json({ error: 'invalid diet item' });
  }
  const dup = findDuplicateDiet(data, patientId, name);
  if (dup) return res.json({ ...dup, duplicate: true });
  const item = { id: uid('d'), patientId, name: name.trim(), status, note: (note || '').trim() };
  data.diets.push(item);
  saveData(data);
  res.json(item);
});

app.put('/api/diets/:id', (req, res) => {
  const data = loadData();
  const idx = data.diets.findIndex((d) => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  data.diets[idx] = { ...data.diets[idx], ...req.body, id: req.params.id };
  saveData(data);
  res.json(data.diets[idx]);
});

app.delete('/api/diets/:id', (req, res) => {
  const data = loadData();
  data.diets = data.diets.filter((d) => d.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

// ---- 병원 방문 일정 (캘린더) ----
app.post('/api/appointments', (req, res) => {
  const data = loadData();
  const { patientId, hospitalName, date, doctors, fastingRequired, notifyPrevDay, prevDayTime, hoursBefore, note } = req.body;
  if (!patientId || !hospitalName || !date || !Array.isArray(doctors) || doctors.length === 0) {
    return res.status(400).json({ error: 'invalid appointment' });
  }
  const apt = {
    id: uid('apt'),
    patientId,
    hospitalName: hospitalName.trim(),
    date, // YYYY-MM-DD
    doctors: doctors
      .filter((doc) => doc.name && doc.name.trim())
      .map((doc, idx) => ({
        id: doc.id || uid(`doc_${idx}`),
        name: doc.name.trim(),
        time: doc.time || '10:00',
        dept: (doc.dept || '').trim()
      })),
    fastingRequired: !!fastingRequired,
    notifyPrevDay: notifyPrevDay !== undefined ? notifyPrevDay : true,
    prevDayTime: prevDayTime || '21:00',
    hoursBefore: hoursBefore !== undefined ? Number(hoursBefore) : 3,
    note: (note || '').trim()
  };
  if (!data.appointments) data.appointments = [];
  data.appointments.push(apt);
  saveData(data);
  res.json(apt);
});

app.put('/api/appointments/:id', (req, res) => {
  const data = loadData();
  if (!data.appointments) data.appointments = [];
  const idx = data.appointments.findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  data.appointments[idx] = { ...data.appointments[idx], ...req.body, id: req.params.id };
  saveData(data);
  res.json(data.appointments[idx]);
});

app.delete('/api/appointments/:id', (req, res) => {
  const data = loadData();
  data.appointments = (data.appointments || []).filter((a) => a.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});


// ---- 푸시 구독 ----
app.post('/api/subscribe', (req, res) => {
  const data = loadData();
  const { subscription, deviceName } = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  const exists = data.subscriptions.find((s) => s.subscription.endpoint === subscription.endpoint);
  if (!exists) {
    data.subscriptions.push({ id: uid('sub'), deviceName: deviceName || '기기', subscription });
    saveData(data);
  }
  res.json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  const data = loadData();
  const { endpoint } = req.body;
  data.subscriptions = data.subscriptions.filter((s) => s.subscription.endpoint !== endpoint);
  saveData(data);
  res.json({ ok: true });
});

// 테스트용: 등록된 모든 기기에 테스트 알림 보내기
app.post('/api/test-push', async (req, res) => {
  await sendToAll({ title: '테스트 알림', body: '이 알림이 보이면 정상 작동이에요 🎉' });
  res.json({ ok: true });
});

async function sendToAll(payload) {
  const data = loadData();
  const results = await Promise.allSettled(
    data.subscriptions.map((s) => webpush.sendNotification(s.subscription, JSON.stringify(payload)))
  );
  // 만료되었거나 더 이상 유효하지 않은 구독은 정리
  const stillValid = [];
  data.subscriptions.forEach((s, i) => {
    const r = results[i];
    if (r.status === 'fulfilled' || (r.reason && r.reason.statusCode !== 404 && r.reason.statusCode !== 410)) {
      stillValid.push(s);
    }
  });
  if (stillValid.length !== data.subscriptions.length) {
    data.subscriptions = stillValid;
    saveData(data);
  }
}

// ---- 매분 복약/운동 시간 체크 (한국 시간 기준) ----
// 복약: 체크 안 하면 정해진 시간이 지나도 최대 3번까지 재알림.
// 운동: 권고사항이라 시간에 딱 한 번만 알려주고 반복하지 않음.
const REPEAT_MAX_COUNT = 3; // 최초 알림 포함 최대 몇 번까지 보낼지

const lastNotifiedAt = new Map(); // notifyKey -> { lastMin, count }
const exerciseNotified = new Set();

function inferTimingSlot(timeStr) {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const totalMin = (h || 0) * 60 + (m || 0);
  if (totalMin >= 300 && totalMin < 495) return '아침식전';
  if (totalMin >= 495 && totalMin < 660) return '아침식후';
  if (totalMin >= 660 && totalMin < 735) return '점심식전';
  if (totalMin >= 735 && totalMin < 960) return '점심식후';
  if (totalMin >= 960 && totalMin < 1095) return '저녁식전';
  if (totalMin >= 1095 && totalMin < 1260) return '저녁식후';
  return '취침전';
}
 // notifyKey (하루 1번만 보내면 되므로 Set으로 충분)

cron.schedule('* * * * *', async () => {
  const d = nowKST();
  const dateKey = dateKeyKST(d);
  const nowMin = d.getHours() * 60 + d.getMinutes();
  const hm = hmKST(d);
  const weekday = d.getDay();
  const data = loadData();

  // ---- 복약: 최대 3번까지 재알림 ----
  data.medications.forEach((med) => {
    if (!med.days.includes(weekday)) return;
    const patient = data.patients.find((p) => p.id === med.patientId);
    const intervalMin = Math.max(1, Number(patient && patient.reminderIntervalMin) || DEFAULT_REMINDER_INTERVAL_MIN);
    med.times.forEach((time) => {
      const targetMin = timeToMinutes(time);
      if (nowMin < targetMin) return; // 아직 시간 전

      const notifyKey = `${dateKey}_${med.id}_${time}`;
      const key = `${dateKey}|${med.id}|${time}`;
      if (data.logs[key]) { lastNotifiedAt.delete(notifyKey); return; } // 이미 복용 체크됨 → 재알림 중단

      const state = lastNotifiedAt.get(notifyKey);
      if (state) {
        if (state.count >= REPEAT_MAX_COUNT) return; // 이미 정해진 횟수만큼 다 보냄
        if (nowMin - state.lastMin < intervalMin) return; // 아직 재알림 주기 아님
      }
      const isFirst = !state;
      const count = (state ? state.count : 0) + 1;
      lastNotifiedAt.set(notifyKey, { lastMin: nowMin, count });

      const slot = (med.timeSlots && med.timeSlots[time]) || inferTimingSlot(time);
      const slotPrefix = slot ? `[${slot}] ` : '';
      const notiTitle = isFirst ? `${slotPrefix}약속 시간이에요` : `${slotPrefix}아직 안 드셨어요~ 드셨으면 체크 부탁드려요!`;
      sendToAll({
        title: notiTitle,
        body: `${patient ? patient.name : ''} · ${med.name}${med.dosage ? ' · ' + med.dosage : ''} (${time})`,
      });
    });
  });

  // ---- 운동: 권고사항이므로 시간 맞을 때 딱 한 번만 ----
  data.exercises.forEach((ex) => {
    if (!ex.days.includes(weekday)) return;
    ex.times.forEach((time) => {
      if (time !== hm) return; // 정각 그 순간에만 (반복 없음)
      const key = `${dateKey}|ex:${ex.id}|${time}`;
      if (data.logs[key]) return;
      const notifyKey = `${dateKey}_ex_${ex.id}_${time}`;
      if (exerciseNotified.has(notifyKey)) return;
      exerciseNotified.add(notifyKey);

      const patient = data.patients.find((p) => p.id === ex.patientId);
      sendToAll({
        title: '운동할 시간이에요 🏃',
        body: `${patient ? patient.name : ''} · ${ex.name} (${time})`,
      });
    });
  });


  // ---- 병원 방문 일정 알림 체크 ----
  const tomorrowDate = new Date(d);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowKey = dateKeyKST(tomorrowDate);

  (data.appointments || []).forEach((apt) => {
    const patient = data.patients.find((p) => p.id === apt.patientId);
    const patientName = patient ? patient.name : '가족';

    // 1) 방문 전날 일괄 알림 (기본: 전날 21:00)
    if (apt.date === tomorrowKey) {
      const isNotifyDay = apt.notifyPrevDay !== false;
      const targetTime = apt.prevDayTime || '21:00';
      if (isNotifyDay && targetTime === hm) {
        const notifyKey = `${dateKey}_prev_apt_${apt.id}_${hm}`;
        if (!exerciseNotified.has(notifyKey)) {
          exerciseNotified.add(notifyKey);
          const docSummary = (apt.doctors || [])
            .map((doc) => `${doc.name} 교수(${doc.time}${doc.dept ? '·' + doc.dept : ''})`)
            .join(', ');
          sendToAll({
            title: `[내일 병원 방문] ${patientName}님 ${apt.hospitalName} 진료 안내`,
            body: `내일 ${apt.hospitalName} 진료: ${docSummary}. 금식하셔야 되나요? 확인해주세요.`
          });
        }
      }
    }

    // 2) 방문 당일 진료 N시간 전(기본: 3시간 전) 각 교수별 알림
    if (apt.date === dateKey) {
      const hoursBefore = apt.hoursBefore !== undefined ? Number(apt.hoursBefore) : 3;
      (apt.doctors || []).forEach((doc) => {
        if (!doc.time) return;
        const [dh, dm] = doc.time.split(':').map(Number);
        const docTotalMin = (dh || 0) * 60 + (dm || 0);
        const alertMin = docTotalMin - (hoursBefore * 60);
        if (alertMin >= 0) {
          const alertH = Math.floor(alertMin / 60);
          const alertM = alertMin % 60;
          const alertHM = `${pad(alertH)}:${pad(alertM)}`;
          if (alertHM === hm) {
            const notifyKey = `${dateKey}_apt_doc_${apt.id}_${doc.id || doc.name}_${hm}`;
            if (!exerciseNotified.has(notifyKey)) {
              exerciseNotified.add(notifyKey);
              sendToAll({
                title: `[병원 방문 ${hoursBefore}시간 전] ${doc.name} 교수 진료 안내`,
                body: `${patientName}님 ${apt.hospitalName} ${doc.name} 교수님 진료(${doc.time}${doc.dept ? '·' + doc.dept : ''}) ${hoursBefore}시간 전입니다. 금식하셔야 되나요? 확인해주세요.`
              });
            }
          }
        }
      });
    }
  });

  // 메모리 누수 방지
  if (lastNotifiedAt.size > 3000) lastNotifiedAt.clear();
  if (exerciseNotified.size > 3000) exerciseNotified.clear();
}, { timezone: 'Asia/Seoul' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`약속 서버 실행 중: http://localhost:${PORT}`);
});
