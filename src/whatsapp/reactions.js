import { logger } from '../logger.js';

// message.react() → sendReaction(id._serialized) → Msg.get() crashes for @lid.
// Bypass: grab bare ID from message.id.id, search Msg.models in-memory, call WA API directly.
export async function reactToMessage(message, emoji) {
  try {
    const bareId = message.id?.id || '';
    const serializedId = message.id?._serialized || '';
    if (!bareId && !serializedId) return;

    await message.client.pupPage.evaluate(async (bareId, serializedId, reaction) => {
      try {
        const Msg = window.require('WAWebCollections').Msg;
        let msg = null;

        if (serializedId) {
          try { msg = Msg.get(serializedId) || null; } catch (_) {}
        }

        if (!msg && bareId) {
          msg = Msg.models?.find((m) => {
            const key = m.get?.('id') || m.id;
            return key?.id === bareId;
          }) || null;
        }

        if (!msg) return;
        await window.require('WAWebSendReactionMsgAction').sendReactionToMsg(msg, reaction);
      } catch (_) {}
    }, bareId, serializedId, emoji);
  } catch (err) {
    logger.warn('Gagal react ke message.', { message: err.message });
  }
}
