#!/usr/bin/env node
/*
 * Anthropic Messages API shim for Claude Code -> ChatGPT/Codex subscription auth.
 *
 * This router does not use an API key. It uses either:
 *   1. OPENAI_ACCESS_TOKEN / OPENAI_BEARER_TOKEN, or
 *   2. ~/.codex/auth.json from `codex login`
 *
 * The upstream is the ChatGPT/Codex backend:
 *   https://chatgpt.com/backend-api/codex/responses
 *
 * Required behavior discovered from the live backend:
 *   - requests must stream
 *   - requests must set store=false
 *   - instructions must be present
 *   - input must be a list
 */

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

const HOST = process.env.ROUTER_HOST || "0.0.0.0";
const PORT = Number(process.env.ROUTER_PORT || process.env.PORT || 43177);

const AUTH_JSON_PATH =
  process.env.OPENAI_AUTH_JSON ||
  path.join(os.homedir(), ".codex", "auth.json");

const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://chatgpt.com/backend-api/codex";
const OPENAI_RESPONSES_URL = `${OPENAI_BASE_URL.replace(/\/$/, "")}/responses`;
const OPENAI_ORIGIN = process.env.OPENAI_ORIGIN || "https://chatgpt.com";
const OPENAI_REFERER = process.env.OPENAI_REFERER || "https://chatgpt.com/codex";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4";
const DEFAULT_SERVICE_PROFILE = resolveServiceProfile(process.env.OPENAI_SERVICE_TIER);
const OPENAI_REASONING_EFFORT = normalizeReasoningEffort(
  process.env.OPENAI_REASONING_EFFORT,
);
const OPENAI_SERVICE_TIER = DEFAULT_SERVICE_PROFILE.serviceTier;
const OPENAI_TEXT_VERBOSITY =
  normalizeTextVerbosity(process.env.OPENAI_TEXT_VERBOSITY) ||
  DEFAULT_SERVICE_PROFILE.textVerbosity;
const OPENAI_INSTRUCTIONS =
  process.env.OPENAI_INSTRUCTIONS ||
  "You are a coding assistant running behind an Anthropic-compatible router.";

const RESPECT_REQUEST_MODEL = readBoolEnv("ROUTER_RESPECT_REQUEST_MODEL", false);
const PARALLEL_TOOL_CALLS = readBoolEnv("OPENAI_PARALLEL_TOOL_CALLS", false);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10 * 60 * 1000);
const TOKEN_REFRESH_SKEW_MS = Number(
  process.env.TOKEN_REFRESH_SKEW_MS || 5 * 60 * 1000,
);

const DIRECT_ACCESS_TOKEN =
  process.env.OPENAI_ACCESS_TOKEN || process.env.OPENAI_BEARER_TOKEN || null;
const DIRECT_REFRESH_TOKEN = process.env.OPENAI_REFRESH_TOKEN || null;
const SESSION_COOKIE = process.env.OPENAI_SESSION_COOKIE || null;

const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OMIT_FIELD = Symbol("omit-field");
const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

let authCache = null;

function readBoolEnv(name, defaultValue) {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function normalizeReasoningEffort(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (["none", "low", "medium", "high", "xhigh"].includes(normalized)) {
    return normalized;
  }
  return null;
}

function normalizeServiceTier(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (["auto", "default", "flex", "priority"].includes(normalized)) {
    return normalized;
  }
  return null;
}

function normalizeTextVerbosity(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (["low", "medium", "high"].includes(normalized)) {
    return normalized;
  }
  return null;
}

function resolveServiceProfile(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return {
      serviceTier: null,
      textVerbosity: null,
    };
  }

  if (normalized === "fast") {
    return {
      serviceTier: "priority",
      textVerbosity: "low",
    };
  }

  return {
    serviceTier: normalizeServiceTier(normalized),
    textVerbosity: null,
  };
}

