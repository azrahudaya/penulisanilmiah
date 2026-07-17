import OpenAI from 'openai';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import { config } from './config.js';
import { logger } from './logger.js';

const openai = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey }) : null;
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const DEFAULT_TIME_BUCKETS = {
  malam: '21:00',
  siang: '13:00',
  pagi: '09:00',
  sore: '17:00'
};

const WEEKDAY_MAP = {
  minggu: 0,
  ahad: 0,
  senin: 1,
  selasa: 2,
  rabu: 3,
  kamis: 4,
  jumat: 5,
  "jum'at": 5,
  sabtu: 6,
};

export async function extractTasks(inputText, { source = 'unknown' } = {}) {
  const result = await extractTasksWithRaw(inputText, { source });
  return result.tasks;
}

export async function extractTasksWithRaw(inputText, { source = 'unknown' } = {}) {
  const now = dayjs().tz(config.timezone).format();

  const provider = config.taskParserProvider;
  const shouldUseOpenAI = openai && (provider === 'openai' || provider === 'auto');
  if (!shouldUseOpenAI) {
    const tasks = normalizeExtractedTasks(parseRuleBasedTasks(inputText), inputText);
    return { tasks, rawResponse: JSON.stringify({ provider: 'rule_based', tasks }) };
  }

  const system = `Anda adalah asisten untuk mengekstrak tugas dari teks chat/transkrip voice note bahasa Indonesia. ` +
    `Input bisa sangat bebas dan tidak mengikuti template. ` +
    `Jangan minta user mengikuti format tertentu. ` +
    `Pertahankan gaya bahasa user sebisa mungkin pada title, cukup rapikan agar singkat dan jelas. ` +
    `Gunakan zona waktu ${config.timezone}. Jika disebut 'malam' gunakan ${DEFAULT_TIME_BUCKETS.malam}, 'siang' ${DEFAULT_TIME_BUCKETS.siang}, 'pagi' ${DEFAULT_TIME_BUCKETS.pagi}, 'sore' ${DEFAULT_TIME_BUCKETS.sore}. ` +
    `Output wajib JSON dengan schema: {"tasks":[{"title":"tugas...","deadline_iso":"YYYY-MM-DDTHH:mm:ss+07:00"}]}. ` +
    `deadline_iso harus memakai zona waktu lokal ${config.timezone}, bukan UTC/Z, kecuali user menyebut zona waktu lain secara eksplisit. ` +
    `Jika deadline tidak disebut, tebak sebaik mungkin (gunakan default jam ${DEFAULT_TIME_BUCKETS.malam} hari ini/berikutnya sesuai konteks). ` +
    `Boleh lebih dari satu tugas dari satu kalimat. Jangan tambahkan teks lain.`;

  const user = `Waktu sekarang: ${now}. Tipe input: ${source}. Isi: ${inputText}`;
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
    });
    const rawResponse = resp.choices[0].message.content || '';
    const parsed = JSON.parse(rawResponse);
    if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
      throw new Error('Output tidak valid');
    }
    return { tasks: normalizeExtractedTasks(parsed.tasks, inputText), rawResponse };
  } catch (err) {
    if (err?.code === 'insufficient_quota' || err?.status === 429) {
      logger.warn('Extract tasks fallback karena OpenAI quota/rate-limit.');
    } else {
      logger.warn('Extract tasks fallback rule-based.', { message: err.message });
    }
    const tasks = parseRuleBasedTasks(inputText);
    return {
      tasks: normalizeExtractedTasks(tasks, inputText),
      rawResponse: JSON.stringify({
        provider: 'rule_based_fallback',
        error: err?.message || String(err),
        tasks,
      }),
    };
  }
}

function normalizeExtractedTasks(tasks, inputText = '') {
  const relativeDeadline = parseRelativeDeadline(inputText);
  return tasks.map((task) => ({
    ...task,
    deadline_iso: relativeDeadline || normalizeDeadlineIso(task.deadline_iso, inputText),
  }));
}

