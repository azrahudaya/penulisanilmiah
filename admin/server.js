import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import dayjs from 'dayjs';
import db, {
  getResearchLog,
  updateResearchLog,
  updateRespondent,
  deleteRespondentData,
  isFeedbackPromptEnabled,
  setAppSetting,
} from '../src/db.js';
import { calculateExtractionMetrics, calculateWer, parseJsonList, validateGroundTruthTasks } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const audioDir = path.join(rootDir, 'data', 'audio');
const envPath = path.join(rootDir, '.env');
const env = { ...loadEnv(envPath), ...process.env };
const app = express();
const port = Number(env.ADMIN_PORT || 3000);
const password = env.DASHBOARD_PASSWORD || '';
const sessionSecret = env.ADMIN_SESSION_SECRET || crypto.createHash('sha256').update(password || 'dev').digest('hex');
const loginAttempts = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const AI_SUGGEST_WINDOW_MS = 60 * 60 * 1000;
const AI_SUGGEST_MAX_ATTEMPTS = 20;
const aiSuggestAttempts = new Map();
const VALID_GENDERS = new Set(['Laki-laki', 'Perempuan']);
const VALID_CONSENT_STATUSES = new Set(['consented', 'declined', 'unconfirmed']);
const VALID_REGISTRATION_STEPS = new Set(['completed', 'name', 'age', 'gender', 'occupation', 'consent', 'declined', 'not_started']);
const RESPONDENT_SORTS = {
  id: 'r.respondent_id',
  phone: 'wa_number',
  name: 'LOWER(r.name)',
  age: 'r.age',
  gender: 'r.gender',
  occupation: 'LOWER(r.occupation)',
  voice_notes: 'voice_note_count',
  reminder: 'r.reminder_offsets',
  consent: 'r.consent_status',
  step: 'r.registration_step',
  registered: 'r.registered_at',
};

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(readSession);
app.use((req, res, next) => {
  res.page = (view, data = {}) => {
    const viewData = { ...data, csrfToken: req.csrfToken };
    app.render(view, viewData, (err, body) => {
      if (err) return next(err);
      res.render('layout', { ...viewData, body });
    });
  };
  next();
});

app.get('/login', (req, res) => {
  res.render('login', { error: '', passwordUnsafe: !isPasswordSafe(), sessionSecretUnsafe: !isSessionSecretSafe() });
});

app.post('/login', (req, res) => {
  if (!isPasswordSafe()) return res.render('login', { error: 'Set DASHBOARD_PASSWORD yang kuat di .env.', passwordUnsafe: true, sessionSecretUnsafe: !isSessionSecretSafe() });
  if (!isSessionSecretSafe()) return res.render('login', { error: 'Set ADMIN_SESSION_SECRET minimal 32 karakter acak di .env.', passwordUnsafe: false, sessionSecretUnsafe: true });
  if (isRateLimited(req)) return res.status(429).render('login', { error: 'Terlalu banyak percobaan. Coba lagi nanti.', passwordUnsafe: false, sessionSecretUnsafe: false });
  if (req.body.password !== password) return res.render('login', { error: 'Password salah.', passwordUnsafe: false, sessionSecretUnsafe: false });
  clearRateLimit(req);
  setSession(req, res);
  res.redirect('/');
});

app.post('/logout', requireAuth, requireCsrf, (req, res) => {
  res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.redirect('/login');
});

app.get('/', requireAuth, (req, res) => {
  const stats = getOverviewStats();
  const feedbackPromptEnabled = isFeedbackPromptEnabled();
  const logs = db.prepare(`
    SELECT l.*, r.name, r.age, r.gender, r.occupation
    FROM research_logs l
    LEFT JOIN research_respondents r ON r.chat_id = l.chat_id
    ORDER BY l.created_at DESC
    LIMIT 100
  `).all().map(formatLog);
  const feedback = db.prepare(`
    SELECT f.*, r.name
    FROM research_feedback f
    LEFT JOIN research_respondents r ON r.chat_id = f.chat_id
    ORDER BY f.created_at DESC
    LIMIT 10
  `).all().map(formatFeedback);
  res.page('overview', {
    title: 'Overview',
    page: 'overview',
    stats,
    logs,
    feedback,
    feedbackPromptEnabled,
    fmt,
    success: req.query.success || '',
  });
});

