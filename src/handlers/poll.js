import { ctx } from '../context.js';
import {
  getPendingConfirmationByPollMessageId,
  getPendingConfirmation,
  getRespondent,
  updateRespondent,
} from '../db.js';
import { handleRegistrationPollVote, completeRegistrationConsent } from './registration.js';
import {
  completePendingConfirmation,
  isPendingExpired,
  expirePendingConfirmation,
  getActivePendingConfirmation,
} from './confirmation.js';
import { logger } from '../logger.js';

export async function handlePollVote(vote) {
  if (!Array.isArray(vote.selectedOptions)) return;

  // parentMsgKey._serialized is the bare ID populated by patchPollVoteHandler
  const pollMessageId = vote.parentMsgKey?._serialized || '';
  const voterChatId = vote.voter || '';

  logger.info('vote_update event diterima.', {
    voter: voterChatId,
    selectedCount: vote.selectedOptions?.length,
    selectedOptions: JSON.stringify(vote.selectedOptions),
    parentMsgKey: pollMessageId,
    parentMessageHasPollOptions: !!vote.parentMessage?.pollOptions?.length,
  });

  if (!pollMessageId) {
    logger.warn('Poll vote: pollMessageId kosong, fallback via voter.', { voterChatId });
    if (voterChatId) await handlePollVoteByVoter(voterChatId, vote.selectedOptions);
    return;
  }

  const pollMessage = vote.parentMessage;
  const selectedOption = vote.selectedOptions[0];
  const selected = String(
    selectedOption?.name
    || pollMessage?.pollOptions?.find((option) => String(option.localId) === String(selectedOption?.localId))?.name
    || ''
  ).toLowerCase();
  const pollChatId = pollMessage?.to || pollMessage?.id?.remote?._serialized || pollMessage?.id?.remote || voterChatId;
  logger.info('Poll vote diterima.', { pollMessageId, pollChatId, selected: selected || 'unknown' });

  if (selected && await handleRegistrationPollVote(pollMessageId, selected, pollChatId)) {
    return;
  }

  const pendingById = getPendingConfirmationByPollMessageId(pollMessageId);
  const pendingByChat = pollChatId ? getPendingConfirmation(pollChatId) : null;
  const pending = pendingById || (!pendingByChat?.pollMessageId ? pendingByChat : null);

  if (!pending || !selected) {
    logger.warn('Poll vote: DB miss atau selected kosong, fallback via voter.', { pollMessageId, voterChatId, selected: selected || 'none' });
    if (voterChatId) await handlePollVoteByVoter(voterChatId, vote.selectedOptions);
    return;
  }

  if (vote.selectedOptions.length !== 1) return;
  if (isPendingExpired(pending)) {
    expirePendingConfirmation(pending.chatId, pending);
    await ctx.client.sendMessage(pending.chatId, 'Konfirmasi kedaluwarsa. Kirim ulang.');
    return;
  }

  let action = null;
  if (selected.includes('simpan')) action = 'accepted';
  if (selected.includes('edit')) action = 'edited';
  if (selected.includes('batal')) action = 'cancelled';
  if (!action) return;

  await completePendingConfirmation(pending.chatId, action, (text) => ctx.client.sendMessage(pending.chatId, text));
}

export async function handlePollVoteByVoter(voterChatId, selectedOptions) {
  const localId = Number(selectedOptions?.[0]?.localId ?? -1);
  logger.info('handlePollVoteByVoter fallback.', { voterChatId, localId });
  if (localId === -1) return;

  const respondent = getRespondent(voterChatId);
  if (respondent?.registration_step === 'gender') {
    const gender = localId === 0 ? 'Laki-laki' : localId === 1 ? 'Perempuan' : '';
    if (!gender) return;
    updateRespondent(voterChatId, { gender, registrationStep: 'occupation', genderPollMessageId: '' });
    await ctx.client.sendMessage(voterChatId, 'Pekerjaan kamu? (contoh: mahasiswa, karyawan, freelancer)');
    return;
  }
  if (respondent?.registration_step === 'consent') {
    const consent = localId === 0 ? 'consented' : localId === 1 ? 'declined' : '';
    if (!consent) return;
    await completeRegistrationConsent(voterChatId, consent, (text) => ctx.client.sendMessage(voterChatId, text));
    return;
  }

  const pending = getActivePendingConfirmation(voterChatId);
  if (!pending) return;
  if (isPendingExpired(pending)) {
    expirePendingConfirmation(pending.chatId, pending);
    await ctx.client.sendMessage(pending.chatId, 'Konfirmasi kedaluwarsa. Kirim ulang.');
    return;
  }
  // Confirmation options: 0=Simpan, 1=Edit, 2=Batal
  const action = localId === 0 ? 'accepted' : localId === 1 ? 'edited' : localId === 2 ? 'cancelled' : null;
  if (!action) return;
  await completePendingConfirmation(pending.chatId, action, (text) => ctx.client.sendMessage(pending.chatId, text));
}
