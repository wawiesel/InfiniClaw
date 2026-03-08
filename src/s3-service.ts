import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadShipConfig } from './ship-config.js';
import { logger } from 'nanoclaw/logger.js';
import { errStr } from './utils.js';

export function getS3Client(): { client: S3Client; bucket: string } | null {
  try {
    const config = loadShipConfig();
    if (!config.s3) return null;
    const { endpoint, bucket, accessKey, secretKey } = config.s3;
    return {
      client: new S3Client({
        endpoint,
        region: 'us-east-1',
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
        forcePathStyle: true,
      }),
      bucket,
    };
  } catch { return null; }
}

export async function uploadToS3(key: string, body: string | Buffer, contentType: string): Promise<boolean> {
  const s3 = getS3Client();
  if (!s3) return false;
  try {
    await s3.client.send(new PutObjectCommand({
      Bucket: s3.bucket,
      Key: key,
      Body: typeof body === 'string' ? Buffer.from(body) : body,
      ContentType: contentType,
    }));
    return true;
  } catch (err) {
    logger.error({ err: errStr(err), key }, 'S3 upload failed');
    return false;
  }
}

export async function getPresignedUrl(key: string, expiresInSeconds: number): Promise<string> {
  const s3 = getS3Client();
  if (!s3) return '';
  try {
    return await getSignedUrl(s3.client, new GetObjectCommand({ Bucket: s3.bucket, Key: key }), { expiresIn: expiresInSeconds });
  } catch { return ''; }
}