app.post('/settings/feedback-prompt', requireAuth, requireCsrf, (req, res) => {
  const enabled = req.body.enabled === 'true';
  setAppSetting('feedback_prompt_enabled', enabled ? 'true' : 'false');
  res.redirect('/?success=' + encodeURIComponent(enabled ? 'Mode saran dinyalakan' : 'Mode saran dimatikan'));
});

app.get('/review', requireAuth, (req, res) => {
  const status = req.query.status || 'pending_review';
  const where = status === 'all' ? '' : 'WHERE l.status = @status';
  const logs = db.prepare(`
    SELECT l.*, r.name, r.respondent_id
    FROM research_logs l
    LEFT JOIN research_respondents r ON r.chat_id = l.chat_id
    ${where}
    ORDER BY l.created_at DESC
    LIMIT 200
  `).all({ status }).map(formatLog);
  const selected = req.query.id ? hydrateReviewLog(Number(req.query.id)) : (logs[0] ? hydrateReviewLog(logs[0].id) : null);
  res.page('review', { title: 'Review', page: 'review', status, logs, selected, fmt, error: req.query.error || '', success: req.query.success || '' });
});

app.post('/review/:id', requireAuth, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  const row = getResearchLog(id);
  if (!row) return res.redirect('/review?error=Data tidak ditemukan');
  try {
    const gtTasks = normalizeTasksFromBody(req.body);
    validateGroundTruthTasks(gtTasks);
    const transcriptGroundTruth = String(req.body.transcript_ground_truth || '').trim();
    const wer = calculateWer(transcriptGroundTruth, row.transcript_whisper || '');
    const extraction = calculateExtractionMetrics(parseJsonList(row.extracted_tasks), gtTasks);
    updateResearchLog(id, {
      transcriptGroundTruth,
      groundTruthTasks: gtTasks,
      werScore: wer.wer,
      precisionScore: extraction.precision,
      recallScore: extraction.recall,
      f1Score: extraction.f1,
      status: 'reviewed',
    });
    res.redirect(`/review?id=${id}&success=Review tersimpan`);
  } catch (err) {
    res.redirect(`/review?id=${id}&error=${encodeURIComponent(err.message)}`);
  }
});

app.post('/review/:id/ai-suggest', requireAuth, requireCsrf, async (req, res) => {
  if (isAiSuggestRateLimited(req)) {
    return res.status(429).json({ error: 'Terlalu banyak auto-fill AI. Coba lagi nanti.' });
  }

  const id = Number(req.params.id);
  const row = getResearchLog(id);
  if (!row) return res.status(404).json({ error: 'Data tidak ditemukan' });

  const openaiKey = env.OPENAI_API_KEY;
  if (!openaiKey) return res.status(400).json({ error: 'OPENAI_API_KEY belum dikonfigurasi' });

  const audioFile = safeAudioPath(row.audio_filename);
  if (!audioFile) return res.status(400).json({ error: 'File audio tidak ditemukan, tidak bisa review otomatis.' });

  try {
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: openaiKey });
    const today = dayjs().format('YYYY-MM-DD');

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFile),
      model: 'whisper-1',
      language: 'id',
      response_format: 'text',
    });
    const transcriptGroundTruth = String(transcription).trim();

    const system = `Kamu adalah anotator penelitian NLP bahasa Indonesia.
Ekstrak semua tugas/reminder dari transcript berikut -> hasilkan array "tasks".

Aturan:
- Tanggal referensi hari ini: ${today} (zona waktu WIB, UTC+7)
- Jam default: pagi=09:00, siang=13:00, sore=17:00, malam=21:00
- Format tanggal: YYYY-MM-DD, format jam: HH:mm

Output wajib JSON (tidak ada teks lain):
{"tasks":[{"title":"...","date":"YYYY-MM-DD","time":"HH:mm"}]}`;

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: transcriptGroundTruth },
      ],
    });

    const parsed = JSON.parse(resp.choices[0].message.content || '{}');
    if (!Array.isArray(parsed.tasks)) throw new Error('Output AI tidak valid');

    res.json({ transcriptGroundTruth, tasks: normalizeAiSuggestedTasks(parsed.tasks) });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Gagal memanggil AI' });
  }
});

