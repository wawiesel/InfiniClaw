/**
 * S3 sync for multi-machine deployment.
 * Pushes/pulls bot state (messages.db, matrix-bot.json, sessions) to/from MinIO.
 * Skips silently if S3 is not configured. Warns and continues on network failure.
 */
import fs from 'fs';
import path from 'path';

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

import { loadMachineConfig } from './machine-config.js';
import { instanceDir } from './service.js';

// Files/dirs to sync per bot, relative to instance dir
const SYNC_PATHS = [
  'store/messages.db',
  'store/matrix-bot.json',
  'data/sessions',       // recursive
];

function getClient(): { client: S3Client; bucket: string } | null {
  const config = loadMachineConfig();
  if (!config.s3) return null;
  const { endpoint, bucket, accessKey, secretKey } = config.s3;
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
  });
  return { client, bucket };
}

async function uploadFile(client: S3Client, bucket: string, key: string, filePath: string): Promise<void> {
  const body = fs.readFileSync(filePath);
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
}

async function downloadFile(client: S3Client, bucket: string, key: string, filePath: string): Promise<void> {
  const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!resp.Body) return;
  const chunks: Uint8Array[] = [];
  for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat(chunks));
}

/** Recursively list all files under a directory, returning paths relative to base. */
function walkDir(dir: string, base: string = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // Skip broken symlinks
    if (entry.isSymbolicLink() && !fs.existsSync(full)) continue;
    if (entry.isDirectory()) {
      results.push(...walkDir(full, base));
    } else {
      results.push(path.relative(base, full));
    }
  }
  return results;
}

export async function pushBot(root: string, bot: string): Promise<void> {
  const s3 = getClient();
  if (!s3) return;

  const instance = instanceDir(root, bot);
  if (!fs.existsSync(instance)) {
    console.log(`${bot}: no instance to push`);
    return;
  }

  console.log(`${bot}: pushing state to S3...`);
  let count = 0;

  for (const syncPath of SYNC_PATHS) {
    const fullPath = path.join(instance, syncPath);
    if (!fs.existsSync(fullPath)) continue;

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      // Recursive upload
      const files = walkDir(fullPath);
      for (const relFile of files) {
        const key = `${bot}/${syncPath}/${relFile}`;
        await uploadFile(s3.client, s3.bucket, key, path.join(fullPath, relFile));
        count++;
      }
    } else {
      const key = `${bot}/${syncPath}`;
      await uploadFile(s3.client, s3.bucket, key, fullPath);
      count++;
    }
  }

  console.log(`${bot}: pushed ${count} files to S3`);
}

export async function pullBot(root: string, bot: string): Promise<void> {
  const s3 = getClient();
  if (!s3) return;

  const instance = instanceDir(root, bot);
  console.log(`${bot}: pulling state from S3...`);
  let count = 0;

  for (const syncPath of SYNC_PATHS) {
    const prefix = `${bot}/${syncPath}`;
    const fullPath = path.join(instance, syncPath);

    // List all objects under this prefix (handles pagination for >1000 keys)
    let continuationToken: string | undefined;
    do {
      const listed = await s3.client.send(new ListObjectsV2Command({
        Bucket: s3.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      if (listed.Contents) {
        for (const obj of listed.Contents) {
          if (!obj.Key) continue;
          // Compute local path from key
          const relativeToBot = obj.Key.slice(`${bot}/`.length);
          const localPath = path.join(instance, relativeToBot);
          await downloadFile(s3.client, s3.bucket, obj.Key, localPath);
          count++;
        }
      }

      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  console.log(`${bot}: pulled ${count} files from S3`);
}

export async function pushAll(root: string): Promise<void> {
  const config = loadMachineConfig();
  if (!config.s3) return;

  for (const bot of config.bots) {
    try {
      await pushBot(root, bot);
    } catch (err) {
      console.warn(`${bot}: S3 push failed — ${err instanceof Error ? err.message : err}`);
    }
  }
}

export async function pullAll(root: string): Promise<void> {
  const config = loadMachineConfig();
  if (!config.s3) return;

  for (const bot of config.bots) {
    try {
      await pullBot(root, bot);
    } catch (err) {
      console.warn(`${bot}: S3 pull failed — ${err instanceof Error ? err.message : err}`);
    }
  }
}