function nowMs() {
  return Date.now();
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    ...CORS_HEADERS,
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function writeAnthropicError(res, statusCode, type, message) {
  writeJson(res, statusCode, {
    type: "error",
    error: {
      type,
      message,
    },
  });
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function flattenTextParts(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          if (item.type === "text" && typeof item.text === "string") {
            return item.text;
          }
          if (typeof item.content === "string") {
            return item.content;
          }
          return JSON.stringify(item);
        }
        return String(item);
      })
      .join("\n");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function normalizeContent(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (content == null) return [];
  return [content];
}

function extractInstructions(system) {
  const text = flattenTextParts(system).trim();
  return text || OPENAI_INSTRUCTIONS;
}

function appendRoleMessage(input, role, parts) {
  if (!parts.length) return;
  input.push({
    role,
    content: parts,
  });
}

function anthropicMessagesToOpenAIInput(messages) {
  const input = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message && typeof message.role === "string" ? message.role : "user";
    const blocks = normalizeContent(message && message.content);
    const currentParts = [];

    const flush = () => {
      if (!currentParts.length) return;
      appendRoleMessage(input, role === "assistant" ? "assistant" : "user", currentParts.splice(0));
    };

    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;

      if (block.type === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (!text) continue;
        currentParts.push({
          type: role === "assistant" ? "output_text" : "input_text",
          text,
        });
        continue;
      }

      if (role === "assistant" && block.type === "tool_use") {
        flush();
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        });
        continue;
      }

      if (role !== "assistant" && block.type === "tool_result") {
        flush();
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: flattenTextParts(block.content),
        });
      }
    }

    flush();
  }

  return input;
}

function anthropicToolsToOpenAITools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description || "",
    parameters:
      tool.input_schema || { type: "object", properties: {}, additionalProperties: false },
  }));
}

function buildToolSchemaMap(tools) {
  const schemaMap = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool.name !== "string") continue;
    if (!tool.input_schema || typeof tool.input_schema !== "object") continue;
    schemaMap.set(tool.name, tool.input_schema);
  }
  return schemaMap;
}

function parseToolArguments(argumentsValue) {
  if (argumentsValue && typeof argumentsValue === "object") {
    return argumentsValue;
  }
  if (typeof argumentsValue === "string") {
    return parseJsonSafely(argumentsValue, {});
  }
  return {};
}

function sanitizeToolValue(value, schema, required = false) {
  if (value == null) {
    return required ? value : OMIT_FIELD;
  }

  if (value === "") {
    return required ? value : OMIT_FIELD;
  }

  if (Array.isArray(value)) {
    const itemSchema =
      schema && typeof schema === "object" && schema.items && typeof schema.items === "object"
        ? schema.items
        : null;
    return value
      .map((item) => sanitizeToolValue(item, itemSchema, true))
      .filter((item) => item !== OMIT_FIELD);
  }

  if (typeof value !== "object") {
    return value;
  }

  const properties =
    schema &&
    typeof schema === "object" &&
    schema.properties &&
    typeof schema.properties === "object"
      ? schema.properties
      : null;
  const requiredKeys = new Set(
    Array.isArray(schema && typeof schema === "object" ? schema.required : null)
      ? schema.required
      : [],
  );

  const sanitized = {};
  for (const [key, childValue] of Object.entries(value)) {
    const childSchema = properties && properties[key] ? properties[key] : null;
    const nextValue = sanitizeToolValue(childValue, childSchema, requiredKeys.has(key));
    if (nextValue !== OMIT_FIELD) {
      sanitized[key] = nextValue;
    }
  }
  return sanitized;
}

function sanitizeToolInput(toolName, rawInput, toolSchemaMap) {
  const parsedInput = parseToolArguments(rawInput);
  const schema = toolSchemaMap.get(toolName) || null;
  const sanitized = sanitizeToolValue(parsedInput, schema, true);
  if (!sanitized || sanitized === OMIT_FIELD || typeof sanitized !== "object") {
    return {};
  }
  return sanitized;
}

