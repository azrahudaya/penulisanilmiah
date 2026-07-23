import fs from 'fs';
import { pendingConfirmations } from '../context.js';
import { upsertPendingConfirmation, insertResearchLog, updateResearchLog } from '../db.js';
import { writeTempFile, convertToWav, saveResearchWav, transcribeWhisper } from '../audio.js';
import { extractTasksWithRaw } from '../nlp.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { reactToMessage } from '../whatsapp/reactions.js';
import {
  getActivePendingConfirmation,
  sendConfirmationPrompt,
  formatTasksForConfirmation,
} from './confirmation.js';

export function mapVoiceErrorToReply(err) {
  if (!err) return null;
  switch (err.code) {
    case 'insufficient_quota': return 'Transkripsi sedang tidak tersedia. Coba lagi nanti. [VN-04]';
    case 'rate_limited': return 'Lagi banyak proses. Coba lagi sebentar. [VN-05]';
    case 'openai_key_missing': return 'Transkripsi belum aktif. Hubungi admin. [VN-06]';
    case 'whisper_model_missing': return 'Transkripsi belum aktif. Hubungi admin. [VN-07]';
    case 'whisper_binary_not_found': return 'Transkripsi belum aktif. Hubungi admin. [VN-08]';
    case 'transcriber_not_configured': return 'Transkripsi belum aktif. Hubungi admin. [VN-09]';
    default: return null;
  }
}

export function getAudioDurationMs(message) {
  const durationSeconds = Number(message?.duration || message?._data?.duration || 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.round(durationSeconds * 1000);
}

export async function downloadVoiceMedia(message) {
  // Bypass Msg.get() — @lid message IDs break IDB lookup in WA Web 2.3000.1043+
  const rawData = {
    directPath: message._data?.directPath,
    encFilehash: message._data?.encFilehash,
    filehash: message._data?.filehash,
    mediaKey: message._data?.mediaKey,
    mediaKeyTimestamp: message._data?.mediaKeyTimestamp,
    type: message._data?.type,
    mimetype: message._data?.mimetype,
    filename: message._data?.filename,
    size: message._data?.size,
  };

  try {
    const media = await message.client.pupPage.evaluate(async (data) => {
      const mockQpl = { addAnnotations() { return this; }, addPoint() { return this; } };
      let dlFn = null;
      const candidates = ['WAWebDownloadManager', 'WAWebBlobDownloadManager', 'WAWebMediaDownloadManager'];
      for (const name of candidates) {
        try {
          const mod = window.require(name);
          if (typeof mod?.downloadManager?.downloadAndMaybeDecrypt === 'function') {
            dlFn = mod.downloadManager.downloadAndMaybeDecrypt.bind(mod.downloadManager);
            break;
          }
          if (typeof mod?.downloadAndMaybeDecrypt === 'function') {
            dlFn = mod.downloadAndMaybeDecrypt.bind(mod);
            break;
          }
        } catch (_) {}
      }
      if (!dlFn) return null;
      const decrypted = await dlFn({
        directPath: data.directPath,
        encFilehash: data.encFilehash,
        filehash: data.filehash,
        mediaKey: data.mediaKey,
        mediaKeyTimestamp: data.mediaKeyTimestamp,
        type: data.type,
        signal: new AbortController().signal,
        downloadQpl: mockQpl,
      });
      return {
        data: await window.WWebJS.arrayBufferToBase64Async(decrypted),
        mimetype: data.mimetype,
        filename: data.filename,
        filesize: data.size,
      };
    }, rawData);
    if (media?.data) return media;
    logger.warn('Download media via rawData mengembalikan null.', { chatId: message.from });
    return null;
  } catch (err) {
    logger.error('Download media gagal.', {
      chatId: message.from,
      errMessage: err.message,
      errStack: err.stack?.split('\n').slice(0, 3).join(' | '),
    });
    return null;
  }
}

export async function handleVoiceMessage(message) {
  const processingStartedAt = Date.now();
  const chatId = message.from;
  logger.info('Voice note diterima.', { chatId });
  const existingPending = getActivePendingConfirmation(chatId);
  if (existingPending) {
    const summary = formatTasksForConfirmation(existingPending.tasks);
    await reactToMessage(message, '❌');
    await message.reply(`Ada konfirmasi pending:\n${summary}\n\nKetik: ya / edit / batal`);
    return;
  }

  const durationBeforeDownload = getAudioDurationMs(message);
  if (durationBeforeDownload > config.maxVoiceNoteDurationMs) {
    await reactToMessage(message, '❌');
    await message.reply('VN terlalu panjang (maks 5 menit). [VN-01]');
    logger.warn('Voice note ditolak karena durasi.', { chatId, durationMs: durationBeforeDownload });
    return;
  }

  const media = await downloadVoiceMedia(message);
  if (!media) {
    await reactToMessage(message, '❌');
    await message.reply('Tidak bisa mengunduh voice note. Coba kirim ulang. [VN-02]');
    return;
  }
  const approxBytes = Buffer.byteLength(media.data || '', 'base64');
  if (approxBytes > config.maxVoiceNoteBytes) {
    await reactToMessage(message, '❌');
    await message.reply('VN terlalu besar. Coba yang lebih pendek. [VN-03]');
    logger.warn('Voice note ditolak karena ukuran.', { chatId, approxBytes });
    return;
  }

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
      await reactToMessage(message, '❌');
      await message.reply('Tidak ada task di VN. Sebutkan waktu, contoh: "besok jam 9 pagi meeting klien". [VN-10]');
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
    await reactToMessage(message, '✅');
  } catch (err) {
    writeResearchLog({ status: 'excluded', confirmationStatus: 'processing_error' });
    await reactToMessage(message, '❌');
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