app.post('/review/:id/exclude', requireAuth, requireCsrf, (req, res) => {
  updateResearchLog(Number(req.params.id), { status: 'excluded' });
  res.redirect('/review?success=Data di-exclude');
});

app.get('/audio/:filename', requireAuth, (req, res) => {
  const file = safeAudioPath(req.params.filename);
  if (!file) return res.status(404).send('Audio tidak ditemukan');
  res.type('audio/wav').sendFile(file);
});

app.get('/respondents', requireAuth, (req, res) => {
  const sort = Object.prototype.hasOwnProperty.call(RESPONDENT_SORTS, req.query.sort) ? req.query.sort : 'registered';
  const dir = req.query.dir === 'asc' ? 'asc' : 'desc';
  const milestoneChatIds = getFirstTenVoiceNoteMilestoneChatIds();
  const respondents = listRespondentsForAdmin(sort, dir).map((row) => formatRespondent({
    ...row,
    reachedTenVoiceNoteMilestone: milestoneChatIds.has(row.chat_id),
  }));
  res.page('respondents', {
    title: 'Respondents',
    page: 'respondents',
    respondents,
    sort,
    dir,
    fmt,
    error: req.query.error || '',
    success: req.query.success || '',
  });
});

app.get('/respondents/:id/edit', requireAuth, (req, res) => {
  const respondent = db.prepare('SELECT * FROM research_respondents WHERE respondent_id = ?').get(req.params.id);
  if (!respondent) return res.redirect('/respondents?error=' + encodeURIComponent('Respondent tidak ditemukan'));
  res.page('respondent-edit', { title: 'Edit Respondent', page: 'respondents', respondent: formatRespondent(respondent), error: req.query.error || '', success: req.query.success || '' });
});

app.post('/respondents/:id/edit', requireAuth, requireCsrf, (req, res) => {
  const respondent = db.prepare('SELECT * FROM research_respondents WHERE respondent_id = ?').get(req.params.id);
  if (!respondent) return res.redirect('/respondents?error=' + encodeURIComponent('Respondent tidak ditemukan'));
  const updates = {};
  const name = String(req.body.name || '').trim();
  const age = Number(req.body.age);
  const gender = String(req.body.gender || '').trim();
  const occupation = String(req.body.occupation || '').trim();
  const consentStatus = String(req.body.consent_status || '').trim();
  const registrationStep = String(req.body.registration_step || '').trim();
  if (name) updates.name = name;
  if (Number.isInteger(age) && age >= 10 && age <= 100) updates.age = age;
  if (VALID_GENDERS.has(gender)) updates.gender = gender;
  if (occupation) updates.occupation = occupation;
  updates.reminderOffsets = JSON.stringify(['m10', 'due']);
  if (VALID_CONSENT_STATUSES.has(consentStatus)) updates.consentStatus = consentStatus;
  if (VALID_REGISTRATION_STEPS.has(registrationStep)) updates.registrationStep = registrationStep;
  updateRespondent(respondent.chat_id, updates);
  res.redirect('/respondents/' + req.params.id + '/edit?success=' + encodeURIComponent('Data disimpan'));
});

