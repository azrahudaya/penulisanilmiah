import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(config.dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  title TEXT NOT NULL,
  deadline_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  missed_notified_at INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS research_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  respondent_id TEXT DEFAULT '',
  audio_filename TEXT DEFAULT '',
  audio_duration_ms INTEGER DEFAULT 0,
  transcript_whisper TEXT DEFAULT '',
  transcript_ground_truth TEXT DEFAULT '',
  gpt_raw_response TEXT DEFAULT '',
  extracted_tasks TEXT DEFAULT '[]',
  ground_truth_tasks TEXT DEFAULT '[]',
  wer_score REAL DEFAULT -1,
  precision_score REAL DEFAULT -1,
  recall_score REAL DEFAULT -1,
  f1_score REAL DEFAULT -1,
  processing_time_stt_ms INTEGER DEFAULT 0,
  processing_time_nlu_ms INTEGER DEFAULT 0,
  processing_time_total_ms INTEGER DEFAULT 0,
  confirmation_status TEXT DEFAULT 'pending_confirmation',
  consent_status TEXT DEFAULT 'unconfirmed',
  status TEXT DEFAULT 'pending_review',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS research_respondents (
  chat_id TEXT PRIMARY KEY,
  respondent_id TEXT NOT NULL,
  name TEXT DEFAULT '',
  age INTEGER DEFAULT 0,
  gender TEXT DEFAULT '',
  occupation TEXT DEFAULT '',
  reminder_offsets TEXT DEFAULT '["m10","due"]',
  consent_status TEXT DEFAULT 'unconfirmed',
  registration_step TEXT DEFAULT 'not_started',
  gender_poll_message_id TEXT DEFAULT '',
  reminder_poll_message_id TEXT DEFAULT '',
  consent_poll_message_id TEXT DEFAULT '',
  feedback_pending INTEGER DEFAULT 0,
  feedback_prompted_at INTEGER DEFAULT 0,
  feedback_prompt_sent INTEGER DEFAULT 0,
  registered_at INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS research_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  respondent_id TEXT DEFAULT '',
  voice_note_count INTEGER DEFAULT 0,
  feedback_text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_confirmations (
  chat_id TEXT PRIMARY KEY,
  tasks TEXT NOT NULL,
  transcript TEXT DEFAULT '',
  research_log_id INTEGER,
  poll_message_id TEXT DEFAULT '',
  confirmation_channel TEXT DEFAULT 'text',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_research_respondents_respondent_id
ON research_respondents(respondent_id);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('research_logs', 'processing_time_total_ms', "INTEGER DEFAULT 0");
ensureColumn('research_logs', 'confirmation_status', "TEXT DEFAULT 'pending_confirmation'");
ensureColumn('research_logs', 'consent_status', "TEXT DEFAULT 'unconfirmed'");
ensureColumn('tasks', 'missed_notified_at', "INTEGER DEFAULT 0");
ensureColumn('research_respondents', 'consent_status', "TEXT DEFAULT 'unconfirmed'");
ensureColumn('research_respondents', 'name', "TEXT DEFAULT ''");
ensureColumn('research_respondents', 'age', "INTEGER DEFAULT 0");
ensureColumn('research_respondents', 'gender', "TEXT DEFAULT ''");
ensureColumn('research_respondents', 'occupation', "TEXT DEFAULT ''");
ensureColumn('research_respondents', 'reminder_offsets', 'TEXT DEFAULT \'["m10","due"]\'');
ensureColumn('research_respondents', 'registration_step', "TEXT DEFAULT 'not_started'");
ensureColumn('research_respondents', 'gender_poll_message_id', "TEXT DEFAULT ''");
ensureColumn('research_respondents', 'reminder_poll_message_id', "TEXT DEFAULT ''");
ensureColumn('research_respondents', 'consent_poll_message_id', "TEXT DEFAULT ''");
ensureColumn('research_respondents', 'feedback_pending', "INTEGER DEFAULT 0");
ensureColumn('research_respondents', 'feedback_prompted_at', "INTEGER DEFAULT 0");
ensureColumn('research_respondents', 'feedback_prompt_sent', "INTEGER DEFAULT 0");
ensureColumn('research_respondents', 'registered_at', "INTEGER DEFAULT 0");
ensureColumn('pending_confirmations', 'poll_message_id', "TEXT DEFAULT ''");
ensureColumn('pending_confirmations', 'confirmation_channel', "TEXT DEFAULT 'text'");

db.prepare(`
  INSERT INTO app_settings (key, value, updated_at)
  VALUES ('feedback_prompt_enabled', 'true', ?)
  ON CONFLICT(key) DO NOTHING
`).run(Date.now());

db.prepare(`
  INSERT INTO app_settings (key, value, updated_at)
  VALUES ('registration_enabled', 'true', ?)
  ON CONFLICT(key) DO NOTHING
`).run(Date.now());

export function isRegistrationEnabled() {
  return getAppSetting('registration_enabled', 'true') === 'true';
}

export function insertTask({ chatId, title, deadlineMs }) {
  const now = Date.now();
  const stmt = db.prepare(`INSERT INTO tasks (chat_id, title, deadline_ms, status, created_at, updated_at)
    VALUES (@chatId, @title, @deadlineMs, 'pending', @now, @now)`);
  const info = stmt.run({ chatId, title, deadlineMs, now });
  return getTask(info.lastInsertRowid);
}

export function insertTasks(tasks) {
  return db.transaction((items) => items.map((task) => insertTask(task)))(tasks);
}

export function listTasks(chatId, { includeDone = false, includeOverdue = false } = {}) {
  if (includeDone) {
    return db.prepare('SELECT * FROM tasks WHERE chat_id = ? ORDER BY deadline_ms').all(chatId);
  }
  if (!includeOverdue) {
    return db.prepare("SELECT * FROM tasks WHERE chat_id = ? AND status = 'pending' AND deadline_ms > ? ORDER BY deadline_ms")
      .all(chatId, Date.now());
  }
  return db.prepare("SELECT * FROM tasks WHERE chat_id = ? AND status = 'pending' ORDER BY deadline_ms").all(chatId);
}

export function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

export function markDone(id, chatId) {
  const now = Date.now();
  const info = db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ? AND chat_id = ?").run(now, id, chatId);
  return info.changes > 0;
}

export function deleteTask(id, chatId) {
  const info = db.prepare('DELETE FROM tasks WHERE id = ? AND chat_id = ?').run(id, chatId);
  return info.changes > 0;
}

export function rescheduleTask(id, chatId, newDeadlineMs) {
  const now = Date.now();
  const info = db.prepare('UPDATE tasks SET deadline_ms = ?, missed_notified_at = 0, updated_at = ? WHERE id = ? AND chat_id = ?')
    .run(newDeadlineMs, now, id, chatId);
  return info.changes > 0;
}

export function listPendingForScheduling(afterMs = Date.now()) {
  return db.prepare("SELECT * FROM tasks WHERE status = 'pending' AND deadline_ms > ?").all(afterMs);
}

export function listUnnotifiedOverdueTasks(now = Date.now()) {
  return db.prepare(`
    SELECT *
    FROM tasks
    WHERE status = 'pending'
      AND deadline_ms <= ?
      AND COALESCE(missed_notified_at, 0) = 0
    ORDER BY chat_id, deadline_ms
  `).all(now);
}

export function markMissedNotified(taskIds, notifiedAt = Date.now()) {
  if (!taskIds.length) return 0;
  const stmt = db.prepare('UPDATE tasks SET missed_notified_at = ?, updated_at = ? WHERE id = ?');
  const tx = db.transaction((ids) => ids.reduce((count, id) => count + stmt.run(notifiedAt, notifiedAt, id).changes, 0));
  return tx(taskIds);
}

export function upsertPendingConfirmation({
  chatId,
  tasks,
  transcript = '',
  researchLogId = null,
  pollMessageId = '',
  confirmationChannel = 'text',
}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO pending_confirmations (
      chat_id, tasks, transcript, research_log_id, poll_message_id,
      confirmation_channel, created_at, updated_at
    )
    VALUES (
      @chatId, @tasks, @transcript, @researchLogId, @pollMessageId,
      @confirmationChannel, @now, @now
    )
    ON CONFLICT(chat_id) DO UPDATE SET
      tasks = excluded.tasks,
      transcript = excluded.transcript,
      research_log_id = excluded.research_log_id,
      poll_message_id = excluded.poll_message_id,
      confirmation_channel = excluded.confirmation_channel,
      updated_at = excluded.updated_at
  `).run({
    chatId,
    tasks: stringifyJsonField(tasks),
    transcript,
    researchLogId,
    pollMessageId,
    confirmationChannel,
    now,
  });
}

export function getPendingConfirmation(chatId) {
  const row = db.prepare('SELECT * FROM pending_confirmations WHERE chat_id = ?').get(chatId);
  if (!row) return null;
  try {
    return {
      chatId: row.chat_id,
      tasks: JSON.parse(row.tasks),
      transcript: row.transcript,
      researchLogId: row.research_log_id,
      pollMessageId: row.poll_message_id,
      confirmationChannel: row.confirmation_channel,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

export function getPendingConfirmationByPollMessageId(pollMessageId) {
  // Coba exact match (bare ID format baru), lalu LIKE suffix (full _serialized format lama)
  let row = db.prepare('SELECT chat_id FROM pending_confirmations WHERE poll_message_id = ?').get(pollMessageId);
  if (!row) {
    row = db.prepare("SELECT chat_id FROM pending_confirmations WHERE poll_message_id LIKE '%_' || ?").get(pollMessageId);
  }
  if (!row) return null;
  return getPendingConfirmation(row.chat_id);
}

export function listAllPendingConfirmations() {
  return db.prepare('SELECT * FROM pending_confirmations').all().map((row) => ({
    chatId: row.chat_id,
    pollMessageId: row.poll_message_id || '',
  }));
}

export function deletePendingConfirmation(chatId) {
  db.prepare('DELETE FROM pending_confirmations WHERE chat_id = ?').run(chatId);
}

export function deleteExpiredPendingConfirmations(maxAgeMs, now = Date.now()) {
  return db.transaction((cutoff) => {
    const expired = db.prepare('SELECT research_log_id FROM pending_confirmations WHERE created_at < ?').all(cutoff);
    const markExpired = db.prepare("UPDATE research_logs SET confirmation_status = 'expired' WHERE id = ? AND confirmation_status = 'pending_confirmation'");
    for (const row of expired) if (row.research_log_id) markExpired.run(row.research_log_id);
    return db.prepare('DELETE FROM pending_confirmations WHERE created_at < ?').run(cutoff).changes;
  })(now - maxAgeMs);
}

function stringifyJsonField(value, fallback = '[]') {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function getRespondentForChat(chatId) {
  const row = db.prepare('SELECT respondent_id, consent_status FROM research_respondents WHERE chat_id = ?').get(chatId);
  return {
    respondentId: row?.respondent_id || '',
    consentStatus: row?.consent_status || 'unconfirmed',
  };
}

function generateRespondentId() {
  const row = db.prepare(`
    SELECT respondent_id
    FROM research_respondents
    WHERE respondent_id LIKE 'R%'
    ORDER BY CAST(SUBSTR(respondent_id, 2) AS INTEGER) DESC
    LIMIT 1
  `).get();
  const last = Number(String(row?.respondent_id || 'R00').slice(1)) || 0;
  return `R${String(last + 1).padStart(2, '0')}`;
}

export function getRespondent(chatId) {
  return db.prepare('SELECT * FROM research_respondents WHERE chat_id = ?').get(chatId);
}

export function startRespondentRegistration(chatId) {
  const tx = db.transaction(() => {
    const now = Date.now();
    const existing = getRespondent(chatId);
    const respondentId = existing?.respondent_id || generateRespondentId();
    db.prepare(`
      INSERT INTO research_respondents (
        chat_id, respondent_id, consent_status, registration_step,
        created_at, updated_at
      ) VALUES (
        @chatId, @respondentId, 'unconfirmed', 'consent',
        @now, @now
      )
      ON CONFLICT(chat_id) DO UPDATE SET
        name = '',
        age = 0,
        gender = '',
        occupation = '',
        consent_status = 'unconfirmed',
        registration_step = 'consent',
        gender_poll_message_id = '',
        reminder_poll_message_id = '',
        consent_poll_message_id = '',
        reminder_offsets = '["m10","due"]',
        feedback_pending = 0,
        feedback_prompted_at = 0,
        feedback_prompt_sent = 0,
        registered_at = 0,
        updated_at = excluded.updated_at
    `).run({ chatId, respondentId, now });
  });
  tx();
  return getRespondent(chatId);
}

export function updateRespondent(chatId, updates = {}) {
  const allowed = {
    respondentId: 'respondent_id',
    name: 'name',
    age: 'age',
    gender: 'gender',
    occupation: 'occupation',
    reminderOffsets: 'reminder_offsets',
    consentStatus: 'consent_status',
    registrationStep: 'registration_step',
    genderPollMessageId: 'gender_poll_message_id',
    reminderPollMessageId: 'reminder_poll_message_id',
    consentPollMessageId: 'consent_poll_message_id',
    registeredAt: 'registered_at',
    feedbackPending: 'feedback_pending',
    feedbackPromptedAt: 'feedback_prompted_at',
    feedbackPromptSent: 'feedback_prompt_sent',
  };
  const sets = [];
  const params = { chatId, updatedAt: Date.now() };
  for (const [key, column] of Object.entries(allowed)) {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    sets.push(`${column} = @${key}`);
    params[key] = updates[key];
  }
  sets.push('updated_at = @updatedAt');
  db.prepare(`UPDATE research_respondents SET ${sets.join(', ')} WHERE chat_id = @chatId`).run(params);
  return getRespondent(chatId);
}

export function getRespondentByRegistrationPollMessageId(pollMessageId) {
  // Coba exact match dulu, lalu LIKE suffix untuk format lama (full _serialized)
  let row = db.prepare(`
    SELECT * FROM research_respondents
    WHERE gender_poll_message_id = ?1 OR reminder_poll_message_id = ?1 OR consent_poll_message_id = ?1
  `).get(pollMessageId);
  if (!row) {
    row = db.prepare(`
      SELECT * FROM research_respondents
      WHERE gender_poll_message_id LIKE '%_' || ?1
        OR reminder_poll_message_id LIKE '%_' || ?1
        OR consent_poll_message_id LIKE '%_' || ?1
    `).get(pollMessageId);
  }
  return row || null;
}

export function listRespondents() {
  return db.prepare('SELECT * FROM research_respondents ORDER BY created_at DESC').all();
}

export function deleteRespondentData(chatId) {
  const tx = db.transaction(() => {
    const audioRows = db.prepare("SELECT audio_filename FROM research_logs WHERE chat_id = ? AND audio_filename != ''").all(chatId);
    db.prepare('DELETE FROM pending_confirmations WHERE chat_id = ?').run(chatId);
    db.prepare('DELETE FROM tasks WHERE chat_id = ?').run(chatId);
    db.prepare('DELETE FROM research_feedback WHERE chat_id = ?').run(chatId);
    db.prepare('DELETE FROM research_logs WHERE chat_id = ?').run(chatId);
    db.prepare('DELETE FROM research_respondents WHERE chat_id = ?').run(chatId);
    return audioRows.map((row) => row.audio_filename).filter(Boolean);
  });
  return tx();
}

export function getReminderOffsetsForChat(chatId) {
  const row = db.prepare('SELECT reminder_offsets FROM research_respondents WHERE chat_id = ?').get(chatId);
  if (!row?.reminder_offsets) return null;
  try {
    const parsed = JSON.parse(row.reminder_offsets);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function getAppSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row?.value ?? fallback;
}

export function setAppSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (@key, @value, @updatedAt)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run({ key, value: String(value), updatedAt: Date.now() });
}

export function isFeedbackPromptEnabled() {
  return getAppSetting('feedback_prompt_enabled', 'true') === 'true';
}

export function countResearchLogsByChat(chatId) {
  const row = db.prepare('SELECT COUNT(*) AS total FROM research_logs WHERE chat_id = ?').get(chatId);
  return Number(row?.total || 0);
}

export function insertResearchFeedback({ chatId, feedbackText, voiceNoteCount = 0, createdAt = Date.now() }) {
  const mappedRespondent = getRespondentForChat(chatId);
  const info = db.prepare(`
    INSERT INTO research_feedback (
      chat_id, respondent_id, voice_note_count, feedback_text, created_at
    ) VALUES (
      @chatId, @respondentId, @voiceNoteCount, @feedbackText, @createdAt
    )
  `).run({
    chatId,
    respondentId: mappedRespondent.respondentId,
    voiceNoteCount,
    feedbackText,
    createdAt,
  });
  return db.prepare('SELECT * FROM research_feedback WHERE id = ?').get(info.lastInsertRowid);
}

export function insertResearchLog({
  chatId,
  respondentId,
  audioFilename = '',
  audioDurationMs = 0,
  transcriptWhisper = '',
  transcriptGroundTruth = '',
  gptRawResponse = '',
  extractedTasks = [],
  groundTruthTasks = [],
  werScore = -1,
  precisionScore = -1,
  recallScore = -1,
  f1Score = -1,
  processingTimeSttMs = 0,
  processingTimeNluMs = 0,
  processingTimeTotalMs = 0,
  confirmationStatus = 'pending_confirmation',
  consentStatus = 'unconfirmed',
  status = 'pending_review',
  createdAt = Date.now(),
}) {
  const mappedRespondent = getRespondentForChat(chatId);
  const mappedRespondentId = respondentId ?? mappedRespondent.respondentId;
  const mappedConsentStatus = consentStatus === 'unconfirmed' ? mappedRespondent.consentStatus : consentStatus;
  const stmt = db.prepare(`
    INSERT INTO research_logs (
      chat_id, respondent_id, audio_filename, audio_duration_ms,
      transcript_whisper, transcript_ground_truth, gpt_raw_response,
      extracted_tasks, ground_truth_tasks, wer_score, precision_score,
      recall_score, f1_score, processing_time_stt_ms, processing_time_nlu_ms,
      processing_time_total_ms, confirmation_status, consent_status,
      status, created_at
    ) VALUES (
      @chatId, @respondentId, @audioFilename, @audioDurationMs,
      @transcriptWhisper, @transcriptGroundTruth, @gptRawResponse,
      @extractedTasks, @groundTruthTasks, @werScore, @precisionScore,
      @recallScore, @f1Score, @processingTimeSttMs, @processingTimeNluMs,
      @processingTimeTotalMs, @confirmationStatus, @consentStatus,
      @status, @createdAt
    )
  `);
  const info = stmt.run({
    chatId,
    respondentId: mappedRespondentId,
    audioFilename,
    audioDurationMs,
    transcriptWhisper,
    transcriptGroundTruth,
    gptRawResponse,
    extractedTasks: stringifyJsonField(extractedTasks),
    groundTruthTasks: stringifyJsonField(groundTruthTasks),
    werScore,
    precisionScore,
    recallScore,
    f1Score,
    processingTimeSttMs,
    processingTimeNluMs,
    processingTimeTotalMs,
    confirmationStatus,
    consentStatus: mappedConsentStatus,
    status,
    createdAt,
  });
  return getResearchLog(info.lastInsertRowid);
}

export function getResearchLog(id) {
  return db.prepare('SELECT * FROM research_logs WHERE id = ?').get(id);
}

export function updateResearchLog(id, updates = {}) {
  const allowed = {
    chatId: 'chat_id',
    respondentId: 'respondent_id',
    audioFilename: 'audio_filename',
    audioDurationMs: 'audio_duration_ms',
    transcriptWhisper: 'transcript_whisper',
    transcriptGroundTruth: 'transcript_ground_truth',
    gptRawResponse: 'gpt_raw_response',
    extractedTasks: 'extracted_tasks',
    groundTruthTasks: 'ground_truth_tasks',
    werScore: 'wer_score',
    precisionScore: 'precision_score',
    recallScore: 'recall_score',
    f1Score: 'f1_score',
    processingTimeSttMs: 'processing_time_stt_ms',
    processingTimeNluMs: 'processing_time_nlu_ms',
    processingTimeTotalMs: 'processing_time_total_ms',
    confirmationStatus: 'confirmation_status',
    consentStatus: 'consent_status',
    status: 'status',
    createdAt: 'created_at',
  };
  const sets = [];
  const params = { id };
  for (const [key, column] of Object.entries(allowed)) {
    if (!Object.prototype.hasOwnProperty.call(updates, key)) continue;
    const value = ['extractedTasks', 'groundTruthTasks'].includes(key)
      ? stringifyJsonField(updates[key])
      : updates[key];
    sets.push(`${column} = @${key}`);
    params[key] = value;
  }
  if (!sets.length) return getResearchLog(id);
  db.prepare(`UPDATE research_logs SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getResearchLog(id);
}

export function listResearchLogs({ status, chatId, respondentId, limit = 500, offset = 0 } = {}) {
  const where = [];
  const params = { limit, offset };
  if (status) {
    where.push('status = @status');
    params.status = status;
  }
  if (chatId) {
    where.push('chat_id = @chatId');
    params.chatId = chatId;
  }
  if (respondentId) {
    where.push('respondent_id = @respondentId');
    params.respondentId = respondentId;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM research_logs ${whereSql} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`).all(params);
}

export function getResearchStats() {
  return db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'reviewed' THEN 1 ELSE 0 END) AS reviewed,
      SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) AS pending_review,
      SUM(CASE WHEN status = 'excluded' THEN 1 ELSE 0 END) AS excluded,
      AVG(CASE WHEN wer_score >= 0 THEN wer_score END) AS avg_wer,
      AVG(CASE WHEN precision_score >= 0 THEN precision_score END) AS avg_precision,
      AVG(CASE WHEN recall_score >= 0 THEN recall_score END) AS avg_recall,
      AVG(CASE WHEN f1_score >= 0 THEN f1_score END) AS avg_f1
    FROM research_logs
  `).get();
}

export default db;