function normalizeDeadlineIso(value, inputText = '') {
  if (!value || typeof value !== 'string') return value;

  const trimmed = value.trim();
  const noExplicitTimezoneInText = !/\b(wib|wita|wit|utc|gmt)\b/i.test(inputText);
  const utcLikeMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)(?:Z|\+00:00)$/);
  if (utcLikeMatch && noExplicitTimezoneInText) {
    const time = utcLikeMatch[2].length === 5 ? `${utcLikeMatch[2]}:00` : utcLikeMatch[2];
    return dayjs.tz(`${utcLikeMatch[1]} ${time}`, 'YYYY-MM-DD HH:mm:ss', config.timezone).format();
  }

  const noZoneMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)$/);
  if (noZoneMatch) {
    const time = noZoneMatch[2].length === 5 ? `${noZoneMatch[2]}:00` : noZoneMatch[2];
    return dayjs.tz(`${noZoneMatch[1]} ${time}`, 'YYYY-MM-DD HH:mm:ss', config.timezone).format();
  }

  return trimmed;
}

function parseRelativeDeadline(inputText) {
  const lower = inputText.toLowerCase();
  const now = dayjs().tz(config.timezone);

  const relativeMatch = lower.match(/\b(?:dalam\s+)?(\d+)\s*(menit|minute|minutes|jam|hour|hours|hari|day|days)\s*(?:lagi|dari sekarang)?\b/);
  if (relativeMatch && (/\b(lagi|dari sekarang|dalam)\b/.test(lower))) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2];
    if (unit === 'menit' || unit.startsWith('minute')) return now.add(amount, 'minute').second(0).millisecond(0).format();
    if (unit === 'jam' || unit.startsWith('hour')) return now.add(amount, 'hour').second(0).millisecond(0).format();
    if (unit === 'hari' || unit.startsWith('day')) return now.add(amount, 'day').second(0).millisecond(0).format();
  }

  if (/\bsetengah\s+jam\s*(lagi|dari sekarang)?\b/.test(lower)) {
    return now.add(30, 'minute').second(0).millisecond(0).format();
  }

  return '';
}

