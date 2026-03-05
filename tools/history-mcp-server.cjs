#!/usr/bin/env node
/**
 * history-mcp-server.js — MCP server for querying S3 conversation history
 *
 * Protocol: stdio JSON-RPC (MCP spec)
 * Config: reads ~/.config/infiniclaw/machine.json for S3 credentials
 *
 * Tools exposed:
 *   list_history(room?, date?)  — list available history files
 *   get_history(room, date?, limit?)  — read messages from S3 JSONL
 *
 * Usage: node tools/history-mcp-server.js
 * MCP config: { "command": "node", "args": ["/path/to/history-mcp-server.js"] }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
// Resolve @aws-sdk from the InfiniClaw workspace, regardless of where this script is run from
const ROOT = path.resolve(__dirname, '..');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require(path.join(ROOT, 'node_modules', '@aws-sdk', 'client-s3'));

// ── S3 client setup ─────────────────────────────────────────────────────────

function loadConfig() {
  const configPath = path.join(os.homedir(), '.config', 'infiniclaw', 'machine.json');
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return raw.s3 ?? null;
  } catch {
    return null;
  }
}

function getClient() {
  const cfg = loadConfig();
  if (!cfg) return null;
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    forcePathStyle: true,
  });
  return { client, bucket: cfg.bucket };
}

// ── Tool implementations ─────────────────────────────────────────────────────

async function listHistory({ room, date } = {}) {
  const s3 = getClient();
  if (!s3) return { error: 'S3 not configured in machine.json' };

  let prefix = 'history/';
  if (room) prefix += `${room.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/`;
  if (date) prefix += `${date}/`;

  const cmd = new ListObjectsV2Command({ Bucket: s3.bucket, Prefix: prefix });
  const res = await s3.client.send(cmd);
  const files = (res.Contents ?? []).map((obj) => ({
    key: obj.Key,
    size: obj.Size,
    lastModified: obj.LastModified?.toISOString(),
  }));
  return { files, count: files.length };
}

async function getHistory({ room, date, limit = 100 } = {}) {
  const s3 = getClient();
  if (!s3) return { error: 'S3 not configured in machine.json' };
  if (!room) return { error: 'room is required' };

  const slug = room.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const prefix = date ? `history/${slug}/${date}/` : `history/${slug}/`;

  // List matching files, sort descending (newest first), pick most recent
  const listCmd = new ListObjectsV2Command({ Bucket: s3.bucket, Prefix: prefix });
  const listRes = await s3.client.send(listCmd);
  const keys = (listRes.Contents ?? [])
    .map((o) => o.Key)
    .filter(Boolean)
    .sort()
    .reverse();

  if (keys.length === 0) return { messages: [], count: 0 };

  // Read the most recent file (or all files for the date if limit allows)
  const messages = [];
  for (const key of keys) {
    if (messages.length >= limit) break;
    const getCmd = new GetObjectCommand({ Bucket: s3.bucket, Key: key });
    const getRes = await s3.client.send(getCmd);
    const body = await getRes.Body?.transformToString();
    if (!body) continue;
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
        if (messages.length >= limit) break;
      } catch { /* skip bad line */ }
    }
  }

  return { messages, count: messages.length };
}

// ── MCP stdio JSON-RPC server ────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_history',
    description: 'List available conversation history files in S3. Filter by room (e.g. "engineering") and/or date (YYYY-MM-DD).',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: 'Room slug (e.g. "engineering", "bridge")' },
        date: { type: 'string', description: 'Date filter YYYY-MM-DD' },
      },
    },
  },
  {
    name: 'get_history',
    description: 'Read conversation messages from S3 history. Returns JSONL records with id, room, sender, content, ts fields.',
    inputSchema: {
      type: 'object',
      required: ['room'],
      properties: {
        room: { type: 'string', description: 'Room name or slug (e.g. "engineering")' },
        date: { type: 'string', description: 'Date filter YYYY-MM-DD (defaults to today)' },
        limit: { type: 'number', description: 'Max messages to return (default 100)' },
      },
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleRequest(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'history-mcp-server', version: '1.0.0' },
      },
    };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params ?? {};
    try {
      let result;
      if (name === 'list_history') result = await listHistory(args);
      else if (name === 'get_history') result = await getHistory(args);
      else return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };

      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true },
      };
    }
  }

  if (method === 'notifications/initialized') return null; // no response needed

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// Read newline-delimited JSON from stdin
let buf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const req = JSON.parse(line);
      const res = await handleRequest(req);
      if (res) send(res);
    } catch (err) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
  }
});

process.stdin.on('end', () => process.exit(0));
