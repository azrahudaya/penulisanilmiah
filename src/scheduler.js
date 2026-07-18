import schedule from 'node-schedule';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { config } from './config.js';
import { getReminderOffsetsForChat, getTask } from './db.js';
import { logger } from './logger.js';

dayjs.extend(utc);
dayjs.extend(timezone);

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

export function scheduleReminders(task, client) {
  cancelReminders(task.id);
  const now = Date.now();
  const taskJobs = [];
  const { activeKeys, activeOffsets } = getActiveOffsets(task.chat_id);
  for (const offset of activeOffsets) {
    const remindAt = task.deadline_ms - offset.ms;
    if (remindAt <= now) continue;
    const job = schedule.scheduleJob(new Date(remindAt), async () => {
      const currentTask = getTask(task.id);
      if (!isTaskStillActive(currentTask)) {
        logger.info('Reminder dilewati karena task sudah tidak aktif.', { taskId: task.id });
        return;
      }
      const prefix = offset.key === 'due' ? 'Deadline' : offset.label;
      await sendReminderWithRetry(client, currentTask.chat_id, `[${prefix}] "${currentTask.title}" — ${formatDeadline(currentTask.deadline_ms)}`, task.id);
    });
    taskJobs.push(job);
  }
  if (!taskJobs.length && task.deadline_ms > now) {
    const job = schedule.scheduleJob(new Date(task.deadline_ms), async () => {
      const currentTask = getTask(task.id);
      if (!isTaskStillActive(currentTask)) {
        logger.info('Reminder dilewati karena task sudah tidak aktif.', { taskId: task.id });
        return;
      }
      await sendReminderWithRetry(client, currentTask.chat_id, `[Deadline] "${currentTask.title}" — ${formatDeadline(currentTask.deadline_ms)}`, task.id);
    });
    taskJobs.push(job);
  }
  if (taskJobs.length) jobs.set(task.id, taskJobs);
  logger.info('Reminder dijadwalkan.', { taskId: task.id, jobCount: taskJobs.length, offsets: activeKeys });
}

export function rescheduleTaskReminders(task, client) {
  scheduleReminders(task, client);
}

export function scheduleSnooze(task, delayMs, client) {
  const job = schedule.scheduleJob(new Date(Date.now() + delayMs), async () => {
    const currentTask = getTask(task.id);
    if (!isTaskStillActive(currentTask)) return;
    await sendReminderWithRetry(
      client,
      currentTask.chat_id,
      `[Snooze] "${currentTask.title}" — ${formatDeadline(currentTask.deadline_ms)}`,
      task.id,
    );
  });
  if (job) {
    const existing = jobs.get(task.id) || [];
    existing.push(job);
    jobs.set(task.id, existing);
  }
}

function isTaskStillActive(task) {
  return Boolean(task && task.status === 'pending');
}