function mapToolChoice(toolChoice) {
  if (toolChoice == null) return "auto";
  if (typeof toolChoice === "string") {
    if (toolChoice === "any") return "required";
    if (toolChoice === "auto" || toolChoice === "none") return toolChoice;
    return "auto";
  }
  if (typeof toolChoice !== "object") return "auto";
  if (toolChoice.type === "auto" || toolChoice.type === "none") return toolChoice.type;
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool" && toolChoice.name) {
    return {
      type: "function",
      name: toolChoice.name,
    };
  }
  return "auto";
}

function chooseModel(requestedModel) {
  if (RESPECT_REQUEST_MODEL && requestedModel) return requestedModel;
  return OPENAI_MODEL;
}

function parseRequestedModelSpec(requestedModel) {
  const raw = typeof requestedModel === "string" ? requestedModel.trim() : "";
  if (!raw) {
    return {
      raw: "",
      baseModel: null,
      reasoningEffort: null,
      serviceTier: null,
      textVerbosity: null,
      hasInlineOptions: false,
    };
  }

  const parts = raw
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return {
      raw,
      baseModel: null,
      reasoningEffort: null,
      serviceTier: null,
      textVerbosity: null,
      hasInlineOptions: false,
    };
  }

  const baseModel = parts[0];
  let reasoningEffort = null;
  let serviceTier = null;
  let textVerbosity = null;

  for (const rawToken of parts.slice(1)) {
    const token = rawToken.toLowerCase();

    const effortValue = (() => {
      if (normalizeReasoningEffort(token)) return token;
      for (const prefix of ["effort:", "reasoning:", "reasoning_effort:", "reasoning-effort:"]) {
        if (token.startsWith(prefix)) {
          return token.slice(prefix.length);
        }
      }
      return null;
    })();
    const normalizedEffort = normalizeReasoningEffort(effortValue);
    if (normalizedEffort) {
      reasoningEffort = normalizedEffort;
      continue;
    }

    const serviceProfile = (() => {
      if (token === "fast") {
        return resolveServiceProfile(token);
      }
      const directTier = normalizeServiceTier(token);
      if (directTier) {
        return resolveServiceProfile(directTier);
      }
      return null;
    })();
    if (serviceProfile) {
      if (serviceProfile.serviceTier) serviceTier = serviceProfile.serviceTier;
      if (serviceProfile.textVerbosity) textVerbosity = serviceProfile.textVerbosity;
      continue;
    }

    for (const prefix of ["tier:", "service:", "service_tier:", "service-tier:"]) {
      if (token.startsWith(prefix)) {
        const prefixedProfile = resolveServiceProfile(token.slice(prefix.length));
        if (prefixedProfile.serviceTier) serviceTier = prefixedProfile.serviceTier;
        if (prefixedProfile.textVerbosity) textVerbosity = prefixedProfile.textVerbosity;
      }
    }

    for (const prefix of ["verbosity:", "text:", "text_verbosity:", "text-verbosity:"]) {
      if (token.startsWith(prefix)) {
        const normalizedVerbosity = normalizeTextVerbosity(token.slice(prefix.length));
        if (normalizedVerbosity) textVerbosity = normalizedVerbosity;
      }
    }
  }

  return {
    raw,
    baseModel: baseModel || null,
    reasoningEffort,
    serviceTier,
    textVerbosity,
    hasInlineOptions: parts.length > 1,
  };
}

function resolveRequestOptions(requestedModel) {
  const parsed = parseRequestedModelSpec(requestedModel);
  const model =
    parsed.baseModel && (RESPECT_REQUEST_MODEL || parsed.hasInlineOptions)
      ? parsed.baseModel
      : chooseModel(parsed.baseModel || requestedModel);
  return {
    model,
    reasoningEffort: parsed.reasoningEffort || OPENAI_REASONING_EFFORT,
    serviceTier: parsed.serviceTier || OPENAI_SERVICE_TIER,
    textVerbosity: parsed.textVerbosity || OPENAI_TEXT_VERBOSITY,
  };
}

