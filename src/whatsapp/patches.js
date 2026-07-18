import { ctx } from '../context.js';
import { listAllPendingConfirmations, listRespondents } from '../db.js';
import { logger } from '../logger.js';

export function extractBareMessageId(serialized) {
  if (!serialized) return '';
  const parts = serialized.split('_');
  if (parts.length >= 3) return parts.slice(2).join('_');
  return serialized;
}

export async function cachePollOptions(pollMessageId, options) {
  try {
    await ctx.client.pupPage.evaluate((id, opts) => {
      window._wwebjsPollOptions = window._wwebjsPollOptions || {};
      window._wwebjsPollOptions[id] = opts;
    }, pollMessageId, options);
  } catch (_) {}
}

export async function prePopulatePollCache() {
  try {
    const confirmations = listAllPendingConfirmations();
    for (const pc of confirmations) {
      if (pc.pollMessageId) await cachePollOptions(pc.pollMessageId, ['Simpan', 'Edit', 'Batal']);
    }
    const respondents = listRespondents();
    for (const r of respondents) {
      if (r.gender_poll_message_id) await cachePollOptions(r.gender_poll_message_id, ['Laki-laki', 'Perempuan']);
      if (r.consent_poll_message_id) await cachePollOptions(r.consent_poll_message_id, ['Ya, saya setuju', 'Tidak']);
    }
    const total = confirmations.filter(c => c.pollMessageId).length
      + respondents.filter(r => r.gender_poll_message_id || r.consent_poll_message_id).length;
    logger.info('Poll options cache pre-populated dari DB.', { total });
  } catch (err) {
    logger.warn('Gagal pre-populate poll cache.', { message: err.message });
  }
}

export async function patchPollVoteHandler() {
  ctx.client.pupPage.on('console', (msg) => {
    if (msg.text().startsWith('[PollPatch]')) logger.info(msg.text());
  });

  try {
    const result = await ctx.client.pupPage.evaluate(() => {
      try {
        const pollVoteModule = window.require('WAWebAddonPollVoteTableMode');
        if (!pollVoteModule) return { ok: false, reason: 'module WAWebAddonPollVoteTableMode tidak ada' };
        if (!pollVoteModule.pollVoteTableMode) return { ok: false, reason: 'pollVoteTableMode tidak ada' };

        const { Msg } = window.require('WAWebCollections');

        pollVoteModule.pollVoteTableMode.bulkUpsert = async (...args) => {
          const rawVotes = args[0] || [];
          console.log('[PollPatch] bulkUpsert, jumlah:', rawVotes.length);

          const processedVotes = [];
          for (const vote of rawVotes) {
            try {
              const parentMsgKey = vote.pollUpdateParentKey;
              // Bare ID — consistent with how we store in DB and cache
              const bareId = String(parentMsgKey?.id || '');

              const senderModel = vote.author ?? vote.from;
              const senderUserJid = String(senderModel?._serialized || senderModel?.user || '');

              let parentMessage = null;
              const remote = parentMsgKey?.remote;
              const remoteStr = remote?._serialized || (remote?.user ? `${remote.user}@${remote.server || 'lid'}` : '');
              const fullKey = bareId && remoteStr ? `${parentMsgKey.fromMe}_${remoteStr}_${bareId}` : '';
              if (fullKey) {
                try { parentMessage = Msg.get(fullKey) || null; } catch (_) {}
                if (!parentMessage) {
                  try {
                    const fetched = await Msg.getMessagesById([fullKey]);
                    parentMessage = fetched?.messages?.[0] || null;
                  } catch (_) {}
                }
              }
              if (!parentMessage) {
                const cachedOpts = window._wwebjsPollOptions?.[bareId];
                if (cachedOpts) {
                  parentMessage = { pollOptions: cachedOpts.map((name, idx) => ({ name, localId: idx })) };
                  console.log('[PollPatch] cache hit, bareId:', bareId);
                } else {
                  console.log('[PollPatch] cache miss, bareId:', bareId, '| fullKey:', fullKey, '| keys:', Object.keys(window._wwebjsPollOptions || {}).join(','));
                }
              }

              // PollVote._patch in v1.34.7 expects: sender, selectedOptionLocalIds, senderTimestampMs
              const selectedOptionLocalIds = (vote.selectedOptionLocalIds || []).map(id => Number(id));

              processedVotes.push({
                sender: senderUserJid,
                selectedOptionLocalIds,
                senderTimestampMs: Number(vote.senderTimestampMs ?? vote.t ?? 0),
                parentMsgKey: { _serialized: bareId },
                parentMessage: parentMessage ? {
                  id: { id: '', remote: '', fromMe: false, _serialized: '' },
                  pollOptions: (parentMessage.pollOptions || []).map(o => ({
                    name: String(o.name || ''),
                    localId: Number(o.localId ?? 0),
                  })),
                } : null,
              });
            } catch (err) {
              console.log('[PollPatch] error proses vote:', String(err?.message || err));
            }
          }

          console.log('[PollPatch] onPollVoteEvent dengan', processedVotes.length, 'vote, parentKey:', processedVotes[0]?.parentMsgKey?._serialized);
          try {
            await window.onPollVoteEvent(processedVotes);
          } catch (err) {
            console.log('[PollPatch] onPollVoteEvent ERROR:', String(err?.message || err));
          }
        };
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: String(err?.message || err) };
      }
    });

    if (result.ok) {
      logger.info('Poll vote handler berhasil di-patch untuk @lid support.');
    } else {
      logger.warn('Poll vote handler tidak bisa di-patch.', { reason: result.reason });
    }
  } catch (err) {
    logger.warn('Gagal menjalankan patch poll vote handler.', { message: err.message });
  }
}
