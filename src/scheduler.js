import schedule from 'node-schedule';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { config } from './config.js';
import { getReminderOffsetsForChat, getTask } from './db.js';
import { logger } from './logger.js';

dayjs.extend(utc);
dayjs.extend(timezone);

// ── Escalation config ──────────────────────────────────────────────────────────
// After the "due" reminder fires, keep nudging if the task stays pending.
const MAX_ESCALATIONS = 3;
const ESCALATION_DELAYS_MS = [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];

// ── Send-time jitter ───────────────────────────────────────────────────────────
// Adds a random offset so reminders don't fire at the exact scheduled second.
// Helps avoid identical-timestamp fingerprinting by WhatsApp's anti-spam layer.
const JITTER_MS = 30_000; // ±30 seconds

// ── Message templates ──────────────────────────────────────────────────────────
const REMINDER_TEMPLATES = [
  (label, title, deadline) => `[${label}] "${title}" — ${deadline}`,
  (label, title, deadline) => `🔔 Pengingat ${label}: ${title}\n⏰ ${deadline}`,
  (label, title, deadline) => `Hei, waktunya!\n"${title}" — ${deadline} [${label}]`,
  (label, title, deadline) => `Reminder:\n${title}\n📅 ${deadline}`,
  (label, title, deadline) => `Jangan lupa: ${title}\n(${deadline}) [${label}]`,
];