function buildUpstreamPayload(body) {
  const resolved = resolveRequestOptions(body.model);
  const payload = {
    model: resolved.model,
    instructions: extractInstructions(body.system),
    input: anthropicMessagesToOpenAIInput(body.messages),
    tools: anthropicToolsToOpenAITools(body.tools),
    tool_choice: mapToolChoice(body.tool_choice),
    parallel_tool_calls: PARALLEL_TOOL_CALLS,
    store: false,
    stream: true,
  };
  if (resolved.reasoningEffort) {
    payload.reasoning = { effort: resolved.reasoningEffort };
  }
  if (resolved.serviceTier) {
    payload.service_tier = resolved.serviceTier;
  }
  if (resolved.textVerbosity) {
    payload.text = { verbosity: resolved.textVerbosity };
  }
  return payload;
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) return null;
    const payload = parts[1];
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function accessTokenExpiresSoon(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return false;
  return payload.exp * 1000 <= nowMs() + TOKEN_REFRESH_SKEW_MS;
}

function readAuthFile() {
  if (DIRECT_ACCESS_TOKEN) {
    return {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        access_token: DIRECT_ACCESS_TOKEN,
        refresh_token: DIRECT_REFRESH_TOKEN,
      },
      last_refresh: new Date().toISOString(),
    };
  }

  if (authCache) return authCache;

  if (!fs.existsSync(AUTH_JSON_PATH)) {
    throw new Error(
      `No auth file found at ${AUTH_JSON_PATH}. Run \`codex login\` or set OPENAI_ACCESS_TOKEN.`,
    );
  }

  const raw = fs.readFileSync(AUTH_JSON_PATH, "utf8");
  authCache = JSON.parse(raw);
  return authCache;
}

function saveAuthFile(auth) {
  if (DIRECT_ACCESS_TOKEN) return;
  fs.writeFileSync(AUTH_JSON_PATH, `${JSON.stringify(auth, null, 2)}\n`, {
    mode: 0o600,
  });
  authCache = auth;
}

async function refreshAccessToken(auth) {
  const refreshToken =
    (auth && auth.tokens && auth.tokens.refresh_token) || DIRECT_REFRESH_TOKEN || null;
  if (!refreshToken) {
    throw new Error(
      "No refresh token is available. Re-run `codex login` or set OPENAI_ACCESS_TOKEN.",
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });

  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text };
  }

  if (!response.ok || !payload.access_token) {
    const message =
      payload.error_description ||
      payload.error ||
      `OAuth refresh failed with status ${response.status}`;
    throw new Error(message);
  }

  const nextAuth = {
    ...(auth || {}),
    auth_mode: (auth && auth.auth_mode) || "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      ...(auth && auth.tokens ? auth.tokens : {}),
      access_token: payload.access_token,
      refresh_token: payload.refresh_token || refreshToken,
      id_token: payload.id_token || (auth && auth.tokens && auth.tokens.id_token) || null,
      account_id: payload.account_id || (auth && auth.tokens && auth.tokens.account_id) || null,
    },
    last_refresh: new Date().toISOString(),
  };

  saveAuthFile(nextAuth);
  return nextAuth.tokens.access_token;
}

async function getAccessToken(forceRefresh = false) {
  const auth = readAuthFile();
  const accessToken = auth && auth.tokens ? auth.tokens.access_token : null;

  if (!accessToken) {
    throw new Error(
      "No access token is available. Run `codex login` or set OPENAI_ACCESS_TOKEN.",
    );
  }

  if (!forceRefresh && !accessTokenExpiresSoon(accessToken)) {
    return accessToken;
  }

  return refreshAccessToken(auth);
}

function mapUpstreamErrorStatus(statusCode) {
  if (statusCode === 400) return "invalid_request_error";
  if (statusCode === 401 || statusCode === 403) return "authentication_error";
  if (statusCode === 404) return "not_found_error";
  if (statusCode === 429) return "rate_limit_error";
  return "api_error";
}

async function fetchUpstream(upstreamPayload) {
  let response = await fetchUpstreamOnce(await getAccessToken(false), upstreamPayload);
  if (response.status !== 401) return response;

  response = await fetchUpstreamOnce(await getAccessToken(true), upstreamPayload);
  return response;
}

