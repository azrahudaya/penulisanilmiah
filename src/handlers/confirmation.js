import dayjs from 'dayjs';
import wweb from 'whatsapp-web.js';
const { Poll } = wweb;

import { ctx, pendingConfirmations, PENDING_CONFIRMATION_TTL_MS, POLL_TITLE_MAX_LENGTH } from '../context.js';
import {
  upsertPendingConfirmation,
  deletePendingConfirmation,
  getPendingConfirmation,
  updateResearchLog,
  insertTasks,
} from '../db.js';
import { scheduleReminders } from '../scheduler.js';
import { deadlineMsFromIso } from '../nlp.js';
import { cachePollOptions, extractBareMessageId } from '../whatsapp/patches.js';
import { sendTrackedPoll, monitorPollVotes } from '../whatsapp/poll-tracker.js';
import { prepareTasksForInsert } from '../tasks.js';
import { maybeAskForFeedback } from './feedback.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export async function completePendingConfirmation(chatId, action, reply) {
  const pendingConfirmation = getActivePendingConfirmation(chatId);
  if (!pendingConfirmation) {
    await reply('Tidak ada konfirmasi aktif.');
    return;
  }

  const { tasks, researchLogId } = pendingConfirmation;

  if (action === 'accepted') {
    let toInsert;
    try {
      toInsert = prepareTasksForInsert(chatId, tasks);
    } catch (err) {
      await reply(err.message);
      return;
    }
    pendingConfirmations.delete(chatId);
    deletePendingConfirmation(chatId);
    if (researchLogId) updateResearchLog(researchLogId, { confirmationStatus: action });
    const saved = insertTasks(toInsert);
    saved.forEach((task) => scheduleReminders(task, ctx.client));
    await reply(formatSavedReminderMessage(saved));
    await maybeAskForFeedback(chatId);
    return;
  }

  pendingConfirmations.delete(chatId);
  deletePendingConfirmation(chatId);
  if (researchLogId) updateResearchLog(researchLogId, { confirmationStatus: action });

  if (action === 'edited') {
    await reply('Oke, kirim ulang.');
    return;
  }

  await reply('Dibatalkan.');
}

export function getActivePendingConfirmation(chatId) {
  const pendingConfirmation = pendingConfirmations.get(chatId) || getPendingConfirmation(chatId);
  if (!pendingConfirmation) return null;
  if (isPendingExpired(pendingConfirmation)) {
    expirePendingConfirmation(chatId, pendingConfirmation);
    return null;
  }
  return pendingConfirmation;
}

export function isPendingExpired(pendingConfirmation) {
  const createdAt = Number(pendingConfirmation?.createdAt || Date.now());
  return Date.now() - createdAt > PENDING_CONFIRMATION_TTL_MS;
}

export function expirePendingConfirmation(chatId, pendingConfirmation) {
  pendingConfirmations.delete(chatId);
  deletePendingConfirmation(chatId);
  if (pendingConfirmation?.researchLogId) {
    updateResearchLog(pendingConfirmation.researchLogId, { confirmationStatus: 'expired' });
  }
}

export async function sendConfirmationPrompt(message, chatId, summary, pendingConfirmation) {
  const CONFIRMATION_OPTIONS = ['Simpan', 'Edit', 'Batal'];
  try {
    const pollMessage = await sendTrackedPoll(
      chatId,
      new Poll(buildConfirmationPollTitle(summary), CONFIRMATION_OPTIONS, { allowMultipleAnswers: false })
    );
    const pollMessageId = extractBareMessageId(pollMessage?.id?._serialized);
    if (pollMessageId) {
      await cachePollOptions(pollMessageId, CONFIRMATION_OPTIONS);
      pendingConfirmation.pollMessageId = pollMessageId;
      pendingConfirmation.confirmationChannel = 'poll';
      pendingConfirmations.set(chatId, pendingConfirmation);
      upsertPendingConfirmation(pendingConfirmation);
    }
    monitorPollVotes(pollMessage);
  } catch (err) {
    logger.warn('Gagal mengirim poll konfirmasi, memakai fallback teks.', { chatId, message: err.message });
    pendingConfirmation.pollMessageId = '';
    pendingConfirmation.confirmationChannel = 'text_fallback';
    pendingConfirmations.set(chatId, pendingConfirmation);
    upsertPendingConfirmation(pendingConfirmation);
    await message.reply(`Aku dengar:\n${summary}\n\nKetik: ya / edit / batal`);
  }
}

export function buildConfirmationPollTitle(summary) {
  const title = `Aku dengar:\n${summary}\n\nSimpan?`;
  if (title.length <= POLL_TITLE_MAX_LENGTH) return title;
  return `${title.slice(0, POLL_TITLE_MAX_LENGTH - 3)}...`;
}

export function formatTasksForConfirmation(tasks) {
  if (tasks.length === 1) return formatTaskLine(tasks[0]);
  return tasks.map((task) => `- ${formatTaskLine(task)}`).join('\n');
}

export function formatTaskLine(task) {
  const timeStr = dayjs(task.deadline_iso).tz(config.timezone).format('DD MMM YYYY HH:mm');
  return `${task.title} - ${timeStr}`;
}

// Takes the newly saved tasks (array of DB rows), not chatId.
export function formatSavedReminderMessage(tasks) {
  if (!tasks?.length) return 'Tersimpan.';
  const lines = tasks.map((task) => {
    const deadline = dayjs(task.deadline_ms).tz(config.timezone).format('DD MMM YYYY HH:mm');
    return `- ${task.title} - ${deadline}`;
  }).join('\n');
  return `Tersimpan:\n${lines}\n\nKetik list untuk lihat semua reminder aktif.`;
}
