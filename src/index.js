import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import qrcodeTerminal from 'qrcode-terminal';
import wweb from 'whatsapp-web.js';
const { Client, LocalAuth } = wweb;

import { config, requireEnv } from './config.js';
import { cleanupResearchAudioFiles } from './audio.js';
import { logger } from './logger.js';
import {
  deleteExpiredPendingConfirmations,
  listPendingForScheduling,
  listAllPendingConfirmations,
  listUnnotifiedOverdueTasks,
  markMissedNotified,
} from './db.js';
import { scheduleReminders } from './scheduler.js';
import { ctx, pendingPollTrackers } from './context.js';
import { isGroupChatId, isAdminCommand } from './utils.js';
import { reactToMessage } from './whatsapp/reactions.js';
import { prePopulatePollCache, patchPollVoteHandler } from './whatsapp/patches.js';
import { handleVoiceMessage } from './handlers/voice.js';
import { handleTextCommand } from './handlers/text.js';
import { handleRegistrationGate } from './handlers/registration.js';
import { handlePollVote } from './handlers/poll.js';
import { findSentPollMessage } from './poll.js';

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

ctx.client = client;

client.on('qr', (qr) => {
  qrcodeTerminal.generate(qr, { small: true });
  logger.info('Scan QR untuk login WhatsApp.');
});

client.on('ready', async () => {
  logger.info('Bot siap. Memuat jadwal reminder...');
  const inProgress = listAllPendingConfirmations().filter(c => c.pollMessageId || c.chatId);
  if (inProgress.length) logger.warn('Ada sesi konfirmasi aktif dari sesi sebelumnya.', { count: inProgress.length });
  const expired = deleteExpiredPendingConfirmations(30 * 60 * 1000);
  if (expired) logger.info('Menghapus pending confirmation expired.', { expired });
  if (config.researchMode) {
    const deletedAudio = cleanupResearchAudioFiles(config.researchRetentionDays);
    if (deletedAudio) logger.info('Menghapus audio penelitian expired.', { deletedAudio, retentionDays: config.researchRetentionDays });
  }
  const pending = listPendingForScheduling();
  pending.forEach((task) => scheduleReminders(task, client));
  const missed = await notifyMissedReminders();
  logger.info('Reminder pending dimuat.', { count: pending.length, missed });
  await prePopulatePollCache();
  await patchPollVoteHandler();
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
    await reactToMessage(message, '⏳');
    if (await handleRegistrationGate(message)) {
      await reactToMessage(message, '✅');
      return;
    }
    if (message.hasMedia && (message.type === 'ptt' || message.type === 'audio')) {
      await handleVoiceMessage(message);
      return;
    }
    if (message.type === 'chat') {
      await handleTextCommand(message);
      await reactToMessage(message, '✅');
    }
  } catch (err) {
    logger.error('Message handler error', { message: err.message, stack: err.stack });
    await reactToMessage(message, '❌');
    await message.reply('Ada gangguan. Coba lagi.');
  }
});

client.on('message_create', (message) => {
  if (!message.fromMe || message.type !== 'poll_creation') return;
  for (const tracker of pendingPollTrackers) {
    if (message.to !== tracker.chatId || !findSentPollMessage([message], tracker.pollName)) continue;
    tracker.resolve(message);
    break;
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
    const visible = tasks.slice(0, 5).map((task) => {
      const deadline = dayjs(task.deadline_ms).tz(config.timezone).format('DD MMM YYYY HH:mm');
      return `- #${task.id} ${task.title} - ${deadline}`;
    }).join('\n');
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

client.initialize();
