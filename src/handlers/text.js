import fs from 'fs';
import path from 'path';
import dayjs from 'dayjs';

import { ctx, pendingConfirmations, editDataSessions } from '../context.js';
import {
  listTasks,
  markDone,
  deleteTask,
  rescheduleTask,
  getTask,
  getRespondent,
  updateRespondent,
  getResearchStats,
  upsertPendingConfirmation,
  deleteRespondentData,
} from '../db.js';
import { cancelReminders, rescheduleTaskReminders, scheduleSnooze } from '../scheduler.js';
import { extractTasks } from '../nlp.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  getActivePendingConfirmation,
  completePendingConfirmation,
  sendConfirmationPrompt,
  formatTasksForConfirmation,
} from './confirmation.js';
import { handlePendingFeedbackReply } from './feedback.js';
import { isAdminMessage, isSmallTalkText, formatReminderPreference } from '../utils.js';

export async function handleTextCommand(message) {
  const chatId = message.from;
  const body = message.body.trim();
  const lower = body.toLowerCase();

  // Edit-data field session takes priority
  const editSession = editDataSessions.get(chatId);
  if (editSession) {
    if (lower === 'batal') {
      editDataSessions.delete(chatId);
      await message.reply('Dibatalkan.');
      return;
    }
    await handleEditDataSession(message, editSession, body, lower);
    return;
  }

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
  if (await handlePendingFeedbackReply(message, body, cmd)) return;

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
    case 'snooze':
      await handleSnooze(message, rest);
      break;
    case 'researchstats':
      await handleResearchStats(message);
      break;
    default:
      if (isSmallTalkText(body)) {
        await message.reply('Kirim VN atau tulis reminder kamu, contoh: "ingatkan besok pagi kirim invoice".');
        return;
      }
      await handleNaturalTextTask(message, body);
  }
}

