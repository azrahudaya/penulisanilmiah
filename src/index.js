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
import { extractTasks, extractTasksWithRaw, deadlineMsFromIso } from './nlp.js';
import { logger } from './logger.js';
import {
  insertTask,
  listTasks,
  markDone,
  deleteTask,
  rescheduleTask,
  listPendingForScheduling,
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

requireEnv();
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const client = new Client({
  authStrategy: new LocalAuth(),
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
  logger.info('Reminder pending dimuat.', { count: pending.length });
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
    await message.reply('Terjadi kesalahan. Coba lagi sebentar.');
  }
});

client.on('vote_update', async (vote) => {
  try {
    await handlePollVote(vote);
  } catch (err) {
    logger.error('Poll vote handler error', { message: err.message, stack: err.stack });
  }
});

function mapVoiceErrorToReply(err) {
  if (!err) return null;
  switch (err.code) {
    case 'insufficient_quota':
      return 'Transkripsi sedang tidak tersedia. Coba lagi nanti.';
    case 'rate_limited':
      return 'Lagi banyak proses. Coba lagi sebentar.';
    case 'openai_key_missing':
      return 'Transkripsi belum aktif. Hubungi admin.';
    case 'whisper_model_missing':
      return 'Transkripsi belum aktif. Hubungi admin.';
    case 'whisper_binary_not_found':
      return 'Transkripsi belum aktif. Hubungi admin.';
    case 'transcriber_not_configured':
      return 'Transkripsi belum aktif. Hubungi admin.';
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
    await message.reply("Masih ada reminder yang belum dikonfirmasi. Pilih dulu ya.");
    return;
  }

  const durationBeforeDownload = getAudioDurationMs(message);
  if (durationBeforeDownload > config.maxVoiceNoteDurationMs) {
    await message.reply('VN terlalu panjang. Maksimal 5 menit ya.');
    logger.warn('Voice note ditolak karena durasi.', { chatId, durationMs: durationBeforeDownload });
    return;
  }

  const media = await message.downloadMedia();
  if (!media) {
    await message.reply('Tidak bisa mengunduh voice note.');
    return;
  }
  const approxBytes = Buffer.byteLength(media.data || '', 'base64');
  if (approxBytes > config.maxVoiceNoteBytes) {
    await message.reply('VN terlalu besar. Coba kirim yang lebih pendek ya.');
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
      await message.reply('Tidak menemukan tugas di VN tersebut. Coba lagi.');
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
    if (lower === 'ya') {
      await completePendingConfirmation(chatId, 'accepted', (text) => message.reply(text));
      return;
    }
    if (lower === 'edit') {
      await completePendingConfirmation(chatId, 'edited', (text) => message.reply(text));
      return;
    }
    if (lower === 'batal') {
      await completePendingConfirmation(chatId, 'cancelled', (text) => message.reply(text));
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
    const pollMessage = await client.sendMessage(
      chatId,
      new Poll(buildConfirmationPollTitle(summary), ['Simpan', 'Edit', 'Batal'], { allowMultipleAnswers: false })
    );
    const pollMessageId = pollMessage?.id?._serialized || '';
    if (pollMessageId) {
      pendingConfirmation.pollMessageId = pollMessageId;
      pendingConfirmation.confirmationChannel = 'poll';
      pendingConfirmations.set(chatId, pendingConfirmation);
      upsertPendingConfirmation(pendingConfirmation);
    }
  } catch (err) {
    logger.warn('Gagal mengirim poll konfirmasi, memakai fallback teks.', { chatId, message: err.message });
    pendingConfirmation.pollMessageId = '';
    pendingConfirmation.confirmationChannel = 'text_fallback';
    pendingConfirmations.set(chatId, pendingConfirmation);
    upsertPendingConfirmation(pendingConfirmation);
    await message.reply(`Aku dengar:\n${summary}\n\nBalas: ya / edit / batal`);
  }
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

function formatSavedReminderMessage(chatId) {
  const tasks = listTasks(chatId);
  if (!tasks.length) return 'Tersimpan.';
  const lines = tasks.map((task) => {
    const deadline = dayjs(task.deadline_ms).tz(config.timezone).format('DD MMM YYYY HH:mm');
    return `- ${task.title} - ${deadline}`;
  }).join('\n');
  return `Tersimpan.\n\n${lines}`;
}

async function handlePollVote(vote) {
  if (!Array.isArray(vote.selectedOptions)) return;

  const pollMessageId = vote.parentMessage?.id?._serialized || vote.parentMsgKey?._serialized || '';
  if (!pollMessageId) return;

  const selected = vote.selectedOptions[0]?.name?.toLowerCase() || '';
  if (await handleRegistrationPollVote(vote, pollMessageId, selected)) {
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
  if (!isVoteFromPendingChat(vote, pending.chatId)) {
    logger.warn('Mengabaikan poll vote dari voter tidak sesuai.', { voter: vote.voter, chatId: pending.chatId });
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
    await message.reply(`Halo! Selamat datang di Reminder Bot.

Sebelum mulai, saya perlu data singkat untuk penelitian.

Siapa nama kamu?`);
    return true;
  }

  if (respondent.registration_step === 'not_started') {
    startRespondentRegistration(chatId);
    await message.reply(`Halo! Selamat datang di Reminder Bot.

Sebelum mulai, saya perlu data singkat untuk penelitian.

Siapa nama kamu?`);
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
  const step = respondent.registration_step || 'name';

  if (step === 'name') {
    const name = body.replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 80) {
      await message.reply('Namanya ditulis 2-80 karakter ya.');
      return;
    }
    const firstName = name.split(/\s+/)[0];
    updateRespondent(chatId, { name, registrationStep: 'age' });
    await message.reply(`Terima kasih, ${firstName}. Berapa usia kamu?`);
    return;
  }

  if (step === 'age') {
    const age = Number(body);
    if (!Number.isInteger(age) || age < 10 || age > 100) {
      await message.reply('Usia ditulis angka saja ya. Contoh: 21');
      return;
    }
    updateRespondent(chatId, { age, registrationStep: 'gender' });
    await sendGenderPoll(chatId, message);
    return;
  }

  if (step === 'gender') {
    const gender = parseGenderChoice(lower);
    if (!gender) {
      await message.reply('Pilih gender dari polling, atau ketik 1 / 2.');
      return;
    }
    updateRespondent(chatId, { gender, registrationStep: 'occupation', genderPollMessageId: '' });
    await message.reply('Apa pekerjaan atau kesibukan kamu saat ini?');
    return;
  }

  if (step === 'occupation') {
    const occupation = body.replace(/\s+/g, ' ').trim();
    if (occupation.length < 2 || occupation.length > 120) {
      await message.reply('Tulis pekerjaan/kesibukan 2-120 karakter ya.');
      return;
    }
    updateRespondent(chatId, {
      occupation,
      reminderOffsets: JSON.stringify(DEFAULT_REMINDER_OFFSET_KEYS),
      registrationStep: 'consent',
      reminderPollMessageId: '',
    });
    await sendConsentPoll(chatId, message);
    return;
  }

  if (step === 'consent') {
    const consent = parseConsentChoice(lower);
    if (!consent) {
      await message.reply('Pilih dari polling, atau ketik 1 / 2.');
      return;
    }
    await completeRegistrationConsent(chatId, consent, (text) => message.reply(text));
  }
}

async function sendGenderPoll(chatId, message) {
  try {
    const pollMessage = await client.sendMessage(
      chatId,
      new Poll('Jenis kelamin kamu?', ['Laki-laki', 'Perempuan'], { allowMultipleAnswers: false })
    );
    const pollMessageId = pollMessage?.id?._serialized || '';
    if (pollMessageId) {
      updateRespondent(chatId, { genderPollMessageId: pollMessageId });
    }
  } catch {
    await message.reply('Jenis kelamin kamu?\n1. Laki-laki\n2. Perempuan');
  }
}

async function sendConsentPoll(chatId, message) {
  const text = `Data kamu dipakai untuk penelitian ilmiah dan dijaga kerahasiaannya.

Apakah kamu setuju?`;
  try {
    const pollMessage = await client.sendMessage(
      chatId,
      new Poll(text, ['Ya, saya setuju', 'Tidak'], { allowMultipleAnswers: false })
    );
    const pollMessageId = pollMessage?.id?._serialized || '';
    if (pollMessageId) {
      updateRespondent(chatId, { consentPollMessageId: pollMessageId });
    }
  } catch {
    await message.reply(`${text}\n1. Ya, saya setuju\n2. Tidak`);
  }
}

async function handleRegistrationPollVote(vote, pollMessageId, selected) {
  const respondent = getRespondentByRegistrationPollMessageId(pollMessageId);
  if (!respondent) return false;
  if (!isVoteFromPendingChat(vote, respondent.chat_id)) return true;
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
    const gender = selected.includes('laki') ? 'Laki-laki' : selected.includes('perempuan') ? 'Perempuan' : '';
    if (!gender) return true;
    updateRespondent(respondent.chat_id, { gender, registrationStep: 'occupation', genderPollMessageId: '' });
    await client.sendMessage(respondent.chat_id, 'Apa pekerjaan atau kesibukan kamu saat ini?');
    return true;
  }

  if (respondent.registration_step === 'consent') {
    const consent = selected.includes('setuju') ? 'consented' : selected.includes('tidak') ? 'declined' : '';
    if (!consent) return true;
    await completeRegistrationConsent(respondent.chat_id, consent, (text) => client.sendMessage(respondent.chat_id, text));
    return true;
  }

  return true;
}

async function completeRegistrationConsent(chatId, consentStatus, reply) {
  const respondent = getRespondent(chatId);
  if (consentStatus === 'declined') {
    updateRespondent(chatId, {
      consentStatus: 'declined',
      registrationStep: 'declined',
      consentPollMessageId: '',
    });
    await reply("Baik, registrasi dihentikan. Ketik 'register' kalau ingin daftar ulang.");
    return;
  }

  const firstName = (respondent?.name || '').split(/\s+/)[0] || 'kamu';
  const selectedReminderOffsets = parseReminderOffsets(respondent?.reminder_offsets);
  updateRespondent(chatId, {
    consentStatus: 'consented',
    registrationStep: 'completed',
    reminderOffsets: JSON.stringify(selectedReminderOffsets.length ? selectedReminderOffsets : DEFAULT_REMINDER_OFFSET_KEYS),
    consentPollMessageId: '',
    registeredAt: Date.now(),
  });
  await reply(`Registrasi berhasil.

Halo ${firstName}, kamu bisa mulai pakai Reminder Bot.

Kirim VN, contoh:
"ingatkan aku besok jam 9 meeting"

Ketik help untuk panduan.`);
}

function parseGenderChoice(value) {
  if (value === '1' || value.includes('laki')) return 'Laki-laki';
  if (value === '2' || value.includes('perempuan')) return 'Perempuan';
  return '';
}

function parseConsentChoice(value) {
  if (value === '1' || value.includes('setuju') || value === 'ya') return 'consented';
  if (value === '2' || value.includes('tidak')) return 'declined';
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
  pendingConfirmations.delete(chatId);
  deletePendingConfirmation(chatId);
  if (researchLogId) {
    updateResearchLog(researchLogId, { confirmationStatus: action });
  }

  if (action === 'accepted') {
    const saved = tasks.map((t) => {
      const deadlineMs = deadlineMsFromIso(t.deadline_iso);
      return insertTask({ chatId, title: t.title, deadlineMs });
    });
    saved.forEach((task) => scheduleReminders(task, client));
    await reply(formatSavedReminderMessage(chatId));
    await maybeAskForFeedback(chatId);
    return;
  }

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

function isVoteFromPendingChat(vote, chatId) {
  const voter = normalizePhone(vote?.voter);
  const chat = normalizePhone(chatId);
  if (!voter || !chat) return false;
  return chat.includes(voter) || voter.includes(chat);
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function isAdminMessage(message) {
  if (!config.adminPhone) return false;
  return normalizePhone(message.from) === normalizePhone(config.adminPhone);
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
    await message.reply("Masih ada reminder yang belum dikonfirmasi. Pilih dulu ya.");
    return;
  }

  const tasks = await extractTasks(text, { source: 'text' });
  if (!tasks.length) {
    await message.reply('Saya belum nangkep detail task-nya. Coba kirim ulang dengan konteks waktu, misalnya "besok jam 09.00 follow up vendor".');
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
  await message.reply(`Aku tangkap:\n${summary}\n\nBalas: ya / edit / batal`);
}

async function sendHelp(message) {
  const serverNow = dayjs().tz(config.timezone).format('DD MMM YYYY HH:mm:ss');
  const adminLine = isAdminMessage(message) ? '\n- researchstats: ringkasan data penelitian admin' : '';
  const helpText = `Command:
- help/menu: lihat panduan
- profile/data: lihat data registrasi
- editdata: ubah data registrasi
- deletedata: hapus data akun dan riwayat penelitian
- time/now: cek waktu server
- list: lihat reminder aktif
- done <id>: tandai reminder selesai
- delete <id>: hapus reminder
- reschedule <id> <YYYY-MM-DD HH:mm>: ubah jadwal${adminLine}

Waktu server sekarang: ${serverNow} (${config.timezone})
Default reminder: H-10 menit dan saat deadline.

Kirim VN atau teks bebas untuk membuat reminder.
Contoh: "ingatkan aku besok jam 9 meeting"`;
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
  startRespondentRegistration(message.from);
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
  if (!isAdminMessage(message)) {
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
  const tasks = listTasks(message.from);
  if (!tasks.length) {
    await message.reply('Tidak ada tugas pending.');
    return;
  }
  const lines = tasks.map((t) => {
    const deadline = dayjs(t.deadline_ms).tz(config.timezone).format('DD MMM YYYY HH:mm');
    return `${t.id}. ${t.title} - ${deadline}`;
  }).join('\n');
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
  cancelReminders(id);
  const ok = deleteTask(id, message.from);
  if (ok) {
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