async function fetchUpstreamOnce(accessToken, upstreamPayload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      Origin: OPENAI_ORIGIN,
      Referer: OPENAI_REFERER,
    };

    if (SESSION_COOKIE) {
      headers.Cookie = SESSION_COOKIE;
    }

    return await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamPayload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseSseChunk(rawEvent) {
  const lines = rawEvent.split(/\r?\n/);
  let event = "message";
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  const data = dataLines.join("\n");
  if (!data) return null;

  let json = null;
  if (data !== "[DONE]") {
    try {
      json = JSON.parse(data);
    } catch {
      json = null;
    }
  }

  return { event, data, json };
}

async function* iterateSseEvents(bodyStream) {
  const reader = bodyStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const nextBoundary = () => {
    const lf = buffer.indexOf("\n\n");
    const crlf = buffer.indexOf("\r\n\r\n");
    if (lf === -1) return crlf;
    if (crlf === -1) return lf;
    return Math.min(lf, crlf);
  };

  const consumeBoundary = (boundary) => {
    if (buffer.startsWith("\r\n\r\n", boundary)) {
      return boundary + 4;
    }
    if (buffer.slice(boundary, boundary + 4) === "\r\n\r\n") {
      return boundary + 4;
    }
    return boundary + 2;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = nextBoundary();
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(consumeBoundary(boundary));
      const parsed = parseSseChunk(rawEvent);
      if (parsed) yield parsed;
      boundary = nextBoundary();
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseSseChunk(buffer);
    if (parsed) yield parsed;
  }
}

function parseJsonSafely(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function anthropicUsageFromCompleted(response) {
  const usage = response && response.usage ? response.usage : {};
  return {
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
  };
}

function extractAnthropicContentFromCompleted(response, toolSchemaMap = new Map()) {
  const content = [];

  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "output_text") {
          content.push({
            type: "text",
            text: part.text || "",
          });
          continue;
        }
        if (part.type === "refusal") {
          content.push({
            type: "text",
            text: part.refusal || part.text || "",
          });
        }
      }
      continue;
    }

    if (item.type === "function_call") {
      content.push({
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input: sanitizeToolInput(item.name, item.arguments || "{}", toolSchemaMap),
      });
    }
  }

  return content;
}

function anthropicStopReasonFromContent(content) {
  return content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
}

function buildAnthropicMessage(completedResponse, toolSchemaMap = new Map()) {
  const content = extractAnthropicContentFromCompleted(completedResponse, toolSchemaMap);
  return {
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: completedResponse.model || chooseModel(),
    content,
    stop_reason: anthropicStopReasonFromContent(content),
    stop_sequence: null,
    usage: anthropicUsageFromCompleted(completedResponse),
  };
}

async function aggregateCompletedResponse(bodyStream) {
  let completed = null;
  let upstreamError = null;

  for await (const event of iterateSseEvents(bodyStream)) {
    const data = event.json;
    if (!data) continue;
    if (data.type === "response.completed" && data.response) {
      completed = data.response;
    }
    if (data.type === "error" && data.error) {
      upstreamError = data.error;
    }
  }

  if (upstreamError) {
    const message = upstreamError.message || "Upstream response stream failed.";
    throw new Error(message);
  }
  if (!completed) {
    throw new Error("Upstream stream ended before response.completed.");
  }

  return completed;
}

