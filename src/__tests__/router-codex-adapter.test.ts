import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const routerPath = path.join(repoRoot, 'tools/router/router.cjs');

const childProcesses = new Set<ChildProcess>();
const servers = new Set<http.Server>();

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function withServer(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind test server');
  }
  return { server, port: address.port };
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
      lastError = new Error(`health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`router did not become healthy: ${String(lastError)}`);
}

async function stopChild(proc: ChildProcess): Promise<void> {
  if (proc.exitCode != null || proc.signalCode != null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, 2_000);
    proc.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    try { proc.kill('SIGTERM'); } catch { resolve(); }
  });
}

async function exerciseRouter(options?: {
  env?: Record<string, string>;
  requestedModel?: string;
}): Promise<Record<string, unknown>> {
  let capturedPayload: Record<string, unknown> | null = null;

  const upstream = await withServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/responses') {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    capturedPayload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    const model = String(capturedPayload.model || 'gpt-5.4');

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`event: message\ndata: ${JSON.stringify({
      type: 'response.created',
      response: { id: 'resp_test', model },
    })}\n\n`);
    res.write(`event: message\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_test',
        model,
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })}\n\n`);
    res.end();
  });

  const routerPort = await (async () => {
    const probe = await withServer((_req, res) => res.end('probe'));
    const address = probe.port;
    await closeServer(probe.server);
    servers.delete(probe.server);
    return address;
  })();

  const router = spawn('node', [routerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ROUTER_HOST: '127.0.0.1',
      ROUTER_PORT: String(routerPort),
      OPENAI_BASE_URL: `http://127.0.0.1:${upstream.port}`,
      OPENAI_ACCESS_TOKEN: 'test-access-token',
      OPENAI_MODEL: 'gpt-5.4',
      ...(options?.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  childProcesses.add(router);

  try {
    await waitForHealth(routerPort);

    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options?.requestedModel || 'gpt-5.4',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        stream: false,
      }),
    });

    expect(response.ok).toBe(true);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.type).toBe('message');
    expect(capturedPayload).not.toBeNull();
    if (!capturedPayload) {
      throw new Error('router did not forward an upstream payload');
    }
    return capturedPayload;
  } finally {
    await stopChild(router);
    childProcesses.delete(router);
    await closeServer(upstream.server);
    servers.delete(upstream.server);
  }
}

afterEach(async () => {
  await Promise.all([...childProcesses].map(async (proc) => {
    await stopChild(proc);
    childProcesses.delete(proc);
  }));
  await Promise.all([...servers].map(async (server) => {
    await closeServer(server);
    servers.delete(server);
  }));
});

describe('router codex adapter options', () => {
  it('maps +fast +xhigh model aliases into Codex upstream fields', async () => {
    const payload = await exerciseRouter({ requestedModel: 'gpt-5.4+fast+xhigh' });
    expect(payload.model).toBe('gpt-5.4');
    expect(payload.service_tier).toBe('priority');
    expect(payload.reasoning).toEqual({ effort: 'xhigh' });
    expect(payload.text).toEqual({ verbosity: 'low' });
  });

  it('applies configured defaults when the request omits inline options', async () => {
    const payload = await exerciseRouter({
      env: {
        OPENAI_SERVICE_TIER: 'fast',
        OPENAI_REASONING_EFFORT: 'xhigh',
      },
      requestedModel: 'gpt-5.4',
    });
    expect(payload.model).toBe('gpt-5.4');
    expect(payload.service_tier).toBe('priority');
    expect(payload.reasoning).toEqual({ effort: 'xhigh' });
    expect(payload.text).toEqual({ verbosity: 'low' });
  });
});
