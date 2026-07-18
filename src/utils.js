import { config } from './config.js';
import { REMINDER_OFFSET_OPTIONS, DEFAULT_REMINDER_OFFSET_KEYS } from './scheduler.js';
import { SMALL_TALK_INPUTS, ctx } from './context.js';

export function isGroupChatId(chatId) {
  return String(chatId || '').endsWith('@g.us');
}

export function isAdminCommand(body = '') {
  const [cmd] = String(body).trim().toLowerCase().split(/\s+/);
  return cmd === 'researchstats';
}

export function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

export async function isAdminMessage(message) {
  if (!config.adminPhone) return false;
  const identifiers = [message.from];
  if (String(message.from || '').endsWith('@lid')) {
    try {
      const contacts = await ctx.client?.getContactLidAndPhone([message.from]).catch(() => []);
      const mapped = contacts?.[0];
      if (mapped?.pn) identifiers.push(mapped.pn);
    } catch (_) {}
  }
  return identifiers.some((value) => normalizePhone(value) === normalizePhone(config.adminPhone));
}

export function isSmallTalkText(text) {
  const normalized = text.trim().toLowerCase();
  if (SMALL_TALK_INPUTS.has(normalized)) return true;
  return normalized.length <= 2;
}

export function isCommandKeyword(cmd) {
  return new Set([
    'help', 'menu', 'profile', 'data', 'editdata', 'editprofile',
    'deletedata', 'hapusdata', 'time', 'now', 'list', 'done',
    'delete', 'del', 'reschedule', 'resched', 'snooze', 'researchstats',
  ]).has(cmd);
}

export function parseReminderOffsets(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function formatReminderPreference(value) {
  const keys = parseReminderOffsets(value);
  const activeKeys = keys.length ? keys : DEFAULT_REMINDER_OFFSET_KEYS;
  return REMINDER_OFFSET_OPTIONS.filter((item) => activeKeys.includes(item.key)).map((item) => item.label).join(', ');
}
