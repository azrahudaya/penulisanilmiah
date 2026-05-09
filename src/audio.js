import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import OpenAI from 'openai';
import { config } from './config.js';

const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStatic;
if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  throw new Error(`FFmpeg binary tidak ditemukan. Set FFMPEG_PATH atau install ffmpeg-static dengan benar. Path saat ini: ${ffmpegPath}`);
}

const openai = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey }) : null;

function createError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) {
    err.cause = cause;
  }
  return err;
}

function runCommand(binary, args, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { windowsHide: true });
    let stderr = '';

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(createError('binary_not_found', `${label} binary tidak ditemukan: ${binary}`, err));
        return;
      }
      reject(err);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(createError('process_failed', `${label} exit code ${code}: ${stderr || 'tanpa output error'}`));
    });
  });
}

async function transcribeWithOpenAI(audioPath) {
  if (!openai) {
    throw createError('openai_key_missing', 'OPENAI_API_KEY belum tersedia untuk transkripsi OpenAI.');
  }

  const audioStream = fs.createReadStream(audioPath);
  try {
    const resp = await openai.audio.transcriptions.create({
      file: audioStream,
      model: config.openaiWhisperModel,
      language: config.whisperLanguage,
      response_format: 'text',
    });
    return String(resp).trim();
  } catch (err) {
    if (err?.code === 'insufficient_quota') {
      throw createError('insufficient_quota', 'Kuota OpenAI habis (insufficient_quota).', err);
    }
    if (err?.status === 429) {
      throw createError('rate_limited', 'OpenAI terkena rate limit (429).', err);
    }
    throw err;
  } finally {
    audioStream.destroy();
  }
}

async function transcribeWithWhisperCpp(audioPath) {
  if (!config.whisperModelPath) {
    throw createError('whisper_model_missing', 'WHISPER_MODEL_PATH belum di-set untuk mode whisper_cpp.');
  }

  const modelPath = path.resolve(config.whisperModelPath);
  const outputBase = path.join(tmpdir(), `whisper-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const outputTxtPath = `${outputBase}.txt`;
  const args = [
    '-m', modelPath,
    '-f', audioPath,
    '-l', config.whisperLanguage,
    '--no-timestamps',
    '--output-txt',
    '--output-file', outputBase,
  ];

  try {
    await runCommand(config.whisperCppPath, args, 'whisper.cpp');
  } catch (err) {
    if (err?.code === 'binary_not_found') {
      throw createError(
        'whisper_binary_not_found',
        `WHISPER_CPP_PATH tidak ditemukan: ${config.whisperCppPath}. Install whisper.cpp lalu arahkan ke binary whisper-cli.`,
        err
      );
    }
    throw err;
  }

  if (!fs.existsSync(outputTxtPath)) {
    throw createError('whisper_output_missing', 'Output transkripsi whisper.cpp tidak ditemukan.');
  }

  const transcript = fs.readFileSync(outputTxtPath, 'utf8').trim();
  fs.unlink(outputTxtPath, () => {});

  if (!transcript) {
    throw createError('whisper_empty_output', 'Transkripsi lokal kosong. Coba ulangi dengan audio lebih jelas.');
  }

  return transcript;
}

export function writeTempFile(buffer, ext = '.ogg') {
  const filename = `vn-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
  const filepath = path.join(tmpdir(), filename);
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

export async function convertToWav(inputPath) {
  const outputPath = inputPath.replace(path.extname(inputPath), '.wav');
  const args = [
    '-y',
    '-i', inputPath,
    '-acodec', 'pcm_s16le',
    '-ac', '1',
    '-ar', '16000',
    outputPath,
  ];

  await runCommand(ffmpegPath, args, 'FFmpeg');
  return outputPath;
}

export function saveResearchWav(wavPath) {
  if (!fs.existsSync(config.researchAudioDir)) {
    fs.mkdirSync(config.researchAudioDir, { recursive: true });
  }
  const filename = `vn-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`;
  const targetPath = path.join(config.researchAudioDir, filename);
  fs.copyFileSync(wavPath, targetPath);
  return { filename, path: targetPath };
}

export function cleanupResearchAudioFiles(retentionDays) {
  if (!retentionDays || retentionDays <= 0 || !fs.existsSync(config.researchAudioDir)) {
    return 0;
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const entry of fs.readdirSync(config.researchAudioDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^vn-[A-Za-z0-9-]+\.wav$/.test(entry.name)) continue;
    const filePath = path.join(config.researchAudioDir, entry.name);
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(filePath);
      deleted += 1;
    }
  }
  return deleted;
}

export async function transcribeWhisper(audioPath) {
  const provider = config.transcriptionProvider;

  if (provider === 'openai') {
    return transcribeWithOpenAI(audioPath);
  }
  if (provider === 'whisper_cpp') {
    return transcribeWithWhisperCpp(audioPath);
  }

  if (openai) {
    try {
      return await transcribeWithOpenAI(audioPath);
    } catch (err) {
      if (err?.code !== 'insufficient_quota' && err?.code !== 'rate_limited') {
        throw err;
      }
    }
  }

  if (config.whisperModelPath) {
    return transcribeWithWhisperCpp(audioPath);
  }

  throw createError(
    'transcriber_not_configured',
    'Transcriber tidak terkonfigurasi. Isi OPENAI_API_KEY atau set WHISPER_MODEL_PATH untuk mode local.'
  );
}
