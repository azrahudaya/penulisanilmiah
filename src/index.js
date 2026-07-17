import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import qrcodeTerminal from 'qrcode-terminal';
import wweb from 'whatsapp-web.js';
const { Client, LocalAuth, Poll } = wweb;

import { config, requireEnv } from './config.js';
import { writeTempFile, convertToWav, saveResearchWav, transcribeWhisper, cleanupResearchAudioFiles } from './audio.js';
import { extractTasks, extractTasksWithRaw } from './nlp.js';
import { logger } from './logger.js';
import {
  insertTasks,
  listTasks,
  markDone,
  deleteTask,
  rescheduleTask,
  listPendingForScheduling,
  listUnnotifiedOverdueTasks,
  markMissedNotified,
  getTask,
  insertResearchLog,
  updateResearchLog,
  getResearchStats,
  upsertPendingConfirmation,
  getPendingConfirmation,
  getPendingConfirmationByPollMessageId,
  deletePendingConfirmation,
  deleteExpiredPendingConfirmations,
  getRespondent,
  startRespondentRegistration,
  updateRespondent,
  getRespondentByRegistrationPollMessageId,
  deleteRespondentData,
  isFeedbackPromptEnabled,
  countResearchLogsByChat,
  insertResearchFeedback,
} from './db.js';
import { scheduleReminders, cancelReminders, rescheduleTaskReminders, REMINDER_OFFSET_OPTIONS, DEFAULT_REMINDER_OFFSET_KEYS } from './scheduler.js';
import { canMatchRegistrationVoteByChat, findPollOptionName, findSentPollMessage } from './poll.js';
import { prepareTasksForInsert } from './tasks.js';

