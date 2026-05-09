import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

dayjs.extend(customParseFormat);

export function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function calculateWer(reference, hypothesis) {
  if (!reference.trim()) {
    throw new Error('Transcript ground truth wajib diisi.');
  }

  const refWords = reference.toLowerCase().split(/\s+/).filter(Boolean);
  const hypWords = hypothesis.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = refWords.length + 1;
  const cols = hypWords.length + 1;
  const dp = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ d: 0, s: 0, del: 0, ins: 0 })));

  for (let i = 1; i < rows; i += 1) {
    const prev = dp[i - 1][0];
    dp[i][0] = { d: prev.d + 1, s: prev.s, del: prev.del + 1, ins: prev.ins };
  }
  for (let j = 1; j < cols; j += 1) {
    const prev = dp[0][j - 1];
    dp[0][j] = { d: prev.d + 1, s: prev.s, del: prev.del, ins: prev.ins + 1 };
  }

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      if (refWords[i - 1] === hypWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
        continue;
      }
      const sub = dp[i - 1][j - 1];
      const del = dp[i - 1][j];
      const ins = dp[i][j - 1];
      dp[i][j] = [
        { d: sub.d + 1, s: sub.s + 1, del: sub.del, ins: sub.ins },
        { d: del.d + 1, s: del.s, del: del.del + 1, ins: del.ins },
        { d: ins.d + 1, s: ins.s, del: ins.del, ins: ins.ins + 1 },
      ].sort((a, b) => a.d - b.d)[0];
    }
  }

  const result = dp[rows - 1][cols - 1];
  return {
    wer: refWords.length ? result.d / refWords.length : 0,
    substitutions: result.s,
    deletions: result.del,
    insertions: result.ins,
    total_ref_words: refWords.length,
  };
}

function similarity(left, right) {
  const a = String(left || '').toLowerCase();
  const b = String(right || '').toLowerCase();
  if (!a && !b) return 1;
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return 1 - matrix[a.length][b.length] / Math.max(a.length, b.length, 1);
}

function taskDate(task) {
  if (task.deadline_iso) return String(task.deadline_iso).slice(0, 10);
  return task.date || '';
}

function taskMinutes(task) {
  let time = task.time || '';
  if (task.deadline_iso && String(task.deadline_iso).includes('T')) {
    time = String(task.deadline_iso).split('T')[1].slice(0, 5);
  }
  const match = String(time).match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function calculateExtractionMetrics(extracted, groundTruth) {
  const matched = new Set();
  const details = [];
  let tp = 0;

  extracted.forEach((item, index) => {
    let best = null;
    groundTruth.forEach((gt, gtIndex) => {
      if (matched.has(gtIndex)) return;
      const score = similarity(item.title, gt.title);
      if (!best || score > best.score) {
        best = {
          gtIndex,
          score,
          dateMatch: taskDate(item) === taskDate(gt),
          timeMatch: taskMinutes(item) != null && taskMinutes(gt) != null && Math.abs(taskMinutes(item) - taskMinutes(gt)) <= 30,
        };
      }
    });
    const ok = Boolean(best && best.score > 0.7 && best.dateMatch && best.timeMatch);
    if (ok) {
      tp += 1;
      matched.add(best.gtIndex);
    }
    details.push({
      extracted_index: index,
      extracted_title: item.title || '',
      matched: ok,
      matched_ground_truth_index: best?.gtIndex ?? '',
      title_similarity: best ? Number(best.score.toFixed(3)) : 0,
      date_match: best?.dateMatch || false,
      time_match: best?.timeMatch || false,
    });
  });

  const precision = extracted.length ? tp / extracted.length : 0;
  const recall = groundTruth.length ? tp / groundTruth.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, details };
}

export function validateGroundTruthTasks(tasks) {
  if (!tasks.length) throw new Error('Minimal satu ground truth task.');
  tasks.forEach((task, index) => {
    if (!task.title || !task.date || !task.time) throw new Error(`Task #${index + 1} belum lengkap.`);
    if (!dayjs(task.date, 'YYYY-MM-DD', true).isValid()) throw new Error(`Tanggal task #${index + 1} tidak valid.`);
    if (!/^\d{2}:\d{2}$/.test(task.time)) throw new Error(`Jam task #${index + 1} harus HH:mm.`);
  });
}