app.post('/respondents/:id/delete', requireAuth, requireCsrf, (req, res) => {
  const respondent = db.prepare('SELECT * FROM research_respondents WHERE respondent_id = ?').get(req.params.id);
  if (!respondent) return res.redirect('/respondents?error=' + encodeURIComponent('Respondent tidak ditemukan'));
  const audioFilenames = deleteRespondentData(respondent.chat_id);
  deleteResearchAudioFiles(audioFilenames);
  res.redirect('/respondents?success=' + encodeURIComponent('Respondent dan semua datanya dihapus'));
});

app.post('/logs/:id/delete', requireAuth, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  const row = getResearchLog(id);
  if (!row) return res.redirect('/review?error=' + encodeURIComponent('Log tidak ditemukan'));
  if (row.audio_filename) deleteResearchAudioFiles([row.audio_filename]);
  db.prepare('DELETE FROM research_logs WHERE id = ?').run(id);
  res.redirect('/review?success=' + encodeURIComponent('Log dihapus permanen'));
});

app.get('/export', requireAuth, (req, res) => {
  const logs = db.prepare(`
    SELECT l.*, r.respondent_id, r.name, r.age, r.gender, r.occupation
    FROM research_logs l
    LEFT JOIN research_respondents r ON r.chat_id = l.chat_id
    ORDER BY l.created_at DESC
  `).all();
  const summary = getRespondentSummary();
  res.page('export', { title: 'Export', page: 'export', logs: logs.map(formatLog), summary, fmt });
});

app.get('/export/research-logs.csv', requireAuth, (req, res) => {
  if (req.query.confirm !== 'pii') {
    return res.status(400).send('Export raw berisi PII. Ulangi dari halaman Export dan centang konfirmasi.');
  }
  const rows = db.prepare(`
    SELECT l.*, r.respondent_id, r.name, r.age, r.gender, r.occupation
    FROM research_logs l
    LEFT JOIN research_respondents r ON r.chat_id = l.chat_id
    ORDER BY l.created_at DESC
  `).all();
  sendCsv(res, 'research_logs.csv', rows);
});

app.get('/export/respondent-summary.csv', requireAuth, (req, res) => {
  sendCsv(res, 'respondent_summary.csv', getRespondentSummary());
});

app.listen(port, () => {
  console.log(`Admin dashboard: http://localhost:${port}`);
});

function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return null;
    const [key, ...rest] = trimmed.split('=');
    return [key.trim(), rest.join('=').trim()];
  }).filter(Boolean));
}

function isPasswordSafe() {
  return password && password !== 'change-this-password' && password.length >= 8;
}

