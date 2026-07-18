export const pendingConfirmations = new Map();
export const pendingPollTrackers = new Set();
export const PENDING_CONFIRMATION_TTL_MS = 30 * 60 * 1000;
export const REGISTRATION_POLL_TTL_MS = 30 * 60 * 1000;
export const FEEDBACK_REPLY_TTL_MS = 5 * 60 * 1000;
export const POLL_TITLE_MAX_LENGTH = 240;
export const FEEDBACK_PROMPT_MIN_VOICE_NOTES = 10;
export const SMALL_TALK_INPUTS = new Set([
  'halo', 'hai', 'hi', 'p', 'ping', 'tes', 'test',
  'oke', 'ok', 'sip', 'thanks', 'thank you', 'makasih', 'terima kasih',
]);

// In-memory session for field-by-field editdata flow.
// Entries: { field: 'menu' | 'name' | 'age' | 'gender' | 'occupation' }
export const editDataSessions = new Map();

// Mutable reference to the WhatsApp client; set in index.js after Client is created.
export const ctx = { client: null };
