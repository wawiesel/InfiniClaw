/**
 * Container run loop — extracted from upstream NanoClaw v1.1.3.
 * Upstream inlined this into their runContainerAgent in v1.2.2.
 * InfiniClaw needs the composable version since we build our own mounts/args.
 * This file will be removed when Phase 1 (Claude Code CLI runtime) lands.
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from 'nanoclaw/logger.js';
import type { ContainerOutput } from 'nanoclaw/container-runner.js';
import { errStr } from './utils.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function parseOutputMarkers(
  buffer: string,
): { outputs: ContainerOutput[]; remaining: string } {
  const outputs: ContainerOutput[] = [];
  let remaining = buffer;
  let startIdx: number;
  while ((startIdx = remaining.indexOf(OUTPUT_START_MARKER)) !== -1) {
    const endIdx = remaining.indexOf(OUTPUT_END_MARKER, startIdx);
    if (endIdx === -1) break;
    const jsonStr = remaining
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();
    remaining = remaining.slice(endIdx + OUTPUT_END_MARKER.length);
    try {
      outputs.push(JSON.parse(jsonStr));
    } catch {
      // Skip malformed output
    }
  }
  return { outputs, remaining };
}

export interface RunContainerOpts {
  runtime: string;
  args: string[];
  stdinData: unknown;
  groupName: string;
  groupFolder: string;
  containerName: string;
  logsDir: string;
  configTimeout: number;
  idleTimeout: number;
  maxOutputSize: number;
  onProcess: (proc: ChildProcess, containerName: string) => void;
  onOutput?: (output: ContainerOutput) => Promise<void>;
  stopCommand: string;
  logInput?: unknown;
  verboseLogExtras?: string[];
  summaryLogExtras?: string[];
  timeoutErrorMessage?: string;
  outputChainTimeoutMs?: number;
  maxErrorStderrChars?: number;
  firstOutputDeadlineMs?: number;
}

export function runContainer(opts: RunContainerOpts): Promise<ContainerOutput> {
  const startTime = Date.now();
  fs.mkdirSync(opts.logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(opts.runtime, opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    opts.onProcess(container, opts.containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(opts.stdinData));
    container.stdin.end();

    let timedOut = false;
    let hadStreamingOutput = false;
    let firstOutputReceived = false;
    const timeoutMs = Math.max(opts.configTimeout, opts.idleTimeout + 30_000);
    if (opts.firstOutputDeadlineMs && opts.firstOutputDeadlineMs > timeoutMs) {
      logger.warn(
        { firstOutputDeadlineMs: opts.firstOutputDeadlineMs, timeoutMs, group: opts.groupName },
        'firstOutputDeadlineMs exceeds container timeout — deadline will never fire',
      );
    }

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: opts.groupName, containerName: opts.containerName },
        'Container timeout, stopping gracefully',
      );
      exec(opts.stopCommand, { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: opts.groupName, containerName: opts.containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    const foDeadlineMs = opts.firstOutputDeadlineMs ?? 0;
    let firstOutputTimer: ReturnType<typeof setTimeout> | null = null;
    if (foDeadlineMs > 0) {
      firstOutputTimer = setTimeout(() => {
        if (!firstOutputReceived) {
          logger.error(
            { group: opts.groupName, containerName: opts.containerName, deadlineMs: foDeadlineMs },
            'Container produced no output within first-output deadline, killing',
          );
          killOnTimeout();
        }
      }, foDeadlineMs);
    }

    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let firstOutputLogged = false;

    container.stdout.on('data', (data) => {
      if (!firstOutputReceived) {
        firstOutputReceived = true;
        if (firstOutputTimer) { clearTimeout(firstOutputTimer); firstOutputTimer = null; }
      }
      if (!firstOutputLogged) {
        firstOutputLogged = true;
        const ttfoMs = Date.now() - startTime;
        logger.info(
          { group: opts.groupName, containerName: opts.containerName, ttfoMs },
          'Time to first output',
        );
      }
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = opts.maxOutputSize - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: opts.groupName, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (opts.onOutput) {
        parseBuffer += chunk;
        const { outputs, remaining } = parseOutputMarkers(parseBuffer);
        parseBuffer = remaining;
        for (const parsed of outputs) {
          if (parsed.newSessionId) {
            newSessionId = parsed.newSessionId;
          }
          hadStreamingOutput = true;
          resetTimeout();
          outputChain = outputChain.then(() => opts.onOutput!(parsed));
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: opts.groupFolder }, line);
      }
      if (stderrTruncated) return;
      const remaining = opts.maxOutputSize - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: opts.groupName, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    const settleOutputChain = (cb: () => void) => {
      const chainTimeoutMs = opts.outputChainTimeoutMs ?? 0;
      if (chainTimeoutMs > 0) {
        const chainTimer = setTimeout(() => {
          logger.warn(
            { group: opts.groupName, containerName: opts.containerName },
            'outputChain stalled after container close, force-resolving',
          );
          cb();
        }, chainTimeoutMs);
        outputChain
          .then(() => {
            clearTimeout(chainTimer);
            cb();
          })
          .catch((err) => {
            clearTimeout(chainTimer);
            logger.error(
              { group: opts.groupName, err },
              'outputChain rejected after container close',
            );
            cb();
          });
      } else {
        outputChain.then(() => cb());
      }
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      if (firstOutputTimer) { clearTimeout(firstOutputTimer); firstOutputTimer = null; }
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(opts.logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${opts.groupName}`,
            `Container: ${opts.containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        if (hadStreamingOutput) {
          logger.info(
            { group: opts.groupName, containerName: opts.containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          settleOutputChain(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        logger.error(
          { group: opts.groupName, containerName: opts.containerName, duration, code },
          'Container timed out with no output',
        );

        const errorMsg =
          opts.timeoutErrorMessage ??
          `Container timed out after ${opts.configTimeout}ms`;
        resolve({ status: 'error', result: null, error: errorMsg });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(opts.logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' ||
        process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${opts.groupName}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;
      const logInputObj = opts.logInput ?? opts.stdinData;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(logInputObj, null, 2),
          ``,
        );
        if (opts.verboseLogExtras) {
          logLines.push(...opts.verboseLogExtras);
        }
        logLines.push(
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        if (opts.summaryLogExtras) {
          logLines.push(...opts.summaryLogExtras);
        }
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        const signalExits: Record<number, { signal: string; label: string }> = {
          137: { signal: 'SIGKILL', label: 'Container was killed (SIGKILL)' },
          139: { signal: 'SIGSEGV', label: 'SEGFAULT — Container crashed (segmentation fault)' },
          134: { signal: 'SIGABRT', label: 'ABORTED — Container aborted' },
          143: { signal: 'SIGTERM', label: 'Container was terminated' },
        };

        const signalInfo = signalExits[code ?? -1];
        const isOomKill = false;

        if (hadStreamingOutput && !isOomKill) {
          logger.warn(
            {
              group: opts.groupName,
              code,
              duration,
              ...(signalInfo ? { signal: signalInfo.signal, isOomKill } : {}),
            },
            'Container crashed after streaming output was delivered, treating as success',
          );
          settleOutputChain(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        logger.error(
          {
            group: opts.groupName,
            code,
            duration,
            stderr,
            stdout,
            logFile,
            ...(signalInfo ? { signal: signalInfo.signal, isOomKill } : {}),
          },
          signalInfo ? signalInfo.label : 'Container exited with error',
        );

        let errorMsg: string;
        if (signalInfo) {
          const durationSec = Math.round(duration / 1000);
          errorMsg = `${signalInfo.label} (exit ${code}, ${signalInfo.signal}, ${durationSec}s)`;
        } else {
          const maxChars = opts.maxErrorStderrChars ?? 200;
          const stderrSnippet =
            maxChars > 0 ? stderr.slice(-maxChars) : stderr;
          errorMsg = `Container exited with code ${code}: ${stderrSnippet}`;
        }

        resolve({
          status: 'error',
          result: null,
          error: errorMsg,
        });
        return;
      }

      if (opts.onOutput) {
        settleOutputChain(() => {
          logger.info(
            { group: opts.groupName, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: opts.groupName,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: opts.groupName,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${errStr(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: opts.groupName, containerName: opts.containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}
