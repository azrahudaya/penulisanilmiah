import wweb from 'whatsapp-web.js';
const { Poll } = wweb;

import { ctx, REGISTRATION_POLL_TTL_MS } from '../context.js';
import {
  getRespondent,
  startRespondentRegistration,
  updateRespondent,
  getRespondentByRegistrationPollMessageId,
  isRegistrationEnabled,
} from '../db.js';
import { cachePollOptions, extractBareMessageId } from '../whatsapp/patches.js';
import { sendTrackedPoll, monitorPollVotes } from '../whatsapp/poll-tracker.js';
import { DEFAULT_REMINDER_OFFSET_KEYS } from '../scheduler.js';
import { parseReminderOffsets } from '../utils.js';
import { logger } from '../logger.js';

export async function handleRegistrationGate(message) {
  const chatId = message.from;
  if (message.fromMe) return false;
  if (!isRegistrationEnabled()) return false;

  const body = message.type === 'chat' ? message.body.trim() : '';
  const lower = body.toLowerCase();
  let respondent = getRespondent(chatId);

  if (!respondent || lower === 'register') {
    startRespondentRegistration(chatId);
    updateRespondent(chatId, { registrationStep: 'name' });
    await message.reply(`Halo! Sebelum mulai, perlu data singkat untuk penelitian.\n\nNama kamu?`);
    return true;
  }

  if (respondent.registration_step === 'not_started') {
    startRespondentRegistration(chatId);
    updateRespondent(chatId, { registrationStep: 'name' });
    await message.reply(`Halo! Sebelum mulai, perlu data singkat untuk penelitian.\n\nNama kamu?`);
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
    await message.reply('Sesi pendaftaran habis. Ketik register untuk mulai ulang.');
    return true;
  }

  if (respondent.consent_status === 'declined' || respondent.registration_step === 'declined') {
    await message.reply('Belum ada persetujuan, bot tidak aktif. Ketik register untuk daftar ulang.');
    return true;
  }

  if (message.type !== 'chat') {
    await message.reply('Selesaikan pendaftaran dulu.');
    return true;
  }

  await handleRegistrationTextStep(message, respondent, body);
  return true;
}

