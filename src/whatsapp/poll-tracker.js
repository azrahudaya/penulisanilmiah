import { logger } from '../logger.js';
import { ctx, pendingPollTrackers, PENDING_CONFIRMATION_TTL_MS } from '../context.js';

export async function sendTrackedPoll(chatId, poll) {
  const trackedMessage = waitForSentPoll(chatId, poll.pollName);
  let pollMessage = await ctx.client.sendMessage(chatId, poll, { sendSeen: false });
  pollMessage ||= await trackedMessage;
  return pollMessage;
}

function waitForSentPoll(chatId, pollName) {
  return new Promise((resolve) => {
    const tracker = {
      chatId,
      pollName,
      resolve: (msg) => {
        clearTimeout(timeout);
        pendingPollTrackers.delete(tracker);
        resolve(msg);
      },
    };
    const timeout = setTimeout(() => tracker.resolve(null), 5000);
    timeout.unref();
    pendingPollTrackers.add(tracker);
  });
}

// Interval-polls getPollVotes() as fallback when vote_update event doesn't fire.
// Uses dynamic import to avoid circular dependency with handlers/poll.js.
export function monitorPollVotes(pollMessage) {
  if (!pollMessage) return;
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const votes = await pollMessage.getPollVotes();
      const vote = votes.find((item) => item.selectedOptions?.length);
      if (!vote) return;
      clearInterval(timer);
      const { handlePollVote } = await import('../handlers/poll.js');
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
