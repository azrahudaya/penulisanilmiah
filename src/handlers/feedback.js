import { ctx, FEEDBACK_REPLY_TTL_MS, FEEDBACK_PROMPT_MIN_VOICE_NOTES } from '../context.js';
import {
  getRespondent,
  updateRespondent,
  countResearchLogsByChat,
  insertResearchFeedback,
  isFeedbackPromptEnabled,
} from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { isCommandKeyword } from '../utils.js';

export async function maybeAskForFeedback(chatId) {
  if (!config.researchMode || !isFeedbackPromptEnabled()) return;
  const respondent = getRespondent(chatId);
  if (!respondent) return;
  if (respondent.feedback_prompt_sent) return;
  if (respondent.feedback_pending) {
    if (isFeedbackExpired(respondent)) {
      clearPendingFeedback(chatId);
    } else {
      return;
    }
  }
  const voiceNoteCount = countResearchLogsByChat(chatId);
  if (voiceNoteCount < FEEDBACK_PROMPT_MIN_VOICE_NOTES) return;
  updateRespondent(chatId, {
    feedbackPending: 1,
    feedbackPromptedAt: Date.now(),
    feedbackPromptSent: 1,
  });
  await ctx.client.sendMessage(chatId, 'Kasih saran singkat buat bot ini? Balas, atau ketik skip.');
}

export async function handlePendingFeedbackReply(message, body, cmd) {
  const respondent = getRespondent(message.from);
  if (!respondent?.feedback_pending) return false;
  if (isFeedbackExpired(respondent)) {
    clearPendingFeedback(message.from);
    return false;
  }
  if (isCommandKeyword(cmd)) {
    clearPendingFeedback(message.from);
    return false;
  }

  const text = body.replace(/\s+/g, ' ').trim();
  if (!text) return false;

  updateRespondent(message.from, {
    feedbackPending: 0,
    feedbackPromptedAt: 0,
  });

  if (['skip', 'lewati', 'nanti'].includes(text.toLowerCase())) {
    await message.reply('Oke.');
    return true;
  }

  insertResearchFeedback({
    chatId: message.from,
    feedbackText: text.slice(0, 500),
    voiceNoteCount: countResearchLogsByChat(message.from),
  });
  await message.reply('Makasih!');
  return true;
}

export function isFeedbackExpired(respondent) {
  const promptedAt = Number(respondent?.feedback_prompted_at || 0);
  return !promptedAt || Date.now() - promptedAt > FEEDBACK_REPLY_TTL_MS;
}

export function clearPendingFeedback(chatId) {
  updateRespondent(chatId, {
    feedbackPending: 0,
    feedbackPromptedAt: 0,
  });
}