export async function handleNaturalTextTask(message, text) {
  const chatId = message.from;
  const existingPending = getActivePendingConfirmation(chatId);
  if (existingPending) {
    const summary = formatTasksForConfirmation(existingPending.tasks);
    await message.reply(`Ada konfirmasi pending:\n${summary}\n\nKetik: ya / edit / batal`);
    return;
  }

  const tasks = await extractTasks(text, { source: 'text' });
  if (!tasks.length) {
    await message.reply('Tidak nemu waktu/task. Coba lagi, contoh: "besok jam 09.00 follow up vendor".');
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
  const adminLine = await isAdminMessage(message) ? '\n- researchstats: data penelitian' : '';
  await message.reply(`Buat reminder — kirim VN atau teks:
"ingatkan besok jam 9 meeting"
Konfirmasi: ya / edit / batal

Command:
- list: reminder aktif
- done <id>: selesai
- delete <id>: hapus
- snooze <id> [menit]: ingatkan ulang (def. 30)
- reschedule <id> <YYYY-MM-DD HH:mm>
- profile: data registrasi
- editdata: ubah satu field
- deletedata: hapus akun
- register: daftar ulang
- time: waktu server${adminLine}

${serverNow} (${config.timezone})`);
}

async function sendProfile(message) {
  const respondent = getRespondent(message.from);
  if (!respondent || respondent.registration_step !== 'completed') {
    await message.reply('Belum terdaftar. Ketik register.');
    return;
  }
  await message.reply(`Data kamu:
ID: ${respondent.respondent_id}
Nama: ${respondent.name || '-'}
Usia: ${respondent.age || '-'}
Jenis kelamin: ${respondent.gender || '-'}
Pekerjaan: ${respondent.occupation || '-'}
Reminder: ${formatReminderPreference(respondent.reminder_offsets)}

editdata — ubah data
deletedata — hapus akun`);
}

async function handleEditData(message) {
  const chatId = message.from;
  const respondent = getRespondent(chatId);
  if (!respondent || respondent.registration_step !== 'completed') {
    await message.reply('Belum terdaftar. Ketik register.');
    return;
  }
  editDataSessions.set(chatId, { field: 'menu' });
  await message.reply(`Ubah data:
1. Nama — ${respondent.name || '-'}
2. Usia — ${respondent.age || '-'}
3. Jenis kelamin — ${respondent.gender || '-'}
4. Pekerjaan — ${respondent.occupation || '-'}

Ketik nomor atau batal.`);
}

async function handleEditDataSession(message, session, body, lower) {
  const chatId = message.from;

  if (session.field === 'menu') {
    if (lower === '1' || lower === 'nama') {
      editDataSessions.set(chatId, { field: 'name' });
      await message.reply('Nama baru:');
    } else if (lower === '2' || lower === 'usia') {
      editDataSessions.set(chatId, { field: 'age' });
      await message.reply('Usia baru:');
    } else if (lower === '3' || lower.includes('kelamin') || lower === 'gender') {
      editDataSessions.set(chatId, { field: 'gender' });
      await message.reply('1. Laki-laki  2. Perempuan');
    } else if (lower === '4' || lower.includes('pekerjaan') || lower.includes('kesibukan')) {
      editDataSessions.set(chatId, { field: 'occupation' });
      await message.reply('Pekerjaan baru:');
    } else {
      await message.reply('Pilih 1–4 atau batal.');
    }
    return;
  }

  if (session.field === 'name') {
    const name = body.replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 80) {
      await message.reply('Nama harus 2–80 karakter.');
      return;
    }
    updateRespondent(chatId, { name });
    editDataSessions.delete(chatId);
    await message.reply(`Nama diubah ke ${name}.`);
    return;
  }

  if (session.field === 'age') {
    const age = Number(body.trim());
    if (!Number.isInteger(age) || age < 10 || age > 100) {
      await message.reply('Usia harus angka (10–100).');
      return;
    }
    updateRespondent(chatId, { age });
    editDataSessions.delete(chatId);
    await message.reply(`Usia diubah ke ${age}.`);
    return;
  }

  if (session.field === 'gender') {
    const gender = (lower === '1' || lower.includes('laki')) ? 'Laki-laki'
                 : (lower === '2' || lower.includes('perempuan')) ? 'Perempuan'
                 : '';
    if (!gender) {
      await message.reply('Ketik 1 atau 2.');
      return;
    }
    updateRespondent(chatId, { gender });
    editDataSessions.delete(chatId);
    await message.reply(`Jenis kelamin diubah ke ${gender}.`);
    return;
  }

  if (session.field === 'occupation') {
    const occupation = body.replace(/\s+/g, ' ').trim();
    if (occupation.length < 2 || occupation.length > 120) {
      await message.reply('Harus 2–120 karakter.');
      return;
    }
    updateRespondent(chatId, { occupation });
    editDataSessions.delete(chatId);
    await message.reply(`Pekerjaan diubah ke ${occupation}.`);
    return;
  }
}

async function handleDeleteData(message, args) {
  const confirmation = args.join(' ').trim().toLowerCase();
  if (confirmation !== 'confirm') {
    await message.reply(`Ini akan menghapus semua data (tidak bisa dibatalkan):
registrasi, reminder, log, audio

Ketik deletedata confirm untuk lanjut.`);
    return;
  }

  const audioFilenames = deleteRespondentData(message.from);
  deleteResearchAudioFiles(audioFilenames);
  pendingConfirmations.delete(message.from);
  editDataSessions.delete(message.from);
  logger.info('User menghapus data pribadi.', { chatId: message.from, audioCount: audioFilenames.length });
  await message.reply('Data dihapus. Ketik register untuk daftar ulang.');
}

async function sendServerTime(message) {
  const serverNow = dayjs().tz(config.timezone).format('DD MMM YYYY HH:mm:ss');
  await message.reply(`${serverNow} (${config.timezone})`);
}