requireEnv();
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const client = new Client({
  authStrategy: new LocalAuth(),
  ...(config.whatsappWebVersion ? {
    webVersion: config.whatsappWebVersion,
    webVersionCache: { type: 'local', strict: true },
  } : {}),
  puppeteer: {
    headless: true,
    ...(config.chromeExecutablePath ? { executablePath: config.chromeExecutablePath } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

const pendingConfirmations = new Map();
const PENDING_CONFIRMATION_TTL_MS = 30 * 60 * 1000;
const REGISTRATION_POLL_TTL_MS = 30 * 60 * 1000;
const FEEDBACK_REPLY_TTL_MS = 5 * 60 * 1000;
const POLL_TITLE_MAX_LENGTH = 240;
const FEEDBACK_PROMPT_MIN_VOICE_NOTES = 10;
const SMALL_TALK_INPUTS = new Set([
  'halo',
  'hai',
  'hi',
  'p',
  'ping',
  'tes',
  'test',
  'oke',
  'ok',
  'sip',
  'thanks',
  'thank you',
  'makasih',
  'terima kasih',
]);

function userError(text, code) {
  return `${text}\nKode: ${code}`;
}

client.on('qr', (qr) => {
  qrcodeTerminal.generate(qr, { small: true });
  logger.info('Scan QR untuk login WhatsApp.');
});

client.on('ready', async () => {
  logger.info('Bot siap. Memuat jadwal reminder...');
  const expired = deleteExpiredPendingConfirmations(PENDING_CONFIRMATION_TTL_MS);
  if (expired) logger.info('Menghapus pending confirmation expired.', { expired });
  if (config.researchMode) {
    const deletedAudio = cleanupResearchAudioFiles(config.researchRetentionDays);
    if (deletedAudio) logger.info('Menghapus audio penelitian expired.', { deletedAudio, retentionDays: config.researchRetentionDays });
  }
  const pending = listPendingForScheduling();
  pending.forEach((task) => scheduleReminders(task, client));
  const missed = await notifyMissedReminders();
  logger.info('Reminder pending dimuat.', { count: pending.length, missed });
});

client.on('message', async (message) => {
  try {
    if (isGroupChatId(message.from)) {
      logger.warn('Mengabaikan pesan grup.', { chatId: message.from });
      return;
    }
    if (message.type === 'chat' && isAdminCommand(message.body)) {
      await handleTextCommand(message);
      return;
    }
    if (await handleRegistrationGate(message)) {
      return;
    }
    if (message.hasMedia && (message.type === 'ptt' || message.type === 'audio')) {
      await handleVoiceMessage(message);
      return;
    }
    if (message.type === 'chat') {
      await handleTextCommand(message);
    }
  } catch (err) {
    logger.error('Message handler error', { message: err.message, stack: err.stack });
    await message.reply(userError('Ada gangguan. Coba lagi sebentar.', 'BOT-01'));
  }
});

client.on('vote_update', async (vote) => {
  try {
    logger.info('Event vote polling diterima.');
    await handlePollVote(vote);
  } catch (err) {
    logger.error('Poll vote handler error', { message: err.message, stack: err.stack });
  }
});

function mapVoiceErrorToReply(err) {
  if (!err) return null;
  switch (err.code) {
    case 'insufficient_quota':
      return userError('VN belum bisa diproses. Coba lagi nanti.', 'VN-04');
    case 'rate_limited':
      return userError('Lagi ramai. Coba lagi sebentar.', 'VN-05');
    case 'openai_key_missing':
      return userError('VN belum bisa diproses. Hubungi admin.', 'VN-06');
    case 'whisper_model_missing':
      return userError('VN belum bisa diproses. Hubungi admin.', 'VN-07');
    case 'whisper_binary_not_found':
      return userError('VN belum bisa diproses. Hubungi admin.', 'VN-08');
    case 'transcriber_not_configured':
      return userError('VN belum bisa diproses. Hubungi admin.', 'VN-09');
    default:
      return null;
  }
}

async function handleVoiceMessage(message) {
  const processingStartedAt = Date.now();
  const chatId = message.from;
  logger.info('Voice note diterima.', { chatId });
  const existingPending = getActivePendingConfirmation(chatId);
  if (existingPending) {
    await repeatPendingConfirmation(message, chatId, existingPending);
    return;
  }

  const durationBeforeDownload = getAudioDurationMs(message);
  if (durationBeforeDownload > config.maxVoiceNoteDurationMs) {
    await message.reply(userError('VN terlalu panjang. Maksimal 5 menit.', 'VN-01'));
    logger.warn('Voice note ditolak karena durasi.', { chatId, durationMs: durationBeforeDownload });
    return;
  }

  const media = await message.downloadMedia();
  if (!media) {
    await message.reply(userError('VN belum bisa diproses. Coba kirim ulang.', 'VN-02'));
    return;
  }
  const approxBytes = Buffer.byteLength(media.data || '', 'base64');
  if (approxBytes > config.maxVoiceNoteBytes) {
    await message.reply(userError('VN terlalu besar. Coba kirim yang lebih pendek.', 'VN-03'));
    logger.warn('Voice note ditolak karena ukuran.', { chatId, approxBytes });
    return;
  }
  await reactToMessage(message, '\u2705');

  let inputPath = null;
  let wavPath = null;
  let audioFilename = '';
  let transcript = '';
  let gptRawResponse = '';
  let tasks = [];
  let processingTimeSttMs = 0;
  let processingTimeNluMs = 0;
  let processingTimeTotalMs = 0;
  let researchLogged = false;
  let researchLogId = null;
  const audioDurationMs = getAudioDurationMs(message);

  function writeResearchLog({ status = 'pending_review', confirmationStatus = 'pending_confirmation' } = {}) {
    if (!config.researchMode || researchLogged) return;
    processingTimeTotalMs = Date.now() - processingStartedAt;
    const log = insertResearchLog({
      chatId,
      audioFilename,
      audioDurationMs,
      transcriptWhisper: transcript,
      gptRawResponse,
      extractedTasks: tasks,
      processingTimeSttMs,
      processingTimeNluMs,
      processingTimeTotalMs,
      confirmationStatus,
      status,
    });
    researchLogId = log?.id || null;
    researchLogged = true;
  }

  try {
    const buffer = Buffer.from(media.data, 'base64');
    inputPath = writeTempFile(buffer, '.ogg');
    wavPath = await convertToWav(inputPath);
    logger.info('Voice note dikonversi ke WAV.', { chatId });

    if (config.researchMode) {
      const savedAudio = saveResearchWav(wavPath);
      audioFilename = savedAudio.filename;
    }

    const sttStartedAt = Date.now();
    transcript = await transcribeWhisper(wavPath);
    processingTimeSttMs = Date.now() - sttStartedAt;
    logger.info('Transkripsi selesai.', { chatId, processingTimeSttMs });

    const nluStartedAt = Date.now();
    const extraction = await extractTasksWithRaw(transcript, { source: 'voice' });
    processingTimeNluMs = Date.now() - nluStartedAt;
    tasks = extraction.tasks;
    gptRawResponse = extraction.rawResponse;
    logger.info('Ekstraksi task selesai.', { chatId, processingTimeNluMs, taskCount: tasks.length });

    if (!tasks.length) {
      writeResearchLog({ status: 'pending_review', confirmationStatus: 'no_tasks' });
      await message.reply(userError('Saya belum menemukan reminder di VN itu. Coba kirim ulang.', 'VN-10'));
      return;
    }

    writeResearchLog({ status: 'pending_review', confirmationStatus: 'pending_confirmation' });

    const pendingConfirmation = {
      chatId,
      tasks,
      transcript,
      researchLogId,
      pollMessageId: '',
      confirmationChannel: 'text',
      createdAt: Date.now(),
    };
    pendingConfirmations.set(chatId, pendingConfirmation);
    upsertPendingConfirmation(pendingConfirmation);
    const summary = formatTasksForConfirmation(tasks);
    await sendConfirmationPrompt(message, chatId, summary, pendingConfirmation);
  } catch (err) {
    writeResearchLog({ status: 'excluded', confirmationStatus: 'processing_error' });
    const friendlyError = mapVoiceErrorToReply(err);
    if (friendlyError) {
      logger.error('Voice processing error', { chatId, code: err.code, message: err.message });
      await message.reply(friendlyError);
      return;
    }
    throw err;
  } finally {
    if (inputPath) fs.unlink(inputPath, () => {});
    if (wavPath) fs.unlink(wavPath, () => {});
  }
}

function getAudioDurationMs(message) {
  const durationSeconds = Number(message?.duration || message?._data?.duration || 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.round(durationSeconds * 1000);
}

async function handleTextCommand(message) {
  const chatId = message.from;
  const body = message.body.trim();
  const lower = body.toLowerCase();

  const pendingConfirmation = getActivePendingConfirmation(chatId);
  if (pendingConfirmation) {
    const confirmationAction = parseConfirmationAction(lower);
    if (confirmationAction) {
      await completePendingConfirmation(chatId, confirmationAction, (text) => message.reply(text));
      return;
    }
  }

  const [cmd, ...rest] = lower.split(/\s+/);
  if (await handlePendingFeedbackReply(message, body, cmd)) {
    return;
  }

  switch (cmd) {
    case 'help':
    case 'menu':
      await sendHelp(message);
      break;
    case 'profile':
    case 'data':
      await sendProfile(message);
      break;
    case 'editdata':
    case 'editprofile':
      await handleEditData(message);
      break;
    case 'deletedata':
    case 'hapusdata':
      await handleDeleteData(message, rest);
      break;
    case 'time':
    case 'now':
      await sendServerTime(message);
      break;
    case 'list':
      await sendList(message);
      break;
    case 'done':
      await handleDone(message, rest);
      break;
    case 'delete':
    case 'del':
      await handleDelete(message, rest);
      break;
    case 'reschedule':
    case 'resched':
      await handleReschedule(message, rest);
      break;
    case 'researchstats':
      await handleResearchStats(message);
      break;
    default:
      if (isSmallTalkText(body)) {
        await message.reply("Bisa. Tulis bebas aja isi reminder kamu, misalnya: 'tolong ingetin besok pagi kirim invoice'.");
        return;
      }
      await handleNaturalTextTask(message, body);
  }
}

async function sendConfirmationPrompt(message, chatId, summary, pendingConfirmation) {
  try {
    const pollMessage = await sendTrackedPoll(chatId, new Poll(
      buildConfirmationPollTitle(summary),
      ['Simpan', 'Edit', 'Batal'],
      { allowMultipleAnswers: false }
    ));
    const pollMessageId = pollMessage?.id?._serialized || '';
    if (pollMessageId) {
      pendingConfirmation.pollMessageId = pollMessageId;
      pendingConfirmation.confirmationChannel = 'poll';
      pendingConfirmations.set(chatId, pendingConfirmation);
      upsertPendingConfirmation(pendingConfirmation);
    }
  } catch (err) {
    logger.error('Gagal melacak poll konfirmasi.', { chatId, message: err.message });
  }
}

async function repeatPendingConfirmation(message, chatId, pendingConfirmation) {
  const summary = formatTasksForConfirmation(pendingConfirmation.tasks);
  await sendConfirmationPrompt(message, chatId, summary, pendingConfirmation);
}

function buildConfirmationPollTitle(summary) {
  const title = `Aku dengar:\n${summary}\n\nSimpan?`;
  if (title.length <= POLL_TITLE_MAX_LENGTH) return title;
  return `${title.slice(0, POLL_TITLE_MAX_LENGTH - 3)}...`;
}

async function reactToMessage(message, emoji) {
  try {
    if (typeof message.react === 'function') {
      await message.react(emoji);
    }
  } catch (err) {
    logger.warn('Gagal react ke message.', { message: err.message });
  }
}

function formatTasksForConfirmation(tasks) {
  if (tasks.length === 1) {
    return formatTaskLine(tasks[0]);
  }
  return tasks.map((task) => `- ${formatTaskLine(task)}`).join('\n');
}

function formatTaskLine(task) {
  const timeStr = dayjs(task.deadline_iso).tz(config.timezone).format('DD MMM YYYY HH:mm');
  return `${task.title} - ${timeStr}`;
}

function formatTaskRow(task, { showId = false } = {}) {
  const deadline = dayjs(task.deadline_ms).tz(config.timezone).format('DD MMM YYYY HH:mm');
  const prefix = showId ? `#${task.id} ` : '';
  const suffix = task.deadline_ms <= Date.now() ? ' (terlewat)' : '';
  return `- ${prefix}${task.title} - ${deadline}${suffix}`;
}

function formatSavedReminderMessage(tasks) {
  if (!tasks.length) return 'Tersimpan.';
  const lines = tasks.map((task) => formatTaskRow(task)).join('\n');
  return `Tersimpan:\n${lines}\n\nKetik list untuk lihat semua reminder aktif.`;
}

async function notifyMissedReminders() {
  const overdue = listUnnotifiedOverdueTasks();
  if (!overdue.length) return 0;

  const byChat = new Map();
  overdue.forEach((task) => {
    const items = byChat.get(task.chat_id) || [];
    items.push(task);
    byChat.set(task.chat_id, items);
  });

  let notified = 0;
  for (const [chatId, tasks] of byChat) {
    const visible = tasks.slice(0, 5).map((task) => formatTaskRow(task, { showId: true })).join('\n');
    const more = tasks.length > 5 ? `\n+${tasks.length - 5} reminder lain. Ketik list.` : '';
    try {
      await client.sendMessage(chatId, `Ada reminder terlewat saat bot offline:\n${visible}${more}\n\nKetik done <id>, delete <id>, atau reschedule <id> <jadwal>.`);
      notified += markMissedNotified(tasks.map((task) => task.id));
    } catch (err) {
      logger.error('Gagal mengirim reminder terlewat.', { chatId, message: err.message });
    }
  }
  return notified;
}

async function handlePollVote(vote) {
  if (!Array.isArray(vote.selectedOptions)) return;

  const pollMessageId = vote.parentMessage?.id?._serialized || vote.parentMsgKey?._serialized || '';
  if (!pollMessageId) return;

  let pollMessage = vote.parentMessage;
  if (!pollMessage?.pollOptions?.length) {
    pollMessage = await client.getMessageById(pollMessageId).catch(() => null);
  }
  const selected = findPollOptionName(vote.selectedOptions[0], pollMessage?.pollOptions);
  logger.info('Vote polling diproses.', { pollMessageId, selected: selected || 'unknown' });
  if (await handleRegistrationPollVote(pollMessageId, selected, pollMessage?.to)) {
    return;
  }

  const pending = getPendingConfirmationByPollMessageId(pollMessageId);
  if (!pending) return;
  if (vote.selectedOptions.length !== 1 || !selected) return;
  if (isPendingExpired(pending)) {
    expirePendingConfirmation(pending.chatId, pending);
    await client.sendMessage(pending.chatId, 'Konfirmasi sudah kedaluwarsa. Kirim ulang ya.');
    return;
  }
  let action = null;
  if (selected.includes('simpan')) action = 'accepted';
  if (selected.includes('edit')) action = 'edited';
  if (selected.includes('batal')) action = 'cancelled';
  if (!action) return;

  await completePendingConfirmation(pending.chatId, action, (text) => client.sendMessage(pending.chatId, text));
}

async function handleRegistrationGate(message) {
  const chatId = message.from;
  if (message.fromMe) return false;

  const body = message.type === 'chat' ? message.body.trim() : '';
  const lower = body.toLowerCase();
  let respondent = getRespondent(chatId);

  if (!respondent || lower === 'register') {
    respondent = startRespondentRegistration(chatId);
    await sendConsentPoll(chatId, message);
    return true;
  }

  if (respondent.registration_step === 'not_started') {
    respondent = startRespondentRegistration(chatId);
    await sendConsentPoll(chatId, message);
    return true;
  }

  if (respondent.consent_status === 'consented' && respondent.registration_step === 'completed') {
    return false;
  }

  if (['gender', 'consent'].includes(respondent.registration_step) && isRegistrationPollExpired(respondent)) {
    updateRespondent(chatId, {
      registrationStep: 'not_started',
      genderPollMessageId: '',
      reminderPollMessageId: '',
      consentPollMessageId: '',
    });
    await message.reply("Sesi registrasi kedaluwarsa. Ketik 'register' untuk mulai lagi.");
    return true;
  }

  if (respondent.consent_status === 'declined' || respondent.registration_step === 'declined') {
    await message.reply("Kamu belum memberi persetujuan penelitian, jadi bot belum bisa digunakan. Ketik 'register' kalau ingin daftar ulang.");
    return true;
  }

  if (message.type !== 'chat') {
    await message.reply('Selesaikan registrasi dulu ya.');
    return true;
  }

  await handleRegistrationTextStep(message, respondent, body);
  return true;
}

async function handleRegistrationTextStep(message, respondent, body) {
  const chatId = message.from;
  const lower = body.toLowerCase();
  const step = respondent.registration_step || 'consent';

  if (step === 'consent') {
    const consent = parseConsentChoice(lower);
    if (!consent) {
      await message.reply('Pilih dari polling, atau ketik setuju / tidak.');
      return;
    }
    await completeRegistrationConsent(chatId, consent, (text) => message.reply(text));
    return;
  }

  if (step === 'name') {
    const name = body.replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 80) {
      await message.reply('Namanya ditulis 2-80 karakter ya.');
      return;
    }
    const firstName = name.split(/\s+/)[0];
    updateRespondent(chatId, { name, registrationStep: 'gender' });
    await message.reply(`Makasih, ${firstName}.`);
    await sendGenderPoll(chatId, message);
    return;
  }

  if (step === 'age') {
    updateRespondent(chatId, { registrationStep: respondent.consent_status === 'consented' ? 'gender' : 'consent' });
    await message.reply('Kita lanjut yang wajib dulu ya.');
    if (respondent.consent_status === 'consented') await sendGenderPoll(chatId, message);
    else await sendConsentPoll(chatId, message);
    return;
  }

  if (step === 'gender') {
    const gender = parseGenderChoice(lower);
    if (!gender) {
      await message.reply('Pilih gender dari polling, atau ketik 1 / 2.');
      return;
    }
    updateRespondent(chatId, { gender, genderPollMessageId: '' });
    await completeRegistrationProfile(chatId, (text) => message.reply(text));
    return;
  }

  if (step === 'occupation') {
    updateRespondent(chatId, { registrationStep: respondent.consent_status === 'consented' ? 'gender' : 'consent' });
    await message.reply('Kita lanjut yang wajib dulu ya.');
    if (respondent.consent_status === 'consented') await sendGenderPoll(chatId, message);
    else await sendConsentPoll(chatId, message);
    return;
  }
}

async function sendGenderPoll(chatId, message) {
  try {
    const pollMessage = await sendTrackedPoll(
      chatId,
      new Poll('Jenis kelamin kamu?', ['Laki-laki', 'Perempuan'], { allowMultipleAnswers: false })
    );
    const pollMessageId = pollMessage?.id?._serialized || '';
    if (pollMessageId) {
      updateRespondent(chatId, { genderPollMessageId: pollMessageId });
    }
  } catch (err) {
    logger.error('Gagal melacak poll gender.', { chatId, message: err.message });
  }
}

async function sendConsentPoll(chatId, message) {
  const text = `Bot menyimpan VN, transkrip, dan reminder untuk penelitian. Data bisa dihapus lewat deletedata.

Setuju?`;
  try {
    const pollMessage = await sendTrackedPoll(
      chatId,
      new Poll(text, ['Setuju', 'Tidak'], { allowMultipleAnswers: false })
    );
    const pollMessageId = pollMessage?.id?._serialized || '';
    if (pollMessageId) {
      updateRespondent(chatId, { consentPollMessageId: pollMessageId });
    }
  } catch (err) {
    logger.error('Gagal melacak poll consent.', { chatId, message: err.message });
  }
}

async function sendTrackedPoll(chatId, poll) {
  let pollMessage = await client.sendMessage(chatId, poll);
  if (!pollMessage) {
    const chat = await client.getChatById(chatId);
    for (let attempt = 0; attempt < 3 && !pollMessage; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      pollMessage = findSentPollMessage(
        await chat.fetchMessages({ limit: 1, fromMe: true }),
        poll.pollName
      );
    }
  }
  if (!pollMessage?.id?._serialized) throw new Error('Pesan polling tidak dapat dilacak.');
  monitorPollVotes(pollMessage);
  return pollMessage;
}

function monitorPollVotes(pollMessage) {
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const votes = await pollMessage.getPollVotes();
      const vote = votes.find((item) => item.selectedOptions?.length);
      if (!vote) return;
      clearInterval(timer);
      await handlePollVote(vote);
    } catch (err) {
      logger.warn('Gagal memeriksa hasil polling.', { message: err.message });
    } finally {
      checking = false;
    }
  }, 2000);
  timer.unref();
  setTimeout(() => clearInterval(timer), PENDING_CONFIRMATION_TTL_MS).unref();
}

async function handleRegistrationPollVote(pollMessageId, selected, pollChatId = '') {
  let respondent = getRespondentByRegistrationPollMessageId(pollMessageId);
  if (!respondent && pollChatId) {
    const candidate = getRespondent(pollChatId);
    if (canMatchRegistrationVoteByChat(candidate)) {
      respondent = candidate;
      logger.warn('Mencocokkan vote registrasi melalui chat karena ID polling tidak tersedia.', { chatId: pollChatId });
    }
  }
  if (!respondent) return false;
  if (isRegistrationPollExpired(respondent)) {
    updateRespondent(respondent.chat_id, {
      registrationStep: 'not_started',
      genderPollMessageId: '',
      reminderPollMessageId: '',
      consentPollMessageId: '',
    });
    await client.sendMessage(respondent.chat_id, "Sesi registrasi kedaluwarsa. Ketik 'register' untuk mulai lagi.");
    return true;
  }

  if (respondent.registration_step === 'gender') {
    const gender = selected?.includes('laki') ? 'Laki-laki' : selected?.includes('perempuan') ? 'Perempuan' : '';
    if (!gender) return true;
    updateRespondent(respondent.chat_id, { gender, genderPollMessageId: '' });
    await completeRegistrationProfile(respondent.chat_id, (text) => client.sendMessage(respondent.chat_id, text));
    return true;
  }

  if (respondent.registration_step === 'consent') {
    const consent = selected?.includes('tidak') ? 'declined' : selected?.includes('setuju') ? 'consented' : '';
    if (!consent) return true;
    await completeRegistrationConsent(respondent.chat_id, consent, (text) => client.sendMessage(respondent.chat_id, text));
    return true;
  }

  return true;
}

async function completeRegistrationConsent(chatId, consentStatus, reply) {
  if (consentStatus === 'declined') {
    updateRespondent(chatId, {
      consentStatus: 'declined',
      registrationStep: 'declined',
      consentPollMessageId: '',
    });
    await reply("Oke. Bot belum bisa dipakai. Ketik register untuk daftar lagi.");
    return;
  }

  updateRespondent(chatId, {
    consentStatus: 'consented',
    registrationStep: 'name',
    consentPollMessageId: '',
  });
  await reply('Makasih. Nama kamu siapa?');
}

async function completeRegistrationProfile(chatId, reply) {
  const respondent = getRespondent(chatId);
  const firstName = (respondent?.name || '').split(/\s+/)[0] || 'kamu';
  const selectedReminderOffsets = parseReminderOffsets(respondent?.reminder_offsets);
  updateRespondent(chatId, {
    registrationStep: 'completed',
    reminderOffsets: JSON.stringify(selectedReminderOffsets.length ? selectedReminderOffsets : DEFAULT_REMINDER_OFFSET_KEYS),
    registeredAt: Date.now(),
  });
  await reply(`Selesai. Halo ${firstName}.

Kirim VN atau teks reminder.`);
}

function parseGenderChoice(value) {
  if (value === '1' || value.includes('laki')) return 'Laki-laki';
  if (value === '2' || value.includes('perempuan')) return 'Perempuan';
  return '';
}

function parseConsentChoice(value) {
  if (value === '2' || value.includes('tidak')) return 'declined';
  if (value === '1' || value.includes('setuju') || value === 'ya') return 'consented';
  return '';
}

function parseConfirmationAction(value) {
  if (['1', 'ya', 'iya', 'yes', 'y', 'ok', 'oke', 'simpan'].includes(value)) return 'accepted';
  if (['2', 'edit', 'ubah', 'revisi'].includes(value)) return 'edited';
  if (['3', 'batal', 'cancel', 'hapus'].includes(value)) return 'cancelled';
  return '';
}

function parseReminderOffsets(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isRegistrationPollExpired(respondent) {
  const updatedAt = Number(respondent?.updated_at || Date.now());
  return Date.now() - updatedAt > REGISTRATION_POLL_TTL_MS;
}

async function completePendingConfirmation(chatId, action, reply) {
  const pendingConfirmation = getActivePendingConfirmation(chatId);
  if (!pendingConfirmation) {
    await reply('Tidak ada konfirmasi aktif. Kirim reminder baru ya.');
    return;
  }

  const { tasks, researchLogId } = pendingConfirmation;

  if (action === 'accepted') {
    const saved = insertTasks(prepareTasksForInsert(chatId, tasks));
    pendingConfirmations.delete(chatId);
    deletePendingConfirmation(chatId);
    if (researchLogId) updateResearchLog(researchLogId, { confirmationStatus: action });
    saved.forEach((task) => scheduleReminders(task, client));
    await reply(formatSavedReminderMessage(saved));
    await maybeAskForFeedback(chatId);
    return;
  }

  pendingConfirmations.delete(chatId);
  deletePendingConfirmation(chatId);
  if (researchLogId) updateResearchLog(researchLogId, { confirmationStatus: action });

  if (action === 'edited') {
    await reply('Oke, kirim ulang VN atau teksnya.');
    return;
  }

  await reply('Oke, dibatalkan.');
}

async function maybeAskForFeedback(chatId) {
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
  await client.sendMessage(chatId, 'Boleh kasih saran 1 kalimat buat bot ini? Balas singkat, atau ketik skip.');
}

async function handlePendingFeedbackReply(message, body, cmd) {
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
  await message.reply('Makasih, sarannya tersimpan.');
  return true;
}

function isFeedbackExpired(respondent) {
  const promptedAt = Number(respondent?.feedback_prompted_at || 0);
  return !promptedAt || Date.now() - promptedAt > FEEDBACK_REPLY_TTL_MS;
}

function clearPendingFeedback(chatId) {
  updateRespondent(chatId, {
    feedbackPending: 0,
    feedbackPromptedAt: 0,
  });
}

function isCommandKeyword(cmd) {
  return new Set([
    'help',
    'menu',
    'profile',
    'data',
    'editdata',
    'editprofile',
    'deletedata',
    'hapusdata',
    'time',
    'now',
    'list',
    'done',
    'delete',
    'del',
    'reschedule',
    'resched',
    'researchstats',
  ]).has(cmd);
}

function getActivePendingConfirmation(chatId) {
  const pendingConfirmation = pendingConfirmations.get(chatId) || getPendingConfirmation(chatId);
  if (!pendingConfirmation) return null;
  if (isPendingExpired(pendingConfirmation)) {
    expirePendingConfirmation(chatId, pendingConfirmation);
    return null;
  }
  return pendingConfirmation;
}

function isPendingExpired(pendingConfirmation) {
  const createdAt = Number(pendingConfirmation?.createdAt || Date.now());
  return Date.now() - createdAt > PENDING_CONFIRMATION_TTL_MS;
}

function expirePendingConfirmation(chatId, pendingConfirmation) {
  pendingConfirmations.delete(chatId);
  deletePendingConfirmation(chatId);
  if (pendingConfirmation?.researchLogId) {
    updateResearchLog(pendingConfirmation.researchLogId, { confirmationStatus: 'expired' });
  }
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

async function isAdminMessage(message) {
  if (!config.adminPhone) return false;
  const identifiers = [message.from];
  if (String(message.from || '').endsWith('@lid')) {
    const [mapped] = await client.getContactLidAndPhone([message.from]).catch(() => []);
    if (mapped?.pn) identifiers.push(mapped.pn);
  }
  return identifiers.some((value) => normalizePhone(value) === normalizePhone(config.adminPhone));
}

function isGroupChatId(chatId) {
  return String(chatId || '').endsWith('@g.us');
}

function isAdminCommand(body = '') {
  const [cmd] = String(body).trim().toLowerCase().split(/\s+/);
  return cmd === 'researchstats';
}

function deleteResearchAudioFiles(audioFilenames) {
  for (const filename of audioFilenames) {
    if (!/^vn-[A-Za-z0-9-]+\.wav$/.test(filename)) continue;
    const filePath = path.join(config.researchAudioDir, filename);
    if (fs.existsSync(filePath)) {
      fs.unlink(filePath, () => {});
    }
  }
}

function isSmallTalkText(text) {
  const normalized = text.trim().toLowerCase();
  if (SMALL_TALK_INPUTS.has(normalized)) return true;
  return normalized.length <= 2;
}

async function handleNaturalTextTask(message, text) {
  const chatId = message.from;
  const existingPending = getActivePendingConfirmation(chatId);
  if (existingPending) {
    await repeatPendingConfirmation(message, chatId, existingPending);
    return;
  }

  const tasks = await extractTasks(text, { source: 'text' });
  if (!tasks.length) {
    await message.reply(userError('Saya belum menemukan reminder. Contoh: "besok jam 09.00 follow up vendor".', 'TXT-01'));
    return;
  }

  const pendingConfirmation = {
    chatId,
    tasks,
    transcript: text,
    researchLogId: null,
    pollMessageId: '',
    confirmationChannel: 'text',
    createdAt: Date.now(),
  };
  pendingConfirmations.set(chatId, pendingConfirmation);
  upsertPendingConfirmation(pendingConfirmation);
  const summary = formatTasksForConfirmation(tasks);
  await sendConfirmationPrompt(message, chatId, summary, pendingConfirmation);
}

async function sendHelp(message) {
  const serverNow = dayjs().tz(config.timezone).format('DD MMM YYYY HH:mm:ss');
  const adminLine = await isAdminMessage(message) ? '\nAdmin:\n- researchstats: ringkasan data penelitian' : '';
  const helpText = `Cara pakai Reminder Bot

Buat reminder:
Kirim VN atau teks bebas.
Contoh: "ingatkan aku besok jam 9 meeting"

Setelah bot menebak reminder:
Balas simpan, edit, atau batal.

Kelola reminder:
- list: lihat reminder aktif
- done <id>: tandai selesai
- delete <id>: hapus
- reschedule <id> <YYYY-MM-DD HH:mm>: ubah jadwal

Data kamu:
- profile: lihat data registrasi
- editdata: ubah data
- deletedata: hapus akun dan riwayat
- time: cek waktu server

Waktu server: ${serverNow} (${config.timezone})
Reminder default: H-10 menit dan saat deadline.${adminLine}`;
  await message.reply(helpText);
}

async function sendProfile(message) {
  const respondent = getRespondent(message.from);
  if (!respondent || respondent.registration_step !== 'completed') {
    await message.reply("Data registrasi belum lengkap. Ketik 'register' untuk daftar.");
    return;
  }
  await message.reply(`Data kamu:
ID: ${respondent.respondent_id}
Nama: ${respondent.name || '-'}
Usia: ${respondent.age || '-'}
Jenis kelamin: ${respondent.gender || '-'}
Kesibukan: ${respondent.occupation || '-'}
Reminder: ${formatReminderPreference(respondent.reminder_offsets)}
Consent: ${respondent.consent_status}

Ketik editdata untuk ubah data.
Ketik deletedata untuk hapus data.`);
}

function formatReminderPreference(value) {
  const keys = parseReminderOffsets(value);
  const activeKeys = keys.length ? keys : DEFAULT_REMINDER_OFFSET_KEYS;
  return REMINDER_OFFSET_OPTIONS.filter((item) => activeKeys.includes(item.key)).map((item) => item.label).join(', ');
}

async function handleEditData(message) {
  updateRespondent(message.from, {
    name: '',
    gender: '',
    registrationStep: 'name',
    genderPollMessageId: '',
    consentPollMessageId: '',
  });
  await message.reply(`Oke, kita ubah data dari awal.

Siapa nama kamu?`);
}

async function handleDeleteData(message, args) {
  const confirmation = args.join(' ').trim().toLowerCase();
  if (confirmation !== 'confirm') {
    await message.reply(`Hapus data akan menghapus:
- data registrasi
- semua reminder
- log penelitian
- audio penelitian yang tersimpan

Kalau yakin, ketik:
deletedata confirm`);
    return;
  }

  const audioFilenames = deleteRespondentData(message.from);
  deleteResearchAudioFiles(audioFilenames);
  pendingConfirmations.delete(message.from);
  logger.info('User menghapus data pribadi.', { chatId: message.from, audioCount: audioFilenames.length });
  await message.reply("Data kamu sudah dihapus. Ketik 'register' kalau ingin menggunakan bot lagi.");
}

async function handleResearchStats(message) {
  if (!(await isAdminMessage(message))) {
    await message.reply('Perintah ini hanya untuk admin.');
    return;
  }
  const stats = getResearchStats();
  await message.reply(`Research stats:
Total: ${stats.total || 0}
Reviewed: ${stats.reviewed || 0}
Pending: ${stats.pending_review || 0}
Excluded: ${stats.excluded || 0}
Avg WER: ${stats.avg_wer == null ? '-' : stats.avg_wer.toFixed(3)}
Avg Precision: ${stats.avg_precision == null ? '-' : stats.avg_precision.toFixed(3)}
Avg Recall: ${stats.avg_recall == null ? '-' : stats.avg_recall.toFixed(3)}
Avg F1: ${stats.avg_f1 == null ? '-' : stats.avg_f1.toFixed(3)}`);
}

async function sendServerTime(message) {
  const serverNow = dayjs().tz(config.timezone).format('DD MMM YYYY HH:mm:ss');
  await message.reply(`Waktu server saat ini: ${serverNow} (${config.timezone})`);
}

async function sendList(message) {
  const tasks = listTasks(message.from, { includeOverdue: true });
  if (!tasks.length) {
    await message.reply('Tidak ada tugas pending.');
    return;
  }
  const lines = tasks.map((task) => formatTaskRow(task, { showId: true }).slice(2)).join('\n');
  await message.reply(lines);
}

async function handleDone(message, args) {
  const id = parseInt(args[0], 10);
  if (!id) {
    await message.reply('Gunakan: done <id>');
    return;
  }
  const ok = markDone(id, message.from);
  if (ok) {
    cancelReminders(id);
    await message.reply(`Tugas ${id} selesai.`);
  } else {
    await message.reply('ID tidak ditemukan.');
  }
}

async function handleDelete(message, args) {
  const id = parseInt(args[0], 10);
  if (!id) {
    await message.reply('Gunakan: delete <id>');
    return;
  }
  const ok = deleteTask(id, message.from);
  if (ok) {
    cancelReminders(id);
    await message.reply(`Tugas ${id} dihapus.`);
  } else {
    await message.reply('ID tidak ditemukan.');
  }
}

async function handleReschedule(message, args) {
  const id = parseInt(args.shift(), 10);
  const newTimeStr = args.join(' ');
  if (!id || !newTimeStr) {
    await message.reply('Gunakan: reschedule <id> <tanggal/jam>');
    return;
  }
  const parsed = dayjs.tz(newTimeStr, 'YYYY-MM-DD HH:mm', config.timezone, true);
  const dt = parsed.isValid() ? parsed : dayjs.tz(newTimeStr, config.timezone);
  if (!dt.isValid()) {
    await message.reply('Format tanggal tidak dikenali. Contoh: 2026-02-01 21:00');
    return;
  }
  const newMs = dt.valueOf();
  const ok = rescheduleTask(id, message.from, newMs);
  if (!ok) {
    await message.reply('ID tidak ditemukan.');
    return;
  }
  const task = getTask(id);
  rescheduleTaskReminders(task, client);
  await message.reply(`Deadline tugas ${id} diubah ke ${dt.tz(config.timezone).format('DD MMM YYYY HH:mm')}`);
}

client.initialize();
