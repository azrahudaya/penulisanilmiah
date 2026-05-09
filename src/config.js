import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');
const envPath = path.join(projectRoot, '.env');

dotenv.config({ path: envPath, quiet: true, override: true });

function resolveFromProjectIfRelative(value) {
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function resolveExecutablePath(value) {
  if (!value) return '';
  if (path.isAbsolute(value)) return value;
  if (value.includes('/') || value.includes('\\') || value.startsWith('.')) {
    return path.resolve(projectRoot, value);
  }
  return value;
}

const dbPathRaw = process.env.DB_PATH || './data/tasks.db';
const whisperModelPathRaw = process.env.WHISPER_MODEL_PATH || '';
const whisperCppPathRaw = process.env.WHISPER_CPP_PATH || 'whisper-cli';
const researchModeRaw = process.env.RESEARCH_MODE || 'false';

function parseBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export const config = {
  openaiKey: process.env.OPENAI_API_KEY || '',
  timezone: process.env.TIMEZONE || 'Asia/Jakarta',
  dbPath: resolveFromProjectIfRelative(dbPathRaw),
  researchMode: parseBoolean(researchModeRaw),
  researchAudioDir: resolveFromProjectIfRelative(process.env.RESEARCH_AUDIO_DIR || './data/audio'),
  researchRetentionDays: Number(process.env.RESEARCH_RETENTION_DAYS || 180),
  maxVoiceNoteDurationMs: Number(process.env.MAX_VOICE_NOTE_DURATION_MS || 5 * 60 * 1000),
  maxVoiceNoteBytes: Number(process.env.MAX_VOICE_NOTE_BYTES || 15 * 1024 * 1024),
  adminPhone: process.env.ADMIN_PHONE || '',
  transcriptionProvider: (process.env.TRANSCRIPTION_PROVIDER || 'auto').toLowerCase(),
  taskParserProvider: (process.env.TASK_PARSER_PROVIDER || 'auto').toLowerCase(),
  openaiWhisperModel: process.env.OPENAI_WHISPER_MODEL || 'whisper-1',
  whisperCppPath: resolveExecutablePath(whisperCppPathRaw),
  whisperModelPath: resolveFromProjectIfRelative(whisperModelPathRaw),
  whisperLanguage: process.env.WHISPER_LANGUAGE || 'id',
};

const validTranscriptionProviders = new Set(['auto', 'openai', 'whisper_cpp']);
const validTaskParserProviders = new Set(['auto', 'openai', 'rule_based']);

function hasUsableWhisperModel() {
  if (!config.whisperModelPath) return false;
  return fs.existsSync(config.whisperModelPath);
}

export function requireEnv() {
  if (!validTranscriptionProviders.has(config.transcriptionProvider)) {
    throw new Error(`TRANSCRIPTION_PROVIDER tidak valid: ${config.transcriptionProvider}. Pilih: auto, openai, whisper_cpp.`);
  }
  if (!validTaskParserProviders.has(config.taskParserProvider)) {
    throw new Error(`TASK_PARSER_PROVIDER tidak valid: ${config.taskParserProvider}. Pilih: auto, openai, rule_based.`);
  }

  if (config.transcriptionProvider === 'openai' && !config.openaiKey) {
    throw new Error('OPENAI_API_KEY belum di-set. Tambahkan di .env atau ganti TRANSCRIPTION_PROVIDER ke whisper_cpp.');
  }
  if (config.taskParserProvider === 'openai' && !config.openaiKey) {
    throw new Error('OPENAI_API_KEY belum di-set. Tambahkan di .env atau ganti TASK_PARSER_PROVIDER ke rule_based.');
  }
  if (config.transcriptionProvider === 'whisper_cpp') {
    if (!config.whisperModelPath) {
      throw new Error('WHISPER_MODEL_PATH wajib di-set saat TRANSCRIPTION_PROVIDER=whisper_cpp.');
    }
    if (!hasUsableWhisperModel()) {
      throw new Error(`Model whisper tidak ditemukan di path: ${config.whisperModelPath}`);
    }
  }
  if (config.transcriptionProvider === 'auto') {
    if (!config.openaiKey && !config.whisperModelPath) {
      throw new Error('Mode auto butuh salah satu: OPENAI_API_KEY atau WHISPER_MODEL_PATH.');
    }
    if (!config.openaiKey && config.whisperModelPath && !hasUsableWhisperModel()) {
      throw new Error(`Model whisper tidak ditemukan di path: ${config.whisperModelPath}`);
    }
  }
}