async function sendList(message) {
  const tasks = listTasks(message.from, { includeOverdue: true });
  if (!tasks.length) {
    await message.reply('Belum ada reminder aktif.');
    return;
  }
  const now = Date.now();
  const lines = tasks.map((t) => {
    const deadline = dayjs(t.deadline_ms).tz(config.timezone).format('DD MMM YYYY HH:mm');
    const suffix = t.deadline_ms <= now ? ' (terlewat)' : '';
    return `${t.id}. ${t.title} — ${deadline}${suffix}`;
  }).join('\n');
  await message.reply(lines);
}

async function handleDone(message, args) {
  const id = parseInt(args[0], 10);
  if (!id) {
    await message.reply('done <id>  — ketik list untuk lihat ID');
    return;
  }
  const ok = markDone(id, message.from);
  if (ok) {
    cancelReminders(id);
    const remaining = listTasks(message.from);
    const suffix = remaining.length ? ` (${remaining.length} tersisa)` : ' Semua selesai.';
    await message.reply(`Tugas ${id} selesai.${suffix}`);
  } else {
    await message.reply('ID tidak ditemukan. Cek: list');
  }
}

async function handleDelete(message, args) {
  const id = parseInt(args[0], 10);
  if (!id) {
    await message.reply('delete <id>  — ketik list untuk lihat ID');
    return;
  }
  cancelReminders(id);
  const ok = deleteTask(id, message.from);
  if (ok) {
    const remaining = listTasks(message.from);
    const suffix = remaining.length ? ` (${remaining.length} tersisa)` : ' Semua selesai.';
    await message.reply(`Tugas ${id} dihapus.${suffix}`);
  } else {
    await message.reply('ID tidak ditemukan. Cek: list');
  }
}

async function handleReschedule(message, args) {
  const id = parseInt(args.shift(), 10);
  const newTimeStr = args.join(' ');
  if (!id || !newTimeStr) {
    await message.reply('reschedule <id> <YYYY-MM-DD HH:mm>\nContoh: reschedule 3 2026-08-01 14:00');
    return;
  }
  const parsed = dayjs.tz(newTimeStr, 'YYYY-MM-DD HH:mm', config.timezone, true);
  const dt = parsed.isValid() ? parsed : dayjs.tz(newTimeStr, config.timezone);
  if (!dt.isValid()) {
    await message.reply('Format salah. Contoh: 2026-08-01 14:00');
    return;
  }
  const newMs = dt.valueOf();
  const ok = rescheduleTask(id, message.from, newMs);
  if (!ok) {
    await message.reply('ID tidak ditemukan. Cek: list');
    return;
  }
  const task = getTask(id);
  rescheduleTaskReminders(task, ctx.client);
  await message.reply(`Tugas ${id} dijadwalkan ulang: ${dt.tz(config.timezone).format('DD MMM YYYY HH:mm')}`);
}

async function handleSnooze(message, args) {
  const id = parseInt(args[0], 10);
  if (!id) {
    await message.reply('snooze <id> [menit]\nContoh: snooze 3 atau snooze 3 60');
    return;
  }
  const rawMin = args[1] ? parseInt(args[1], 10) : 30;
  if (!Number.isInteger(rawMin) || rawMin < 1 || rawMin > 1440) {
    await message.reply('Durasi 1–1440 menit.');
    return;
  }
  const task = getTask(id);
  if (!task || task.chat_id !== message.from || task.status !== 'pending') {
    await message.reply('ID tidak ditemukan. Cek: list');
    return;
  }
  scheduleSnooze(task, rawMin * 60 * 1000, ctx.client);
  const label = rawMin >= 60
    ? `${Math.floor(rawMin / 60)} jam${rawMin % 60 ? ` ${rawMin % 60} menit` : ''}`
    : `${rawMin} menit`;
  await message.reply(`"${task.title}" — diingatkan lagi dalam ${label}.`);
}

async function handleResearchStats(message) {
  if (!(await isAdminMessage(message))) {
    await message.reply('Hanya untuk admin.');
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

function deleteResearchAudioFiles(audioFilenames) {
  for (const filename of audioFilenames) {
    if (!/^vn-[A-Za-z0-9-]+\.wav$/.test(filename)) continue;
    const filePath = path.join(config.researchAudioDir, filename);
    if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
  }
}
