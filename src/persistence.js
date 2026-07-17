import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archive = path.join(tmpdir(), 'reminderbot-state.tar.gz');
const bucket = process.env.BUCKETEER_BUCKET_NAME;
const key = process.env.PERSISTENCE_KEY || 'production/state.tar.gz';
const enabled = Boolean(bucket && process.env.BUCKETEER_AWS_ACCESS_KEY_ID && process.env.BUCKETEER_AWS_SECRET_ACCESS_KEY);
const s3 = enabled ? new S3Client({
  region: process.env.BUCKETEER_AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.BUCKETEER_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.BUCKETEER_AWS_SECRET_ACCESS_KEY,
  },
}) : null;

function tar(args) {
  const result = spawnSync('tar', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`tar gagal dengan exit code ${result.status}`);
}

export async function restoreState() {
  if (!enabled) {
    console.log('Persistence remote tidak aktif; memakai filesystem lokal.');
    return false;
  }
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await pipeline(response.Body, fs.createWriteStream(archive));
    tar(['-xzf', archive]);
    fs.rmSync(archive, { force: true });
    console.log('State berhasil dipulihkan dari object storage.');
    return true;
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
      console.log('Belum ada snapshot remote; memulai state baru.');
      return false;
    }
    throw error;
  }
}

let uploadRunning = false;
export async function uploadState() {
  if (!enabled || uploadRunning) return false;
  uploadRunning = true;
  try {
    const items = ['data', '.wwebjs_auth'].filter((item) => fs.existsSync(path.join(root, item)));
    if (!items.length) return false;
    tar(['-czf', archive, ...items]);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(archive),
      ContentType: 'application/gzip',
    }));
    fs.rmSync(archive, { force: true });
    console.log('State berhasil disimpan ke object storage.');
    return true;
  } finally {
    uploadRunning = false;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (action === 'upload') await uploadState();
  else if (action === 'restore') await restoreState();
  else throw new Error('Gunakan: node src/persistence.js upload|restore');
}