function parseRuleBasedTasks(text) {
  const chunks = text
    .split(/\n|[,;]+|\s+lalu\s+|\s+kemudian\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (const chunk of chunks) {
    const deadline = inferDeadlineFromText(chunk);
    const title = normalizeTitle(chunk);
    if (!title) continue;
    out.push({ title, deadline_iso: deadline.format() });
  }

  if (out.length) return out;

  const fallbackDeadline = dayjs().tz(config.timezone).hour(21).minute(0).second(0).millisecond(0);
  if (fallbackDeadline.isBefore(dayjs().tz(config.timezone))) {
    return [{ title: text.trim(), deadline_iso: fallbackDeadline.add(1, 'day').format() }];
  }
  return [{ title: text.trim(), deadline_iso: fallbackDeadline.format() }];
}

function inferDeadlineFromText(text) {
  const now = dayjs().tz(config.timezone);
  const dateInfo = parseDateFromText(text, now);
  const timeInfo = parseTimeFromText(text);

  let target = dateInfo.date
    .hour(timeInfo.hour)
    .minute(timeInfo.minute)
    .second(0)
    .millisecond(0);

  if (!dateInfo.hasExplicitDate && target.isBefore(now)) {
    target = target.add(1, 'day');
  }
  if (dateInfo.isWeekday && target.isBefore(now)) {
    target = target.add(7, 'day');
  }

  return target;
}

function parseDateFromText(text, now) {
  const lower = text.toLowerCase();
  let base = now.startOf('day');
  let hasExplicitDate = false;
  let isWeekday = false;

  if (/\blusa\b/.test(lower)) {
    return { date: base.add(2, 'day'), hasExplicitDate: true, isWeekday: false };
  }
  if (/\bbesok\b/.test(lower)) {
    return { date: base.add(1, 'day'), hasExplicitDate: true, isWeekday: false };
  }
  if (/\bhari ini\b/.test(lower)) {
    return { date: base, hasExplicitDate: true, isWeekday: false };
  }

  const weekdayMatch = lower.match(/\b(minggu|ahad|senin|selasa|rabu|kamis|jum(?:'|\u2019)?at|jumat|sabtu)\b/);
  if (weekdayMatch) {
    const raw = weekdayMatch[1].replace('\u2019', "'");
    const targetDow = WEEKDAY_MAP[raw];
    if (typeof targetDow === 'number') {
      const diff = (targetDow - now.day() + 7) % 7;
      base = base.add(diff, 'day');
      hasExplicitDate = true;
      isWeekday = true;
    }
  }

  const fullDateMatch = lower.match(/\b(?:tanggal\s+)?(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (fullDateMatch) {
    const d = Number(fullDateMatch[1]);
    const m = Number(fullDateMatch[2]);
    let y = Number(fullDateMatch[3] || now.year());
    if (y < 100) y += 2000;
    let parsed = dayjs.tz(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} 00:00`, 'YYYY-MM-DD HH:mm', config.timezone, true);
    if (!parsed.isValid()) parsed = base;
    if (!fullDateMatch[3] && parsed.isBefore(now.startOf('day'))) {
      parsed = parsed.add(1, 'year');
    }
    return { date: parsed.startOf('day'), hasExplicitDate: true, isWeekday: false };
  }

  const domMatch = lower.match(/\btanggal\s+(\d{1,2})\b/);
  if (domMatch) {
    const dom = Number(domMatch[1]);
    if (dom >= 1 && dom <= 31) {
      let parsed = now.date(dom).startOf('day');
      if (parsed.isBefore(now.startOf('day'))) {
        parsed = parsed.add(1, 'month');
      }
      return { date: parsed, hasExplicitDate: true, isWeekday: false };
    }
  }

  return { date: base, hasExplicitDate, isWeekday };
}

function parseTimeFromText(text) {
  const lower = text.toLowerCase();
  let hour = 21;
  let minute = 0;

  if (/\bpagi\b/.test(lower)) {
    hour = 9;
  } else if (/\bsiang\b/.test(lower)) {
    hour = 13;
  } else if (/\bsore\b/.test(lower)) {
    hour = 17;
  } else if (/\bmalam\b/.test(lower)) {
    hour = 21;
  }

  const withJam = lower.match(/\bjam\s*(\d{1,2})(?:[:.](\d{1,2}))?\s*(pagi|siang|sore|malam|am|pm)?\b/);
  const plain = lower.match(/\b(\d{1,2})[:.](\d{1,2})\s*(pagi|siang|sore|malam|am|pm)?\b/);
  const match = withJam || plain;

  if (match) {
    hour = Number(match[1]);
    minute = Number(match[2] || 0);
    const meridiem = (match[3] || '').toLowerCase();

    if (Number.isNaN(hour) || Number.isNaN(minute)) {
      hour = 21;
      minute = 0;
    } else {
      hour = Math.min(Math.max(hour, 0), 23);
      minute = Math.min(Math.max(minute, 0), 59);

      if (meridiem === 'pagi' || meridiem === 'am') {
        if (hour === 12) hour = 0;
      } else if (meridiem === 'siang' || meridiem === 'pm') {
        if (hour < 12) hour += 12;
      } else if (meridiem === 'sore' || meridiem === 'malam') {
        if (hour < 12) hour += 12;
      }
    }
  }

  return { hour, minute };
}

function normalizeTitle(text) {
  let title = text.trim();

  title = title.replace(/^(tolong\s+)?(ingatkan\s+saya|ingetin\s+saya|ingatkan|ingetin|remind\s+me|reminder)\s*/i, '');
  title = title.replace(/\b(tolong|please|nanti)\b/gi, ' ');
  title = title.replace(/\b(hari ini|besok|lusa)\b/gi, ' ');
  title = title.replace(/\b(minggu|ahad|senin|selasa|rabu|kamis|jum(?:'|\u2019)?at|jumat|sabtu)\b/gi, ' ');
  title = title.replace(/\b(pagi|siang|sore|malam)\b/gi, ' ');
  title = title.replace(/\btanggal\s+\d{1,2}(?:[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)?\b/gi, ' ');
  title = title.replace(/\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b/gi, ' ');
  title = title.replace(/\bjam\s*\d{1,2}(?:[:.]\d{1,2})?\s*(pagi|siang|sore|malam|am|pm)?\b/gi, ' ');
  title = title.replace(/\b\d{1,2}[:.]\d{1,2}\s*(pagi|siang|sore|malam|am|pm)?\b/gi, ' ');
  title = title.replace(/\b(wib|wita|wit)\b/gi, ' ');
  title = title.replace(/\s+/g, ' ').trim();

  if (!title) return text.trim();
  return title;
}

export function formatTasksForMessage(tasks) {
  return tasks
    .map((t, idx) => {
      const timeStr = dayjs(t.deadline_iso).tz(config.timezone).format('DD MMM YYYY HH:mm');
      return `${idx + 1}. ${t.title} - ${timeStr}`;
    })
    .join('\n');
}

export function deadlineMsFromIso(iso) {
  return dayjs(iso).valueOf();
}