async function proxyStreamingAnthropic(res, upstreamResponse, toolSchemaMap = new Map()) {
  const anthropicMessageId = `msg_${randomUUID().replace(/-/g, "")}`;
  const textBlockIndexes = new Map();
  const toolBlocks = new Map();
  let nextBlockIndex = 0;
  let messageStarted = false;

  const ensureMessageStart = (model) => {
    if (messageStarted) return;
    messageStarted = true;
    writeSse(res, "message_start", {
      type: "message_start",
      message: {
        id: anthropicMessageId,
        type: "message",
        role: "assistant",
        model: model || chooseModel(),
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    });
  };

  for await (const event of iterateSseEvents(upstreamResponse.body)) {
    const data = event.json;
    if (!data) continue;

    if (data.type === "response.created" && data.response) {
      ensureMessageStart(data.response.model);
      continue;
    }

    if (data.type === "response.content_part.added") {
      ensureMessageStart();
      const part = data.part || {};
      if (part.type !== "output_text") continue;

      const key = `${data.item_id}:${data.content_index}`;
      if (textBlockIndexes.has(key)) continue;
      const index = nextBlockIndex++;
      textBlockIndexes.set(key, index);

      writeSse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "text",
          text: "",
        },
      });
      continue;
    }

    if (data.type === "response.output_text.delta") {
      ensureMessageStart();
      const key = `${data.item_id}:${data.content_index}`;
      const index = textBlockIndexes.get(key);
      if (index == null) continue;
      writeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "text_delta",
          text: data.delta || "",
        },
      });
      continue;
    }

    if (data.type === "response.content_part.done") {
      const key = `${data.item_id}:${data.content_index}`;
      const index = textBlockIndexes.get(key);
      if (index == null) continue;
      writeSse(res, "content_block_stop", {
        type: "content_block_stop",
        index,
      });
      continue;
    }

    if (data.type === "response.output_item.added") {
      ensureMessageStart();
      const item = data.item || {};
      if (item.type !== "function_call") continue;

      const index = nextBlockIndex++;
      toolBlocks.set(item.id, {
        index,
        callId: item.call_id,
        name: item.name,
        rawArguments: "",
      });
      writeSse(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: item.call_id,
          name: item.name,
          input: {},
        },
      });
      continue;
    }

    if (data.type === "response.function_call_arguments.delta") {
      ensureMessageStart();
      const toolBlock = toolBlocks.get(data.item_id);
      if (!toolBlock) continue;
      toolBlock.rawArguments += data.delta || "";
      continue;
    }

    if (data.type === "response.output_item.done") {
      const item = data.item || {};
      if (item.type !== "function_call") continue;
      const toolBlock = toolBlocks.get(item.id);
      if (!toolBlock) continue;
      const sanitizedInput = sanitizeToolInput(
        item.name || toolBlock.name,
        item.arguments || toolBlock.rawArguments,
        toolSchemaMap,
      );
      const partialJson = JSON.stringify(sanitizedInput);
      if (partialJson !== "{}") {
        writeSse(res, "content_block_delta", {
          type: "content_block_delta",
          index: toolBlock.index,
          delta: {
            type: "input_json_delta",
            partial_json: partialJson,
          },
        });
      }
      writeSse(res, "content_block_stop", {
        type: "content_block_stop",
        index: toolBlock.index,
      });
      toolBlocks.delete(item.id);
      continue;
    }

    if (data.type === "response.completed" && data.response) {
      ensureMessageStart(data.response.model);
      const content = extractAnthropicContentFromCompleted(data.response, toolSchemaMap);
      writeSse(res, "message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: anthropicStopReasonFromContent(content),
          stop_sequence: null,
        },
        usage: anthropicUsageFromCompleted(data.response),
      });
      writeSse(res, "message_stop", {
        type: "message_stop",
      });
      res.end();
      return;
    }

    if (data.type === "error" && data.error) {
      writeSse(res, "error", {
        type: "error",
        error: {
          type: "api_error",
          message: data.error.message || "Upstream response stream failed.",
        },
      });
      res.end();
      return;
    }
  }

  if (!res.writableEnded) {
    writeSse(res, "error", {
      type: "error",
      error: {
        type: "api_error",
        message: "Upstream stream ended before response.completed.",
      },
    });
    res.end();
  }
}

function estimateTokens(body) {
  const raw = JSON.stringify({
    system: body.system || null,
    messages: body.messages || [],
    tools: body.tools || [],
  });
  return Math.max(1, Math.ceil(raw.length / 4));
}

