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
  const fallback = { patients: [], medications: [], logs: {}, subscriptions: [], diets: [] };
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

    const medications = sheetToRows(medSheet).map((r) => {
      const timeRaw = r['시간'] ?? r['time'] ?? '';
      const name = String(r['약이름'] ?? r['약 이름'] ?? r['name'] ?? '').trim();
      const dosage = String(r['수량'] ?? r['dosage'] ?? '').trim();
      const daysRaw = r['요일'] ?? r['days'] ?? '';
      const time = normalizeTime(timeRaw);
      const days = normalizeDays(daysRaw);
      return { row: r.__row, name, dosage, time, timeRaw: String(timeRaw || ''), days, valid: !!(name && time) };
    }).filter((r) => r.name || r.timeRaw);

    const diets = dietSheet ? sheetToRows(dietSheet).map((r) => {
      const name = String(r['음식이름'] ?? r['음식 이름'] ?? r['name'] ?? '').trim();
      const statusRaw = r['상태'] ?? r['status'] ?? '';
      const note = String(r['메모'] ?? r['note'] ?? '').trim();
      const status = normalizeStatus(statusRaw);
      return { row: r.__row, name, statusRaw: String(statusRaw || ''), status, note, valid: !!(name && status) };
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
app.post('/api/patients', (req, res) => {
  const data = loadData();
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const patient = { id: uid('p'), name, color: color || '#2F6F62' };
  data.patients.push(patient);
  saveData(data);
  res.json(patient);
});

app.delete('/api/patients/:id', (req, res) => {
  const data = loadData();
  data.patients = data.patients.filter((p) => p.id !== req.params.id);
  data.medications = data.medications.filter((m) => m.patientId !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

// ---- 복약 일정 ----
app.post('/api/medications', (req, res) => {
  const data = loadData();
  const { patientId, name, dosage, times, days } = req.body;
  if (!patientId || !name || !Array.isArray(times) || times.length === 0) {
    return res.status(400).json({ error: 'invalid medication' });
  }
  const med = { id: uid('m'), patientId, name, dosage: dosage || '', times, days: days && days.length ? days : [0, 1, 2, 3, 4, 5, 6] };
  data.medications.push(med);
  saveData(data);
  res.json(med);
});

// ---- 복약 일정: 시간대별 여러 약 한번에 등록 ----
app.post('/api/medications/bulk', (req, res) => {
  const data = loadData();
  const { patientId, time, days, items } = req.body;
  if (!patientId || !time || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'invalid bulk medication' });
  }
  const finalDays = days && days.length ? days : [0, 1, 2, 3, 4, 5, 6];
  const created = items
    .filter((it) => it.name && it.name.trim())
    .map((it) => ({
      id: uid('m'),
      patientId,
      name: it.name.trim(),
      dosage: (it.dosage || '').trim(),
      times: [time],
      days: finalDays,
    }));
  data.medications.push(...created);
  saveData(data);
  res.json(created);
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

// ---- 식단(음식 허용/금지) 목록 ----
// status: 'ok' (먹어도 됨) | 'caution' (주의) | 'avoid' (금지)
app.post('/api/diets', (req, res) => {
  const data = loadData();
  const { patientId, name, status, note } = req.body;
  if (!patientId || !name || !['ok', 'caution', 'avoid'].includes(status)) {
    return res.status(400).json({ error: 'invalid diet item' });
  }
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

// ---- 매분 복약 시간 체크 (한국 시간 기준) ----
const alreadyNotified = new Set();

cron.schedule('* * * * *', async () => {
  const d = nowKST();
  const dateKey = dateKeyKST(d);
  const hm = hmKST(d);
  const weekday = d.getDay();
  const data = loadData();

  data.medications.forEach((med) => {
    if (!med.days.includes(weekday)) return;
    if (!med.times.includes(hm)) return;
    const key = `${dateKey}|${med.id}|${hm}`;
    if (data.logs[key]) return; // 이미 복용 체크됨
    const notifyKey = `${dateKey}_${med.id}_${hm}`;
    if (alreadyNotified.has(notifyKey)) return;
    alreadyNotified.add(notifyKey);

    const patient = data.patients.find((p) => p.id === med.patientId);
    sendToAll({
      title: '약속 시간이에요',
      body: `${patient ? patient.name : ''} · ${med.name}${med.dosage ? ' · ' + med.dosage : ''} (${hm})`,
    });
  });

  // 메모리 누수 방지: 자정 지나면 어제 알림 기록 정리
  if (alreadyNotified.size > 2000) alreadyNotified.clear();
}, { timezone: 'Asia/Seoul' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`약속 서버 실행 중: http://localhost:${PORT}`);
});
