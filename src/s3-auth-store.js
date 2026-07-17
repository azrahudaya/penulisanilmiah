import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export function createS3AuthStore() {
  const bucket = process.env.BUCKETEER_BUCKET_NAME;
  if (!bucket) return null;
  const s3 = new S3Client({
    region: process.env.BUCKETEER_AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.BUCKETEER_AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.BUCKETEER_AWS_SECRET_ACCESS_KEY,
    },
  });
  const key = (session) => `whatsapp/${path.basename(session)}.zip`;
  return {
    async sessionExists({ session }) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key(session) }));
        return true;
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') return false;
        throw error;
      }
    },
    async save({ session }) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key(session), Body: fs.readFileSync(`${session}.zip`) }));
    },
    async extract({ session, path: target }) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key(session) }));
      await pipeline(response.Body, fs.createWriteStream(target));
    },
    async delete({ session }) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key(session) }));
    },
  };
}