const ESCALATION_TEMPLATES = [
  (title, deadline, n) => `📌 Pengingat ke-${n}: "${title}" belum selesai (${deadline})`,
  (title, deadline, n) => `Hei! "${title}" masih pending — deadline: ${deadline} ⏳`,
  (title, deadline, n) => `Follow-up ke-${n}: "${title}"\n⏰ ${deadline}`,
  (title, deadline, n) => `Masih ada yang belum selesai:\n"${title}" (${deadline})`,
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function jitter() {
  return Math.floor(Math.random() * 2 * JITTER_MS) - JITTER_MS;
}

function buildReminderText(label, title, deadline) {
  return pickRandom(REMINDER_TEMPLATES)(label, title, deadline);
}

function buildEscalationText(title, deadline, escalationIndex) {
  return pickRandom(ESCALATION_TEMPLATES)(title, deadline, escalationIndex + 1);
}

// ──────────────────────────────────────────────────────────────────────────────

const jobs = new Map();
export const REMINDER_OFFSET_OPTIONS = [
  { key: 'd7', label: 'H-7', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: 'd3', label: 'H-3', ms: 3 * 24 * 60 * 60 * 1000 },
  { key: 'd1', label: 'H-1', ms: 24 * 60 * 60 * 1000 },
  { key: 'h1', label: 'H-1 jam', ms: 60 * 60 * 1000 },
  { key: 'm30', label: 'H-30 menit', ms: 30 * 60 * 1000 },
  { key: 'm10', label: 'H-10 menit', ms: 10 * 60 * 1000 },
  { key: 'due', label: 'Saat deadline', ms: 0 },
];
export const DEFAULT_REMINDER_OFFSET_KEYS = ['m10', 'due'];

function formatDeadline(ms) {
  return dayjs(ms).tz(config.timezone).format('DD MMM YYYY HH:mm');
}

function getActiveOffsets(chatId) {
  const selectedKeys = getReminderOffsetsForChat(chatId);
  const activeKeys = selectedKeys?.length ? selectedKeys : DEFAULT_REMINDER_OFFSET_KEYS;
  const activeOffsets = REMINDER_OFFSET_OPTIONS.filter((offset) => activeKeys.includes(offset.key));
  return { activeKeys, activeOffsets };
}

export function getReminderSchedulePreview(task, now = Date.now()) {
  const { activeOffsets } = getActiveOffsets(task.chat_id);
  const items = activeOffsets
    .map((offset) => ({
      key: offset.key,
      label: offset.label,
      remindAt: task.deadline_ms - offset.ms,
    }))
    .filter((item) => item.remindAt > now)
    .sort((a, b) => a.remindAt - b.remindAt);

  if (!items.length && task.deadline_ms > now) {
    items.push({ key: 'due', label: 'Saat deadline', remindAt: task.deadline_ms });
  }
  return items;
}

export function cancelReminders(taskId) {
  const existing = jobs.get(taskId) || [];
  existing.forEach((j) => j.cancel());
  jobs.delete(taskId);
}

function addJob(taskId, job) {
  if (!job) return;
  const existing = jobs.get(taskId) || [];
  existing.push(job);
  jobs.set(taskId, existing);
}

async function sendReminderWithRetry(client, chatId, text, taskId) {
  const delays = [0, 10_000, 30_000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
    try {
      await client.sendMessage(chatId, text);
      return;
    } catch (err) {
      const isLast = i === delays.length - 1;
      if (isLast) {
        logger.error('Failed to send reminder after retries', { taskId, message: err.message });
      } else {
        logger.warn('Reminder gagal, retry...', { taskId, attempt: i + 1, message: err.message });
      }
    }
  }
}

function scheduleEscalation(task, client, escalationIndex) {
  if (escalationIndex >= MAX_ESCALATIONS) return;
  const delayMs = ESCALATION_DELAYS_MS[escalationIndex];
  // Positive jitter only so escalation never fires before its floor
  const fireAt = Date.now() + delayMs + Math.floor(Math.random() * JITTER_MS);
  const job = schedule.scheduleJob(new Date(fireAt), async () => {
    const currentTask = getTask(task.id);
    if (!isTaskStillActive(currentTask)) {
      logger.info('Eskalasi dilewati, task sudah tidak aktif.', { taskId: task.id, escalationIndex });
      return;
    }
    const deadline = formatDeadline(currentTask.deadline_ms);
    const msg = buildEscalationText(currentTask.title, deadline, escalationIndex);
    await sendReminderWithRetry(client, currentTask.chat_id, msg, task.id);
    logger.info('Eskalasi reminder terkirim.', { taskId: task.id, escalationIndex });
    scheduleEscalation(currentTask, client, escalationIndex + 1);
  });
  addJob(task.id, job);
}

export function scheduleReminders(task, client) {
  cancelReminders(task.id);
  const now = Date.now();
  let jobCount = 0;
  const { activeKeys, activeOffsets } = getActiveOffsets(task.chat_id);

  for (const offset of activeOffsets) {
    const remindAt = task.deadline_ms - offset.ms + jitter();
    if (remindAt <= now) continue;
    const isDue = offset.key === 'due';
    const job = schedule.scheduleJob(new Date(remindAt), async () => {
      const currentTask = getTask(task.id);
      if (!isTaskStillActive(currentTask)) {
        logger.info('Reminder dilewati karena task sudah tidak aktif.', { taskId: task.id });
        return;
      }
      const label = isDue ? 'Deadline' : offset.label;
      const msg = buildReminderText(label, currentTask.title, formatDeadline(currentTask.deadline_ms));
      await sendReminderWithRetry(client, currentTask.chat_id, msg, task.id);
      if (isDue) scheduleEscalation(currentTask, client, 0);
    });
    addJob(task.id, job);
    jobCount++;
  }

  // Fallback: if all offsets were in the past but deadline itself is future
  if (!jobCount && task.deadline_ms > now) {
    const fireAt = task.deadline_ms + jitter();
    const job = schedule.scheduleJob(new Date(fireAt), async () => {
      const currentTask = getTask(task.id);
      if (!isTaskStillActive(currentTask)) return;
      const msg = buildReminderText('Deadline', currentTask.title, formatDeadline(currentTask.deadline_ms));
      await sendReminderWithRetry(client, currentTask.chat_id, msg, task.id);
      scheduleEscalation(currentTask, client, 0);
    });
    addJob(task.id, job);
    jobCount++;
  }

  logger.info('Reminder dijadwalkan.', { taskId: task.id, jobCount, offsets: activeKeys });
}

export function rescheduleTaskReminders(task, client) {
  scheduleReminders(task, client);
}

export function scheduleSnooze(task, delayMs, client) {
  const job = schedule.scheduleJob(new Date(Date.now() + delayMs + jitter()), async () => {
    const currentTask = getTask(task.id);
    if (!isTaskStillActive(currentTask)) return;
    const msg = buildReminderText('Snooze', currentTask.title, formatDeadline(currentTask.deadline_ms));
    await sendReminderWithRetry(client, currentTask.chat_id, msg, task.id);
    scheduleEscalation(currentTask, client, 0);
  });
  addJob(task.id, job);
}

function isTaskStillActive(task) {
  return Boolean(task && task.status === 'pending');
}