function handleCountTokens(req, res) {
  readJson(req)
    .then((body) => {
      writeJson(res, 200, {
        input_tokens: estimateTokens(body),
      });
    })
    .catch((error) => {
      writeAnthropicError(res, 400, "invalid_request_error", error.message);
    });
}

async function handleMessages(req, res) {
  let body;

  try {
    body = await readJson(req);
  } catch (error) {
    writeAnthropicError(res, 400, "invalid_request_error", error.message);
    return;
  }

  const toolSchemaMap = buildToolSchemaMap(body && body.tools);

  let upstreamPayload;
  try {
    upstreamPayload = buildUpstreamPayload(body);
    if (!Array.isArray(upstreamPayload.input)) {
      throw new Error("Upstream input translation failed.");
    }
  } catch (error) {
    writeAnthropicError(res, 400, "invalid_request_error", error.message);
    return;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetchUpstream(upstreamPayload);
  } catch (error) {
    writeAnthropicError(res, 502, "api_error", error.message);
    return;
  }

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text();
    const parsed = parseJsonSafely(text, {});
    const message =
      parsed.detail ||
      (parsed.error && parsed.error.message) ||
      text ||
      `Upstream request failed with status ${upstreamResponse.status}`;
    writeAnthropicError(
      res,
      upstreamResponse.status,
      mapUpstreamErrorStatus(upstreamResponse.status),
      message,
    );
    return;
  }

  if (body.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    try {
      await proxyStreamingAnthropic(res, upstreamResponse, toolSchemaMap);
    } catch (error) {
      if (!res.writableEnded) {
        writeSse(res, "error", {
          type: "error",
          error: {
            type: "api_error",
            message: error.message,
          },
        });
        res.end();
      }
    }
    return;
  }

  try {
    const completed = await aggregateCompletedResponse(upstreamResponse.body);
    writeJson(res, 200, buildAnthropicMessage(completed, toolSchemaMap), {
      "anthropic-version": "2023-06-01",
    });
  } catch (error) {
    writeAnthropicError(res, 502, "api_error", error.message);
  }
}

function handleModels(res) {
  writeJson(res, 200, {
    object: "list",
    data: [
      {
        id: OPENAI_MODEL,
        type: "model",
        display_name: OPENAI_MODEL,
      },
    ],
  });
}

function handleRoot(res) {
  writeJson(res, 200, {
    ok: true,
    transport: "anthropic-messages-shim",
    upstream: OPENAI_RESPONSES_URL,
    auth_source: DIRECT_ACCESS_TOKEN ? "env" : AUTH_JSON_PATH,
    model: OPENAI_MODEL,
    default_reasoning_effort: OPENAI_REASONING_EFFORT,
    default_service_tier: OPENAI_SERVICE_TIER,
    default_text_verbosity: OPENAI_TEXT_VERBOSITY,
    respect_request_model: RESPECT_REQUEST_MODEL,
  });
}

function writeCorsPreflight(res) {
  res.writeHead(204, {
    ...CORS_HEADERS,
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    writeCorsPreflight(res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    handleRoot(res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    handleModels(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    handleCountTokens(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/messages") {
    await handleMessages(req, res);
    return;
  }

  writeAnthropicError(res, 404, "not_found_error", `No route for ${req.method} ${url.pathname}`);
});

server.listen(PORT, HOST, () => {
  console.log(`router listening on http://${HOST}:${PORT}`);
  console.log(`upstream: ${OPENAI_RESPONSES_URL}`);
  console.log(`auth: ${DIRECT_ACCESS_TOKEN ? "env token" : AUTH_JSON_PATH}`);
  console.log(`model: ${OPENAI_MODEL}`);
  console.log(`default reasoning effort: ${OPENAI_REASONING_EFFORT || "none"}`);
  console.log(`default service tier: ${OPENAI_SERVICE_TIER || "default"}`);
  console.log(`default text verbosity: ${OPENAI_TEXT_VERBOSITY || "default"}`);
  console.log(`respect request model: ${RESPECT_REQUEST_MODEL}`);
});