function isSessionSecretSafe() {
  return env.ADMIN_SESSION_SECRET
    && env.ADMIN_SESSION_SECRET !== 'change-this-secret'
    && !env.ADMIN_SESSION_SECRET.startsWith('replace-with-')
    && env.ADMIN_SESSION_SECRET.length >= 32;
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function setSession(req, res) {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + SESSION_TTL_MS,
    csrf: crypto.randomBytes(24).toString('hex'),
    nonce: crypto.randomBytes(16).toString('hex'),
  })).toString('base64url');
  const secure = shouldUseSecureCookie(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `admin_session=${payload}.${sign(payload)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

function shouldUseSecureCookie(req) {
  if (env.ADMIN_COOKIE_SECURE === 'true') return true;
  if (env.ADMIN_COOKIE_SECURE === 'false') return false;
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function readSession(req, res, next) {
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => part.trim().split('=')));
  const raw = cookies.admin_session || '';
  const [value, signature] = raw.split('.');
  req.isAuthenticated = false;
  req.csrfToken = '';
  if (isSessionSecretSafe() && value && signature && safeEqual(sign(value), signature)) {
    try {
      const session = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      if (Number(session.exp) > Date.now()) {
        req.isAuthenticated = true;
        req.csrfToken = session.csrf || '';
      }
    } catch {
      req.isAuthenticated = false;
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.isAuthenticated) return res.redirect('/login');
  next();
}

function requireCsrf(req, res, next) {
  if (!req.csrfToken || req.body.csrf_token !== req.csrfToken) {
    return res.status(403).send('CSRF token tidak valid.');
  }
  next();
}

function clientKey(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function isRateLimited(req) {
  const key = clientKey(req);
  const now = Date.now();
  const item = loginAttempts.get(key) || { count: 0, firstAt: now };
  if (now - item.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAt: now });
    return false;
  }
  item.count += 1;
  loginAttempts.set(key, item);
  return item.count > LOGIN_MAX_ATTEMPTS;
}

function clearRateLimit(req) {
  loginAttempts.delete(clientKey(req));
}

function isAiSuggestRateLimited(req) {
  const key = `ai:${clientKey(req)}`;
  const now = Date.now();
  const item = aiSuggestAttempts.get(key) || { count: 0, firstAt: now };
  if (now - item.firstAt > AI_SUGGEST_WINDOW_MS) {
    aiSuggestAttempts.set(key, { count: 1, firstAt: now });
    return false;
  }
  item.count += 1;
  aiSuggestAttempts.set(key, item);
  return item.count > AI_SUGGEST_MAX_ATTEMPTS;
}

function getOverviewStats() {
  return db.prepare(`
    SELECT
      COUNT(*) total,
      SUM(status = 'reviewed') reviewed,
      SUM(status = 'pending_review') pending,
      SUM(status = 'excluded') excluded,
      AVG(CASE WHEN wer_score >= 0 THEN wer_score END) avg_wer,
      AVG(CASE WHEN precision_score >= 0 THEN precision_score END) avg_precision,
      AVG(CASE WHEN recall_score >= 0 THEN recall_score END) avg_recall,
      AVG(CASE WHEN f1_score >= 0 THEN f1_score END) avg_f1
    FROM research_logs
  `).get();
}

function hydrateReviewLog(id) {
  const row = db.prepare(`
    SELECT l.*, r.name, r.respondent_id, r.age, r.gender, r.occupation
    FROM research_logs l
    LEFT JOIN research_respondents r ON r.chat_id = l.chat_id
    WHERE l.id = ?
  `).get(id);
  if (!row) return null;
  return { ...formatLog(row), extracted: parseJsonList(row.extracted_tasks), groundTruth: parseJsonList(row.ground_truth_tasks) };
}

function normalizeTasksFromBody(body) {
  const titles = Array.isArray(body.task_title) ? body.task_title : [body.task_title];
  const dates = Array.isArray(body.task_date) ? body.task_date : [body.task_date];
  const times = Array.isArray(body.task_time) ? body.task_time : [body.task_time];
  return titles.map((title, idx) => ({
    title: String(title || '').trim(),
    date: String(dates[idx] || '').trim(),
    time: String(times[idx] || '').trim(),
  })).filter((task) => task.title || task.date || task.time);
}

function normalizeAiSuggestedTasks(tasks) {
  return tasks.map((task) => {
    const deadline = String(task.deadline_iso || task.deadline || '');
    const deadlineMatch = deadline.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
    return {
      title: String(task.title || task.name || '').trim(),
      date: String(task.date || deadlineMatch?.[1] || '').trim(),
      time: String(task.time || deadlineMatch?.[2] || '').trim().slice(0, 5),
    };
  }).filter((task) => task.title || task.date || task.time);
}

function deleteResearchAudioFiles(audioFilenames) {
  for (const filename of audioFilenames) {
    if (!/^vn-[A-Za-z0-9-]+\.wav$/.test(filename)) continue;
    const filePath = path.join(audioDir, filename);
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
  }
}

function safeAudioPath(filename) {
  const name = path.basename(String(filename || ''));
  if (!/^vn-[A-Za-z0-9-]+\.wav$/.test(name)) return null;
  const file = path.resolve(audioDir, name);
  const relative = path.relative(audioDir, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(file)) return null;
  return file;
}

function formatLog(row) {
  const audioExists = Boolean(safeAudioPath(row.audio_filename));
  return { ...row, audioExists, createdText: fmt.date(row.created_at) };
}

function formatRespondent(row) {
  return {
    ...row,
    waNumber: formatWhatsAppNumber(row.chat_id),
    registeredText: row.registered_at ? fmt.date(row.registered_at) : '-',
    reminderText: fmt.reminders(row.reminder_offsets),
  };
}

function formatWhatsAppNumber(chatId) {
  const digits = String(chatId || '').split('@')[0].replace(/\D/g, '');
  return digits || '-';
}

function formatFeedback(row) {
  return {
    ...row,
    createdText: fmt.date(row.created_at),
  };
}

function listRespondentsForAdmin(sort, dir) {
  const sortExpr = RESPONDENT_SORTS[sort] || RESPONDENT_SORTS.registered;
  const sortDir = dir === 'asc' ? 'ASC' : 'DESC';
  return db.prepare(`
    SELECT
      r.*,
      REPLACE(SUBSTR(r.chat_id, 1, INSTR(r.chat_id || '@', '@') - 1), '+', '') AS wa_number,
      COUNT(l.id) AS voice_note_count,
      MAX(l.created_at) AS last_voice_note_at
    FROM research_respondents r
    LEFT JOIN research_logs l ON l.chat_id = r.chat_id
    GROUP BY r.chat_id
    ORDER BY ${sortExpr} ${sortDir}, r.respondent_id ASC
  `).all();
}

function getFirstTenVoiceNoteMilestoneChatIds() {
  const rows = db.prepare(`
    SELECT chat_id, created_at
    FROM research_logs
    ORDER BY created_at ASC, id ASC
  `).all();
  const counts = new Map();
  const milestones = [];
  for (const row of rows) {
    const nextCount = (counts.get(row.chat_id) || 0) + 1;
    counts.set(row.chat_id, nextCount);
    if (nextCount === 10) {
      milestones.push({ chatId: row.chat_id, reachedAt: row.created_at });
    }
  }
  milestones.sort((a, b) => a.reachedAt - b.reachedAt);
  return new Set(milestones.slice(0, 10).map((item) => item.chatId));
}

function getRespondentSummary() {
  return db.prepare(`
    SELECT
      r.respondent_id,
      r.name,
      r.age,
      r.gender,
      r.occupation,
      r.reminder_offsets,
      COUNT(l.id) total_logs,
      AVG(CASE WHEN l.wer_score >= 0 THEN l.wer_score END) avg_wer,
      AVG(CASE WHEN l.precision_score >= 0 THEN l.precision_score END) avg_precision,
      AVG(CASE WHEN l.recall_score >= 0 THEN l.recall_score END) avg_recall,
      AVG(CASE WHEN l.f1_score >= 0 THEN l.f1_score END) avg_f1
    FROM research_respondents r
    LEFT JOIN research_logs l ON l.chat_id = r.chat_id
    GROUP BY r.chat_id
    ORDER BY r.respondent_id
  `).all();
}

function sendCsv(res, filename, rows) {
  const csv = toCsv(rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

function toCsv(rows) {
  if (!rows.length) return '';
  const columns = Object.keys(rows[0]);
  const escape = (value) => {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [columns.join(','), ...rows.map((row) => columns.map((column) => escape(row[column])).join(','))].join('\n');
}

const fmt = {
  metric(value) {
    return value == null || value < 0 ? '-' : Number(value).toFixed(3);
  },
  date(value) {
    return value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-';
  },
  reminders(value) {
    const labels = {
      d7: 'H-7',
      d3: 'H-3',
      d1: 'H-1',
      h1: 'H-1 jam',
      m30: 'H-30 menit',
      m10: 'H-10 menit',
      due: 'Saat deadline',
    };
    try {
      const keys = JSON.parse(value || '[]');
      const activeKeys = Array.isArray(keys) && keys.length ? keys : ['m10', 'due'];
      return activeKeys.map((key) => labels[key] || key).join(', ');
    } catch {
      return 'H-10 menit, Saat deadline';
    }
  },
};