export async function handleRegistrationTextStep(message, respondent, body) {
  const chatId = message.from;
  const lower = body.toLowerCase();
  const step = respondent.registration_step || 'name';

  if (step === 'name') {
    const name = body.replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 80) {
      await message.reply('Nama harus 2–80 karakter.');
      return;
    }
    const firstName = name.split(/\s+/)[0];
    updateRespondent(chatId, { name, registrationStep: 'age' });
    await message.reply(`Oke ${firstName}, berapa usia kamu?`);
    return;
  }

  if (step === 'age') {
    const age = Number(body);
    if (!Number.isInteger(age) || age < 10 || age > 100) {
      await message.reply('Usia harus angka. Contoh: 21');
      return;
    }
    updateRespondent(chatId, { age, registrationStep: 'gender' });
    await sendGenderPoll(chatId, message);
    return;
  }

  if (step === 'gender') {
    const gender = parseGenderChoice(lower);
    if (!gender) {
      await message.reply('Pilih dari polling, atau ketik 1 / 2.');
      return;
    }
    updateRespondent(chatId, { gender, registrationStep: 'occupation', genderPollMessageId: '' });
    await message.reply('Pekerjaan kamu? (contoh: mahasiswa, karyawan, freelancer)');
    return;
  }

  if (step === 'occupation') {
    const occupation = body.replace(/\s+/g, ' ').trim();
    if (occupation.length < 2 || occupation.length > 120) {
      await message.reply('Harus 2–120 karakter.');
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

export async function sendGenderPoll(chatId, message) {
  const GENDER_OPTIONS = ['Laki-laki', 'Perempuan'];
  try {
    const pollMessage = await sendTrackedPoll(
      chatId,
      new Poll('Jenis kelamin kamu?', GENDER_OPTIONS, { allowMultipleAnswers: false })
    );
    const pollMessageId = extractBareMessageId(pollMessage?.id?._serialized);
    if (pollMessageId) {
      await cachePollOptions(pollMessageId, GENDER_OPTIONS);
      updateRespondent(chatId, { genderPollMessageId: pollMessageId });
    }
    monitorPollVotes(pollMessage);
  } catch {
    await message.reply('Jenis kelamin kamu?\n1. Laki-laki\n2. Perempuan');
  }
}

export async function sendConsentPoll(chatId, message) {
  const CONSENT_OPTIONS = ['Ya, saya setuju', 'Tidak'];
  const text = `Data kamu dipakai untuk penelitian ilmiah dan dijaga kerahasiaannya.\n\nApakah kamu setuju?`;
  try {
    const pollMessage = await sendTrackedPoll(
      chatId,
      new Poll(text, CONSENT_OPTIONS, { allowMultipleAnswers: false })
    );
    const pollMessageId = extractBareMessageId(pollMessage?.id?._serialized);
    if (pollMessageId) {
      await cachePollOptions(pollMessageId, CONSENT_OPTIONS);
      updateRespondent(chatId, { consentPollMessageId: pollMessageId });
    }
    monitorPollVotes(pollMessage);
  } catch {
    await message.reply(`${text}\n1. Ya, saya setuju\n2. Tidak`);
  }
}

export async function handleRegistrationPollVote(pollMessageId, selected, pollChatId = '') {
  let respondent = getRespondentByRegistrationPollMessageId(pollMessageId);
  if (!respondent && pollChatId) {
    const candidate = getRespondent(pollChatId);
    if (
      (candidate?.registration_step === 'gender' && !candidate.gender_poll_message_id)
      || (candidate?.registration_step === 'consent' && !candidate.consent_poll_message_id)
    ) {
      respondent = candidate;
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
    await ctx.client.sendMessage(respondent.chat_id, 'Sesi pendaftaran habis. Ketik register untuk mulai ulang.');
    return true;
  }

  if (respondent.registration_step === 'gender') {
    const gender = selected.includes('laki') ? 'Laki-laki' : selected.includes('perempuan') ? 'Perempuan' : '';
    if (!gender) return true;
    updateRespondent(respondent.chat_id, { gender, registrationStep: 'occupation', genderPollMessageId: '' });
    await ctx.client.sendMessage(respondent.chat_id, 'Pekerjaan kamu? (contoh: mahasiswa, karyawan, freelancer)');
    return true;
  }

  if (respondent.registration_step === 'consent') {
    const consent = selected.includes('setuju') ? 'consented' : selected.includes('tidak') ? 'declined' : '';
    if (!consent) return true;
    await completeRegistrationConsent(respondent.chat_id, consent, (text) => ctx.client.sendMessage(respondent.chat_id, text));
    return true;
  }

  return true;
}

export async function completeRegistrationConsent(chatId, consentStatus, reply) {
  const respondent = getRespondent(chatId);
  if (consentStatus === 'declined') {
    updateRespondent(chatId, {
      consentStatus: 'declined',
      registrationStep: 'declined',
      consentPollMessageId: '',
    });
    await reply('Pendaftaran dibatalkan. Ketik register kalau mau coba lagi.');
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
  await reply(`Halo ${firstName}! Pendaftaran selesai.

Buat reminder — kirim VN atau teks:
"ingatkan besok jam 9 meeting"

Ketik help untuk panduan.`);
}

export function isRegistrationPollExpired(respondent) {
  const updatedAt = Number(respondent?.updated_at || Date.now());
  return Date.now() - updatedAt > REGISTRATION_POLL_TTL_MS;
}

export function parseGenderChoice(value) {
  if (value === '1' || value.includes('laki')) return 'Laki-laki';
  if (value === '2' || value.includes('perempuan')) return 'Perempuan';
  return '';
}

export function parseConsentChoice(value) {
  if (value === '1' || value.includes('setuju') || value === 'ya') return 'consented';
  if (value === '2' || value.includes('tidak')) return 'declined';
  return '';
}
