import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { execFile, spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "fs";
import { promisify } from "util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const PORT = parseInt(process.env.PORT || "3001");
const PI_CMD = process.env.PI_CMD || "pi";
const MODEL_SERVER_HELPER = process.env.MODEL_SERVER_HELPER || "/Users/ryantaylorvegh/bin/pi-model-server";
const DATA_DIR = join(__dirname, "../data");
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");
const AGENT_PROFILES_FILE = join(DATA_DIR, "agent-profiles.json");
const UPLOADS_DIR = join(DATA_DIR, "uploads");
const PI_SESSIONS_DIR = join(DATA_DIR, "pi-sessions");
const DS4_LOG_PATH = process.env.DS4_LOG_PATH || join(process.env.HOME || "", "logs/ds4.log");
const OMLX_LOG_PATH = process.env.OMLX_LOG_PATH || join(process.env.HOME || "", "logs/omlx.log");
const OMLX_SETTINGS_PATH = process.env.OMLX_SETTINGS_PATH || join(process.env.HOME || "", ".omlx/settings.json");
const PI_MODELS_PATH = process.env.PI_MODELS_PATH || join(process.env.HOME || "", ".pi/agent/models.json");
const PI_SETTINGS_PATH = process.env.PI_SETTINGS_PATH || join(process.env.HOME || "", ".pi/agent/settings.json");
const DEFAULT_MODEL_ID = "qwen-35b-mtp";
const OMLX_SWITCH_SETTLE_MS = Number(process.env.OMLX_SWITCH_SETTLE_MS || 8_000);
const DEFAULT_PROJECT_ID = "project-inbox";
const MAX_VISIBLE_MESSAGES = 160;
const MAX_MODEL_CONTEXT_TOOL_OUTPUT = 4_000;
const MAX_PI_SESSION_FILE_BEFORE_COMPACT_REBUILD = 250_000;
const MAX_PI_TOOL_RESULT_LINE_BEFORE_COMPACT_REBUILD = 25_000;
const TRASH_PROTECTED_PATHS = new Set(["/", "/System", "/Library", "/Applications", "/Users", "/Volumes"]);
interface ModelOption {
  id: string;
  label: string;
  provider: string;
  model: string;
  description?: string;
}

interface AgentProfile {
  id: string;
  name: string;
  modelId: ModelId;
  extensionIds: string[];
  skillIds: string[];
  instructions?: string;
  createdAt: number;
  updatedAt: number;
}

interface AgentCapability {
  id: string;
  label: string;
  path: string;
}

const FALLBACK_MODELS: ModelOption[] = [
  {
    id: "qwen-35b-a3b",
    label: "Qwen3.6 35B A3B",
    provider: "omlx",
    model: "Qwen3.6-35B-A3B-8bit",
    description: "Default",
  },
  {
    id: DEFAULT_MODEL_ID,
    label: "Qwen3.6 35B A3B MTP",
    provider: "omlx",
    model: "Qwen3.6-35B-A3B-oQ4-fp16-mtp",
    description: "Default, MTP +30-50% faster",
  },
  {
    id: "qwen-27b-dense",
    label: "Qwen3.6 27B Dense",
    provider: "omlx",
    model: "Qwen3.6-27B-8bit",
    description: "Specialized",
  },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    provider: "ds4",
    model: "deepseek-v4-flash",
    description: "DS4 local",
  },
  {
    id: "mistral-small-4",
    label: "Mistral Small 4 119B 4-bit",
    provider: "omlx",
    model: "Mistral-Small-4-119B-2603-4bit",
    description: "Mistral local",
  },
];

type ModelId = string;

// ── Session Storage ─────────────────────────────────────────────────
// Clean map: sessionId → PiSession. No ws tricks, no closures.

interface PiSession {
  id: string;
  proc?: ReturnType<typeof spawn>;
  name: string;
  createdAt: number;
  projectId: string;
  modelId: ModelId;
  modelLabel: string;
  agentProfileId?: string;
  isQuick?: boolean;
  sessionFile: string;
  messages: ServerChatMessage[];
  activeAssistantId?: string;
  activeRun?: boolean;
  restoredFromClient?: boolean;
}

interface PublicSession {
  id: string;
  name: string;
  createdAt: number;
  projectId: string;
  modelId: ModelId;
  modelLabel: string;
  modelProvider: string;
  agentProfileId?: string;
  agentProfileName?: string;
  isBusy?: boolean;
  isQuick?: boolean;
}

interface Project {
  id: string;
  name: string;
  createdAt: number;
}

interface UiState {
  activeSessionId?: string;
  collapsedProjectIds: string[];
}

interface ServerChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "error";
  content: string;
  attachments?: Array<{
    id: string;
    name: string;
    mimeType: string;
    size?: number;
    url?: string;
  }>;
  thinking?: string;
  toolName?: string;
  toolCallId?: string;
  detail?: string;
  output?: string;
  outputForContext?: string;
  timestamp: number;
  startedAt?: number;
  completedAt?: number;
  speedTokensPerSecond?: number;
  modelTokensPerSecond?: number;
  tokenEstimate?: number;
  isStreaming?: boolean;
  isThinkingStreaming?: boolean;
  stopped?: boolean;
}

interface ModelRuntimeStatus {
  provider: "ds4" | "omlx";
  phase: "idle" | "prefill" | "generating" | "complete" | "starting" | "failed";
  label: string;
  detail?: string;
  current?: number;
  total?: number;
  percent?: number;
  tokensPerSecond?: number;
  elapsedSeconds?: number;
  estimatedRemainingSeconds?: number;
  updatedAt: number;
}

let modelStatusOverride: ModelRuntimeStatus | null = null;
let cachedOmlxAdminStatus: ModelRuntimeStatus | null = null;
let omlxAdminCookie = "";
let preparedRuntimeProvider: string | null = null;
const pendingModelSwitches = new Map<string, Promise<void>>();
const pendingToolDetails = new Map<string, Map<string, { toolName?: string; detail?: string }>>();
let uiState: UiState = { collapsedProjectIds: [] };

interface IncomingAttachment {
  name?: string;
  mimeType?: string;
  size?: number;
  data?: string;
}

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function extractRmTargets(command: string): string[] {
  const tokens = tokenizeShellCommand(command);
  if (tokens.length === 0) return [];
  let index = tokens[0] === "sudo" ? 1 : 0;
  const executable = tokens[index];
  if (executable !== "rm" && executable !== "/bin/rm" && executable !== "/usr/bin/rm") return [];
  index += 1;

  const targets: string[] = [];
  let endOfOptions = false;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!endOfOptions && token === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && token.startsWith("-")) continue;
    if (token) targets.push(token);
  }
  return targets;
}

function trashCommandForTargets(targets: string[]) {
  const targetJson = JSON.stringify(targets);
  return `/usr/bin/python3 <<'PYTHON_EOF'
import json
import os
import subprocess
import sys

targets = json.loads(${JSON.stringify(targetJson)})
protected = ${JSON.stringify(Array.from(TRASH_PROTECTED_PATHS))}
failed = False

for original in targets:
    expanded = os.path.abspath(os.path.expanduser(original))
    if expanded in protected:
        print(f"Refusing to trash protected top-level path: {expanded}", file=sys.stderr)
        failed = True
        continue
    if not os.path.lexists(expanded):
        print(f"No such file or directory: {original}", file=sys.stderr)
        failed = True
        continue
    try:
        subprocess.run(["/usr/bin/trash", expanded], check=True, capture_output=True, text=True)
        print(f"Moved to Trash: {expanded}")
    except subprocess.CalledProcessError as error:
        message = (error.stderr or error.stdout or str(error)).strip()
        print(f"Error moving to Trash: {expanded}: {message}", file=sys.stderr)
        failed = True

if failed:
    sys.exit(1)
PYTHON_EOF`;
}

function rewriteRpcBashForTrash(command: Record<string, unknown>) {
  if (command.type !== "bash" || typeof command.command !== "string") return command;
  const targets = extractRmTargets(command.command);
  if (targets.length === 0) return command;
  return {
    ...command,
    command: trashCommandForTargets(targets),
  };
}

function appendLimitedLog(existing: string, addition: string, maxLength = 6000) {
  const combined = `${existing}${addition}`;
  return combined.length <= maxLength ? combined : combined.slice(combined.length - maxLength);
}

const sessions = new Map<string, PiSession>();
const projects = new Map<string, Project>([
  [DEFAULT_PROJECT_ID, { id: DEFAULT_PROJECT_ID, name: "Inbox", createdAt: 0 }],
]);
let agentProfiles: AgentProfile[] = loadAgentProfiles();
const sessionOutputBuffers = new Map<string, string>();
const sessionOwners = new Map<string, WebSocket>();
const deletedSessions = new Set<string>();
const pendingRpcCommands = new Map<string, { sessionId: string; label: string }>();
const pendingSlashCommandRequests = new Map<string, { sessionId: string; ws: WebSocket }>();
const sessionStderrBuffers = new Map<string, string>();
const liveMessageBroadcastTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingAbortTimers = new Map<string, ReturnType<typeof setTimeout>>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function generateId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateCommandId(): string {
  return `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateProjectId(): string {
  return `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateAgentProfileId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function stableWebModelId(provider: string, modelId: string): string {
  const known: Record<string, string> = {
    "omlx/Qwen3.6-35B-A3B-8bit": "qwen-35b-a3b",
    "omlx/Qwen3.6-35B-A3B-oQ4-fp16-mtp": DEFAULT_MODEL_ID,
    "omlx/Qwen3.6-27B-8bit": "qwen-27b-dense",
    "omlx/Mistral-Small-4-119B-2603-4bit": "mistral-small-4",
    "ds4/deepseek-v4-flash": "deepseek-v4-flash",
  };
  const key = `${provider}/${modelId}`;
  if (known[key]) return known[key];
  return `${provider}:${modelId}`.replace(/[^a-z0-9:_-]+/gi, "-");
}

function modelDescription(provider: string, modelId: string, name: string) {
  if (modelId.includes("mtp")) return "MTP +30-50% faster";
  if (modelId.toLowerCase().includes("mistral")) return "Mistral local";
  if (modelId.includes("27B") || name.toLowerCase().includes("dense")) return "Specialized";
  if (provider === "ds4") return "DS4 local";
  return undefined;
}

function readJsonFile(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function capabilityLabel(id: string) {
  return id
    .replace(/\.(ts|js|md)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function listAgentExtensions(): AgentCapability[] {
  const extensionsDir = join(process.env.HOME || "", ".pi/agent/extensions");
  try {
    return readdirSync(extensionsDir, { withFileTypes: true })
      .flatMap((entry) => {
        if (entry.isFile() && entry.name.endsWith(".ts")) {
          return [{
            id: entry.name,
            label: capabilityLabel(entry.name),
            path: join(extensionsDir, entry.name),
          }];
        }
        if (entry.isDirectory()) {
          const candidates = ["index.ts", "tool.ts"]
            .map((file) => join(extensionsDir, entry.name, file))
            .filter((path) => existsSync(path));
          if (candidates.length > 0) {
            return [{
              id: entry.name,
              label: capabilityLabel(entry.name),
              path: candidates[0],
            }];
          }
        }
        return [];
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (error: any) {
    console.warn(`[AgentProfiles] Could not list extensions: ${error?.message || error}`);
    return [];
  }
}

function listAgentSkills(): AgentCapability[] {
  const skillsDir = join(process.env.HOME || "", ".pi/agent/skills");
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
      .map((entry) => ({
        id: entry.name,
        label: capabilityLabel(entry.name),
        path: join(skillsDir, entry.name),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (error: any) {
    console.warn(`[AgentProfiles] Could not list skills: ${error?.message || error}`);
    return [];
  }
}

function defaultAgentProfile(): AgentProfile {
  const now = Date.now();
  return {
    id: "agent-default",
    name: "Default Pi",
    modelId: DEFAULT_MODEL_ID,
    extensionIds: [],
    skillIds: [],
    instructions: "",
    createdAt: now,
    updatedAt: now,
  };
}

function sanitizeIdList(value: unknown, allowedIds: Set<string>) {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string" && allowedIds.has(id));
}

function normalizeAgentProfile(value: any, fallback?: AgentProfile): AgentProfile | null {
  const id = typeof value?.id === "string" && value.id.trim() ? value.id.trim() : fallback?.id || generateAgentProfileId();
  const name = typeof value?.name === "string" && value.name.trim() ? value.name.trim() : fallback?.name || "New Agent";
  const modelId = typeof value?.modelId === "string" ? resolveModel(value.modelId).id : fallback?.modelId || getDefaultModelId();
  const extensionIds = sanitizeIdList(value?.extensionIds, new Set(listAgentExtensions().map((item) => item.id)));
  const skillIds = sanitizeIdList(value?.skillIds, new Set(listAgentSkills().map((item) => item.id)));
  const now = Date.now();
  return {
    id,
    name,
    modelId,
    extensionIds,
    skillIds,
    instructions: typeof value?.instructions === "string" ? value.instructions : fallback?.instructions || "",
    createdAt: typeof value?.createdAt === "number" ? value.createdAt : fallback?.createdAt || now,
    updatedAt: typeof value?.updatedAt === "number" ? value.updatedAt : now,
  };
}

function loadAgentProfiles(): AgentProfile[] {
  try {
    if (!existsSync(AGENT_PROFILES_FILE)) return [defaultAgentProfile()];
    const raw = readJsonFile(AGENT_PROFILES_FILE);
    const sourceProfiles = Array.isArray(raw?.profiles) ? raw.profiles : [];
    const profiles = sourceProfiles
      .map((profile: any) => normalizeAgentProfile(profile))
      .filter((profile): profile is AgentProfile => Boolean(profile));
    return profiles.length > 0 ? profiles : [defaultAgentProfile()];
  } catch (error: any) {
    console.warn(`[AgentProfiles] Could not read ${AGENT_PROFILES_FILE}; using default profile: ${error?.message || error}`);
    return [defaultAgentProfile()];
  }
}

function saveAgentProfiles() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tempFile = `${AGENT_PROFILES_FILE}.tmp`;
  writeFileSync(tempFile, JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    profiles: agentProfiles,
  }, null, 2));
  renameSync(tempFile, AGENT_PROFILES_FILE);
}

function getAgentProfile(profileId?: string) {
  return agentProfiles.find((profile) => profile.id === profileId) || agentProfiles.find((profile) => profile.id === "agent-default") || agentProfiles[0] || defaultAgentProfile();
}

function capabilityPath(capabilities: AgentCapability[], id: string) {
  return capabilities.find((capability) => capability.id === id)?.path;
}

function isExplicitProfile(profile: AgentProfile | undefined) {
  if (!profile) return false;
  return profile.id !== "agent-default" || profile.extensionIds.length > 0 || profile.skillIds.length > 0 || Boolean(profile.instructions?.trim());
}

function agentProfileLaunchArgs(profile: AgentProfile | undefined, selectedModel: ModelOption) {
  const args: string[] = [];
  const explicitProfile = isExplicitProfile(profile);
  const extensionCapabilities = listAgentExtensions();
  const skillCapabilities = listAgentSkills();

  if (explicitProfile) {
    args.push("--no-extensions");
    for (const extensionId of profile?.extensionIds || []) {
      const path = capabilityPath(extensionCapabilities, extensionId);
      if (path) args.push("--extension", path);
    }

    args.push("--no-skills");
    for (const skillId of profile?.skillIds || []) {
      const path = capabilityPath(skillCapabilities, skillId);
      if (path) args.push("--skill", path);
    }
  } else if (selectedModel.model.toLowerCase().includes("mistral")) {
    args.push(
      "--no-extensions",
      "--extension",
      "/Users/ryantaylorvegh/.pi/agent/extensions/memory-autosave.ts",
      "--no-skills",
    );
  }

  if (selectedModel.model.toLowerCase().includes("mistral")) {
    args.push("--no-prompt-templates", "--no-context-files");
  }

  if (profile?.instructions?.trim()) {
    args.push(
      "--append-system-prompt",
      [`Agent profile: ${profile.name}`, profile.instructions.trim()].join("\n\n"),
    );
  }

  return args;
}

function getConfiguredModels(): ModelOption[] {
  try {
    const config = readJsonFile(PI_MODELS_PATH);
    const providers = config?.providers && typeof config.providers === "object" ? config.providers : {};
    const models: ModelOption[] = [];
    for (const [provider, providerConfig] of Object.entries(providers)) {
      const providerModels = Array.isArray((providerConfig as any)?.models) ? (providerConfig as any).models : [];
      for (const model of providerModels) {
        if (!model?.id || typeof model.id !== "string") continue;
        const label = String(model.name || model.label || model.id);
        models.push({
          id: stableWebModelId(provider, model.id),
          label,
          provider,
          model: model.id,
          description: model.description || modelDescription(provider, model.id, label),
        });
      }
    }
    return models.length > 0 ? models : FALLBACK_MODELS;
  } catch (error: any) {
    console.warn(`[Models] Could not read ${PI_MODELS_PATH}; using fallback list: ${error?.message || error}`);
    return FALLBACK_MODELS;
  }
}

function modelMatchesProviderId(model: ModelOption, provider: string, modelId: string) {
  return model.provider === provider && model.model === modelId;
}

function findModelByProviderId(provider: string, modelId: string) {
  return getConfiguredModels().find((model) => modelMatchesProviderId(model, provider, modelId));
}

function getDefaultModelId() {
  try {
    const settings = readJsonFile(PI_SETTINGS_PATH);
    if (typeof settings?.defaultProvider === "string" && typeof settings?.defaultModel === "string") {
      const configured = findModelByProviderId(settings.defaultProvider, settings.defaultModel);
      if (configured) return configured.id;
    }
  } catch {
    // Missing settings are fine; fall through to the stable default.
  }
  const models = getConfiguredModels();
  return models.find((model) => model.id === DEFAULT_MODEL_ID)?.id || models[0]?.id || DEFAULT_MODEL_ID;
}

function resolveModel(modelId?: string) {
  const models = getConfiguredModels();
  if (!models.length) return FALLBACK_MODELS[0];
  if (!modelId) return models.find((model) => model.id === getDefaultModelId()) || models[0];
  const providerSlash = modelId.indexOf("/");
  if (providerSlash > 0) {
    const provider = modelId.slice(0, providerSlash);
    const model = modelId.slice(providerSlash + 1);
    const configured = models.find((candidate) => modelMatchesProviderId(candidate, provider, model));
    if (configured) return configured;
  }
  return models.find((model) =>
    model.id === modelId ||
    model.model === modelId ||
    `${model.provider}/${model.model}` === modelId
  ) || models.find((model) => model.id === getDefaultModelId()) || models[0];
}

function sessionFileForId(id: string) {
  return join(PI_SESSIONS_DIR, `${id}.jsonl`);
}

function generateEntryId(): string {
  return Math.random().toString(16).slice(2, 10);
}

function assistantUsageStub() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function shouldRebuildSeededPiSessionFile(session: PiSession) {
  if (!existsSync(session.sessionFile)) return false;
  try {
    const text = readFileSync(session.sessionFile, "utf8");
    if (text.length > MAX_PI_SESSION_FILE_BEFORE_COMPACT_REBUILD) return true;
    if (text
      .split("\n")
      .some((line) => line.includes('"role":"toolResult"') && line.length > MAX_PI_TOOL_RESULT_LINE_BEFORE_COMPACT_REBUILD)) {
      return true;
    }
    if (text.includes("seeded-tool-")) return true;
    if (text.includes('"responseId":"seeded-')) return true;
    if (!text.includes('"role":"assistant"')) return false;
    if (!text.includes('"usage"')) return true;
    return text
      .split("\n")
      .filter((line) => line.includes('"role":"assistant"'))
      .some((line) => !line.includes('"usage"'));
  } catch {
    return true;
  }
}

function summarizeForHandoff(text: string, maxLength = 900) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1).trim()}…`;
}

function summarizeToolOutputForContext(output: string, toolName?: string) {
  const normalized = output.trim();
  if (normalized.length <= MAX_MODEL_CONTEXT_TOOL_OUTPUT) return normalized;

  const headLength = Math.floor(MAX_MODEL_CONTEXT_TOOL_OUTPUT * 0.65);
  const tailLength = Math.floor(MAX_MODEL_CONTEXT_TOOL_OUTPUT * 0.25);
  const omitted = normalized.length - headLength - tailLength;
  return [
    `[Large ${toolName || "tool"} output summarized for future model context. Full output remains visible in Pi Web. Original length: ${normalized.length} characters.]`,
    normalized.slice(0, headLength).trimEnd(),
    `[... omitted ${omitted} characters ...]`,
    normalized.slice(-tailLength).trimStart(),
  ].join("\n");
}

function buildSessionHandoffSummary(session: PiSession) {
  const transcript: string[] = [];
  const messages = session.messages
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool")
    .filter((message) => message.content || message.thinking || message.output);
  const recentMessages = messages.slice(-30);
  const omitted = Math.max(0, messages.length - recentMessages.length);

  for (const message of recentMessages) {
    const toolOutput = message.role === "tool"
      ? message.outputForContext || (message.output ? summarizeToolOutputForContext(message.output, message.toolName) : "")
      : "";
    const parts = [toolOutput, message.content].filter(Boolean).join("\n").trim();
    if (!parts) continue;
    const label = message.role === "tool"
      ? `Tool observation${message.toolName ? ` (${message.toolName})` : ""}`
      : message.role === "assistant"
        ? "Assistant"
        : "User";
    transcript.push(`${label}: ${summarizeForHandoff(parts)}`);
  }

  return [
    "This chat was restored from the pi-agent-web interface.",
    "Continue the conversation from the context below. Previous visible tool output is historical context only; do not treat it as an active tool call. For any new file, shell, network, or external action, use the currently available tools and only claim success after a real tool result.",
    omitted > 0 ? `Earlier restored messages omitted from this handoff: ${omitted}.` : "",
    "",
    "Recent restored transcript:",
    transcript.length ? summarizeForHandoff(transcript.join("\n\n"), 30_000) : "(No restored transcript text.)",
  ].filter(Boolean).join("\n");
}

function seedPiSessionFile(session: PiSession) {
  const rebuildExisting = shouldRebuildSeededPiSessionFile(session);
  if (existsSync(session.sessionFile) && !rebuildExisting) return;
  if (session.messages.length === 0) return;

  mkdirSync(dirname(session.sessionFile), { recursive: true });
  const lines: string[] = [];
  let parentId: string | null = null;
  const now = new Date().toISOString();

  if (rebuildExisting) {
    console.log(`[Session] Rebuilding seeded Pi session file for ${session.id}`);
  }

  const sessionEntryId = session.id.replace(/^session-/, "").slice(0, 36) || generateEntryId();
  lines.push(JSON.stringify({
    type: "session",
    version: 3,
    id: sessionEntryId,
    timestamp: new Date(session.createdAt).toISOString(),
    cwd: process.cwd(),
  }));

  const modelEntryId = generateEntryId();
  lines.push(JSON.stringify({
    type: "model_change",
    id: modelEntryId,
    parentId,
    timestamp: now,
    provider: resolveModel(session.modelId).provider,
    modelId: resolveModel(session.modelId).model,
  }));
  parentId = modelEntryId;

  const handoffEntryId = generateEntryId();
  lines.push(JSON.stringify({
    type: "custom_message",
    id: handoffEntryId,
    parentId,
    timestamp: now,
    customType: "pi-agent-web-session-handoff",
    content: buildSessionHandoffSummary(session),
    display: false,
    details: {
      source: "pi-agent-web",
      restoredMessageCount: session.messages.length,
    },
  }));

  writeFileSync(session.sessionFile, `${lines.join("\n")}\n`);
}

function recentContextForReset(session: PiSession) {
  const recent = session.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .filter((message) => message.content && !message.content.trim().match(/^\/(reset-context|clear-context|compact)\b/i))
    .slice(-10)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${summarizeForHandoff(message.content, 1200)}`);

  return recent.length ? recent.join("\n\n") : "";
}

function writeFreshPiSessionFile(session: PiSession, instructions: string) {
  mkdirSync(dirname(session.sessionFile), { recursive: true });
  if (existsSync(session.sessionFile)) {
    const backupPath = `${session.sessionFile}.context-reset-${Date.now()}.bak`;
    renameSync(session.sessionFile, backupPath);
  }

  const now = new Date().toISOString();
  const sessionEntryId = session.id.replace(/^session-/, "").slice(0, 36) || generateEntryId();
  const modelEntryId = generateEntryId();
  const resetEntryId = generateEntryId();
  const recentContext = recentContextForReset(session);
  const resetNote = [
    "The previous model context for this chat was intentionally reset by the user to improve speed.",
    "The visible chat history still exists in pi-agent-web, but only the recent excerpt below should be treated as active model context.",
    instructions ? `User reset instructions: ${instructions}` : "",
    recentContext ? `\nMost recent retained context:\n${recentContext}` : "",
  ].filter(Boolean).join("\n");

  const lines = [
    {
      type: "session",
      version: 3,
      id: sessionEntryId,
      timestamp: new Date(session.createdAt).toISOString(),
      cwd: process.cwd(),
    },
    {
      type: "model_change",
      id: modelEntryId,
      parentId: null,
      timestamp: now,
      provider: resolveModel(session.modelId).provider,
      modelId: resolveModel(session.modelId).model,
    },
    {
      type: "custom_message",
      id: resetEntryId,
      parentId: modelEntryId,
      timestamp: now,
      customType: "pi-agent-web-context-reset",
      content: resetNote,
      display: false,
      details: {
        source: "pi-agent-web",
        resetAt: now,
      },
    },
  ];

  writeFileSync(session.sessionFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function hardResetSessionContext(session: PiSession, instructions: string) {
  terminateSessionProcess(session);
  session.proc = undefined;
  session.activeAssistantId = undefined;
  session.activeRun = false;
  sessionStderrBuffers.delete(session.id);
  writeFreshPiSessionFile(session, instructions);
  return startSessionProcess(session);
}

function createPiProcess(session: PiSession) {
  const profile = session.agentProfileId ? getAgentProfile(session.agentProfileId) : undefined;
  const modelId = session.modelId || profile?.modelId;
  const selectedModel = resolveModel(modelId);
  const profileArgs = agentProfileLaunchArgs(profile, selectedModel);
  mkdirSync(PI_SESSIONS_DIR, { recursive: true });
  return {
    selectedModel,
    proc: spawn(PI_CMD, [
      "--model",
      `${selectedModel.provider}/${selectedModel.model}`,
      "--mode",
      "rpc",
      "--session",
      session.sessionFile,
      "--session-dir",
      PI_SESSIONS_DIR,
      "--append-system-prompt",
      "When a user asks you to inspect files, create files, edit files, run shell commands, send messages, or perform any external action, you must use the available tools. Do not claim that an action is done unless a tool call or direct command result confirms it.",
      ...profileArgs,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      detached: true,
    }),
  };
}

function createSession(name: string = "New Chat", ownerWs?: WebSocket, modelId?: string, options: {
  id?: string;
  createdAt?: number;
  projectId?: string;
  agentProfileId?: string;
  sessionFile?: string;
  messages?: ServerChatMessage[];
  restoredFromClient?: boolean;
  skipPersist?: boolean;
  startProcess?: boolean;
  isQuick?: boolean;
} = {}): PiSession {
  const id = options.id || generateId();
  const selectedProfile = options.agentProfileId ? getAgentProfile(options.agentProfileId) : undefined;
  const selectedModel = resolveModel(selectedProfile?.modelId || modelId);
  const session: PiSession = {
    id,
    name,
    createdAt: options.createdAt || Date.now(),
    projectId: projects.has(options.projectId || "") ? options.projectId! : DEFAULT_PROJECT_ID,
    modelId: selectedModel.id,
    modelLabel: selectedModel.label,
    agentProfileId: selectedProfile?.id,
    isQuick: Boolean(options.isQuick),
    sessionFile: options.sessionFile || sessionFileForId(id),
    messages: options.messages || [],
    restoredFromClient: options.restoredFromClient,
  };
  sessions.set(id, session);
  if (ownerWs) {
    sessionOwners.set(id, ownerWs);
  }
  if (options.startProcess !== false) startSessionProcess(session);
  console.log(`[Session] ${options.startProcess === false ? "Loaded" : "Created"}: ${id} (${name}, ${selectedModel.model})`);
  if (!options.skipPersist) persistSessionsSoon();
  return session;
}

function getQuickSession(): PiSession | undefined {
  return Array.from(sessions.values())
    .filter((session) => session.isQuick)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

function startSessionProcess(session: PiSession) {
  if (isProcessLive(session)) return session;
  const id = session.id;
  seedPiSessionFile(session);
  sessionStderrBuffers.delete(id);
  const { selectedModel, proc } = createPiProcess(session);
  session.modelId = selectedModel.id;
  session.modelLabel = selectedModel.label;
  session.proc = proc;

  let buffer = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // Keep incomplete last line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      recordPiEvent(id, trimmed);
      // Send pi_event WITH sessionId so client can route it
      const payload = JSON.stringify({
        type: "pi_event",
        sessionId: id,
        raw: trimmed,
      });
      const owner = sessionOwners.get(id);
      if (owner) {
        sendToSession(owner, payload);
      } else {
        sessionOutputBuffers.set(id, `${sessionOutputBuffers.get(id) || ""}${trimmed}\n`);
      }
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    sessionStderrBuffers.set(id, appendLimitedLog(sessionStderrBuffers.get(id) || "", text));
    console.error(`[Pi ${id}]`, text.trim());
  });

  proc.on("close", (code, signal) => {
    console.log(`[Session] ${id} closed (code ${code})`);
    const existing = sessions.get(id);
    const isCurrentProcess = existing?.proc === proc;
    if (isCurrentProcess) {
      sessionOwners.delete(id);
      sessionOutputBuffers.delete(id);
    }
    if (deletedSessions.has(id)) {
      deletedSessions.delete(id);
      return;
    }
    if (!isCurrentProcess) return;
    if (code && code !== 0) {
      if (existing?.activeAssistantId) {
        const assistant = existing.messages.find((m) => m.id === existing.activeAssistantId);
        if (assistant) {
          finishAssistantMetrics(assistant);
          assistant.isStreaming = false;
          assistant.isThinkingStreaming = false;
        }
        existing.activeAssistantId = undefined;
      }
      if (existing) existing.activeRun = false;
      addSessionError(existing, summarizePiCrash(id, code, signal));
      return;
    }
    if (existing?.activeAssistantId) {
      const assistant = existing.messages.find((m) => m.id === existing.activeAssistantId);
      if (assistant) {
        finishAssistantMetrics(assistant);
        assistant.isStreaming = false;
      }
      existing.activeAssistantId = undefined;
      existing.activeRun = false;
      persistSessionsSoon();
      broadcastSessionMessages(existing);
    }
  });

  return session;
}

function writePiCommand(session: PiSession, command: Record<string, unknown>) {
  startSessionProcess(session);
  session.proc!.stdin.write(JSON.stringify(rewriteRpcBashForTrash(command)) + "\n");
}

function getActiveAssistant(session: PiSession): ServerChatMessage {
  let assistant = session.messages.find((m) => m.id === session.activeAssistantId);
  if (!assistant) {
    assistant = {
      id: generateMessageId("assistant"),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      startedAt: Date.now(),
      isStreaming: true,
    };
    session.activeAssistantId = assistant.id;
    session.messages.push(assistant);
  }
  return assistant;
}

function contentText(part: any): string {
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  if (typeof part.delta === "string") return part.delta;
  return "";
}

function estimateTokens(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function finishAssistantMetrics(message: ServerChatMessage) {
  if (message.role !== "assistant") return;
  const startedAt = message.startedAt || message.timestamp;
  const completedAt = Date.now();
  const elapsedSeconds = Math.max(0.25, (completedAt - startedAt) / 1000);
  const tokenEstimate = estimateTokens(message.content);
  message.startedAt = startedAt;
  message.completedAt = completedAt;
  message.tokenEstimate = tokenEstimate || undefined;
  message.speedTokensPerSecond = tokenEstimate ? tokenEstimate / elapsedSeconds : undefined;
  const modelSpeed = cachedOmlxAdminStatus?.tokensPerSecond ?? parseModelRuntimeStatus()?.tokensPerSecond;
  message.modelTokensPerSecond = typeof modelSpeed === "number" && Number.isFinite(modelSpeed) && modelSpeed > 0
    ? modelSpeed
    : undefined;
}

function contentThinking(part: any): string {
  if (!part || typeof part !== "object") return "";
  if (typeof part.thinking === "string") return part.thinking;
  if (typeof part.reasoning === "string") return part.reasoning;
  if (typeof part.reasoningContent === "string") return part.reasoningContent;
  if (typeof part.reasoning_content === "string") return part.reasoning_content;
  if (typeof part.thinkingContent === "string") return part.thinkingContent;
  if (typeof part.thinking_content === "string") return part.thinking_content;
  if (typeof part.summary === "string") return part.summary;
  if (typeof part.text === "string" && /thinking|reasoning/i.test(String(part.type || ""))) return part.text;
  if (typeof part.delta === "string" && /thinking|reasoning/i.test(String(part.type || ""))) return part.delta;
  return "";
}

function extractAssistantContent(message: any): { text: string; thinking: string } {
  const content = message?.content;
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: "", thinking: "" };

  let text = "";
  let thinking = "";
  for (const part of content) {
    const type = String(part?.type || "");
    if (/thinking|reasoning/i.test(type)) {
      thinking += contentThinking(part);
    } else if (type === "text" || typeof part?.text === "string") {
      text += contentText(part);
    }
  }
  return { text, thinking };
}

function extractAssistantDelta(assistantMessageEvent: any): { text: string; thinking: string } {
  const type = String(assistantMessageEvent?.type || "");
  const delta = typeof assistantMessageEvent?.delta === "string" ? assistantMessageEvent.delta : "";
  if (/tool[_-]?call|toolcall/i.test(type) || assistantMessageEvent?.toolCall) return { text: "", thinking: "" };
  if (/thinking|reasoning/i.test(type)) return { text: "", thinking: delta };
  if (type === "text_delta") return { text: delta, thinking: "" };

  const { text, thinking } = extractAssistantContent({ content: assistantMessageEvent?.partial?.content });
  return {
    text: text || contentText(assistantMessageEvent),
    thinking: thinking || contentThinking(assistantMessageEvent),
  };
}

function toolDetailFromCall(toolCall: any): string | undefined {
  const args = toolCall?.arguments ?? toolCall?.args;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (typeof parsed?.command === "string") return parsed.command;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return args;
    }
  }
  if (args && typeof args === "object") {
    if (typeof args.command === "string") return args.command;
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  }
  return undefined;
}

function rememberToolDetail(sessionId: string, toolCall: any) {
  const toolCallId = String(toolCall?.id || "");
  if (!toolCallId) return;
  let sessionDetails = pendingToolDetails.get(sessionId);
  if (!sessionDetails) {
    sessionDetails = new Map();
    pendingToolDetails.set(sessionId, sessionDetails);
  }
  sessionDetails.set(toolCallId, {
    toolName: typeof toolCall?.name === "string" ? toolCall.name : undefined,
    detail: toolDetailFromCall(toolCall),
  });
}

function takeToolDetail(sessionId: string, toolCallId: unknown) {
  const id = String(toolCallId || "");
  if (!id) return undefined;
  const sessionDetails = pendingToolDetails.get(sessionId);
  const detail = sessionDetails?.get(id);
  sessionDetails?.delete(id);
  if (sessionDetails && sessionDetails.size === 0) pendingToolDetails.delete(sessionId);
  return detail;
}

function assistantErrorMessage(message: any): string {
  const stopReason = String(message?.stopReason || "");
  const errorMessage = typeof message?.errorMessage === "string" ? message.errorMessage.trim() : "";
  if (!errorMessage && stopReason !== "error") return "";
  if (/Prompt has \d+ tokens.*configured context size is \d+ tokens/i.test(errorMessage)) {
    return [
      "Pi could not answer because this chat's model context is too large for the selected model.",
      "",
      errorMessage,
      "",
      "Run `/reset-context` in this chat to keep the chat name and recent visible history while dropping the old model context.",
    ].join("\n");
  }
  return `Pi could not answer this message: ${errorMessage || "Unknown model error"}`;
}

function normalizeThinkingText(text: string): string {
  return normalizeRepeatedParagraphs(text);
}

function normalizeMessageText(text: string): string {
  return normalizeRepeatedParagraphs(text);
}

function normalizeRepeatedParagraphs(text: string): string {
  const paragraphs = text.split(/\n{2,}/);
  const deduped: string[] = [];

  for (const paragraph of paragraphs) {
    const current = paragraph.trim();
    const previous = deduped[deduped.length - 1]?.trim();
    if (current && current === previous) continue;
    deduped.push(paragraph);
    collapseRepeatedParagraphSuffix(deduped);
  }

  return collapseRepeatedTextSuffix(deduped.join("\n\n"));
}

function canonicalParagraph(paragraph: string): string {
  return paragraph
    .trim()
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\|[\s:|.-]+\|/g, (match) => match.replace(/[-:]+/g, "-"))
    .replace(/-{3,}/g, "---")
    .toLowerCase();
}

function canonicalTextBlock(text: string): string {
  return text
    .trim()
    .replace(/\r/g, "")
    .replace(/\|[\s:|.-]+\|/g, (match) => match.replace(/[-:]+/g, "-"))
    .replace(/-{3,}/g, "---")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function collapseRepeatedTextSuffix(text: string): string {
  const trimmed = text.trimEnd();
  const trailing = text.slice(trimmed.length);
  const lines = trimmed.split("\n");
  for (let length = Math.floor(lines.length / 2); length >= 2; length--) {
    const start = lines.length - length * 2;
    if (start < 0) continue;
    const first = lines.slice(start, start + length).join("\n");
    const second = lines.slice(start + length).join("\n");
    if (canonicalTextBlock(first) && canonicalTextBlock(first) === canonicalTextBlock(second)) {
      return `${lines.slice(0, start + length).join("\n")}${trailing}`;
    }
  }
  return text;
}

function collapseRepeatedParagraphSuffix(paragraphs: string[]) {
  let changed = true;

  while (changed) {
    changed = false;
    for (let length = Math.floor(paragraphs.length / 2); length >= 1; length--) {
      const start = paragraphs.length - length * 2;
      if (start < 0) continue;

      const first = paragraphs.slice(start, start + length).map((paragraph) => paragraph.trim());
      const second = paragraphs.slice(start + length).map((paragraph) => paragraph.trim());
      const firstCanonical = first.map(canonicalParagraph);
      const secondCanonical = second.map(canonicalParagraph);
      if (firstCanonical.every((paragraph, index) => paragraph && paragraph === secondCanonical[index])) {
        paragraphs.splice(start + length, length);
        changed = true;
        break;
      }
    }
  }
}

function appendAssistantText(existing: string, addition: string): string {
  if (!addition) return normalizeMessageText(existing);
  if (!existing) return normalizeMessageText(addition);

  const trimmedAddition = addition.trim();
  const trimmedExisting = existing.trim();

  if (addition.startsWith(existing)) return normalizeMessageText(addition);
  if (trimmedAddition.startsWith(trimmedExisting)) return normalizeMessageText(addition);

  if (trimmedAddition.length > 30) {
    if (trimmedExisting.includes(trimmedAddition)) return normalizeMessageText(existing);
    if (trimmedAddition.includes(trimmedExisting)) return normalizeMessageText(addition);
  }

  const maxOverlap = Math.min(existing.length, addition.length);
  for (let size = maxOverlap; size >= 2; size--) {
    if (existing.endsWith(addition.slice(0, size))) {
      return normalizeMessageText(`${existing}${addition.slice(size)}`);
    }
  }

  return normalizeMessageText(`${existing}${addition}`);
}

function appendThinking(existing: string | undefined, addition: string): string | undefined {
  if (!addition) return existing ? normalizeThinkingText(existing) : undefined;
  if (!existing) return normalizeThinkingText(addition);

  const trimmedAddition = addition.trim();
  const trimmedExisting = existing.trim();

  if (addition.startsWith(existing)) return normalizeThinkingText(addition);
  if (trimmedAddition.startsWith(trimmedExisting)) return normalizeThinkingText(addition);

  if (trimmedAddition.length > 30) {
    if (trimmedExisting.includes(trimmedAddition)) return normalizeThinkingText(existing);
    if (trimmedAddition.includes(trimmedExisting)) return normalizeThinkingText(addition);
  }

  const maxOverlap = Math.min(existing.length, addition.length);
  for (let size = maxOverlap; size >= 2; size--) {
    if (existing.endsWith(addition.slice(0, size))) {
      return normalizeThinkingText(`${existing}${addition.slice(size)}`);
    }
  }

  return normalizeThinkingText(`${existing}${addition}`);
}

function summarizePiCrash(sessionId: string, code: number | null, signal: NodeJS.Signals | null) {
  const raw = (sessionStderrBuffers.get(sessionId) || "").trim();
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const important = lines.filter((line) => /error|failed|parse|syntax|exception|cannot|enoent|eaddrinuse/i.test(line));
  const details = (important.length ? important : lines).slice(-6).join("\n");
  const status = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
  return [
    `Pi stopped before it could respond (${status}).`,
    details ? `\nMost useful detail:\n${details}` : "",
  ].join("");
}

function addSessionError(session: PiSession, content: string) {
  const last = session.messages[session.messages.length - 1];
  if (last?.role === "error" && last.content === content) return;
  session.messages.push({
    id: generateMessageId("error"),
    role: "error",
    content,
    timestamp: Date.now(),
  });
  broadcastSessionMessages(session);
}

function mergeAssistantMessageText(existing: string, incoming: string): string {
  if (!incoming) return normalizeMessageText(existing);
  if (!existing) return normalizeMessageText(incoming);

  const normalizedIncoming = normalizeMessageText(incoming);
  const normalizedExisting = normalizeMessageText(existing);
  const incomingCanonical = canonicalTextBlock(normalizedIncoming);
  const existingCanonical = canonicalTextBlock(normalizedExisting);

  if (incomingCanonical === existingCanonical) return normalizedIncoming;
  if (normalizedIncoming.startsWith(normalizedExisting) || incomingCanonical.startsWith(existingCanonical)) {
    return normalizedIncoming;
  }
  if (normalizedExisting.includes(normalizedIncoming) || existingCanonical.includes(incomingCanonical)) {
    return normalizedExisting;
  }

  const looksLikeDelta = normalizedIncoming.length <= Math.max(48, normalizedExisting.length * 0.45);
  return looksLikeDelta
    ? appendAssistantText(normalizedExisting, normalizedIncoming)
    : normalizedIncoming;
}

function mergeAssistantThinkingText(existing: string | undefined, incoming: string): string | undefined {
  if (!incoming) return existing ? normalizeThinkingText(existing) : undefined;
  if (!existing) return normalizeThinkingText(incoming);

  const normalizedIncoming = normalizeThinkingText(incoming);
  const normalizedExisting = normalizeThinkingText(existing);
  const incomingCanonical = canonicalTextBlock(normalizedIncoming);
  const existingCanonical = canonicalTextBlock(normalizedExisting);

  if (incomingCanonical === existingCanonical) return normalizedIncoming;
  if (normalizedIncoming.startsWith(normalizedExisting) || incomingCanonical.startsWith(existingCanonical)) {
    return normalizedIncoming;
  }
  if (normalizedExisting.includes(normalizedIncoming) || existingCanonical.includes(incomingCanonical)) {
    return normalizedExisting;
  }

  const looksLikeDelta = normalizedIncoming.length <= Math.max(48, normalizedExisting.length * 0.45);
  return looksLikeDelta
    ? appendThinking(normalizedExisting, normalizedIncoming)
    : normalizedIncoming;
}

function mergeAssistantSnapshot(assistant: ServerChatMessage, text: string, thinking: string) {
  if (text) {
    assistant.content = mergeAssistantMessageText(assistant.content, text);
  }
  if (thinking) {
    assistant.thinking = mergeAssistantThinkingText(assistant.thinking, thinking);
  }
  assistant.timestamp = Date.now();
}

function recordPiEvent(sessionId: string, rawLine: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  try {
    const event = JSON.parse(rawLine);

    switch (event.type) {
      case "response": {
        if (event.command === "prompt" && event.success === false) {
          const assistant = session.messages.find((m) => m.id === session.activeAssistantId);
          const errorText = `Pi could not answer this message: ${event.error || "Unknown error"}`;
          session.activeRun = false;
          if (assistant) {
            assistant.isStreaming = false;
            assistant.isThinkingStreaming = false;
            assistant.role = "error";
            assistant.content = errorText;
            session.activeAssistantId = undefined;
          } else {
            session.messages.push({
              id: generateMessageId("error"),
              role: "error",
              content: errorText,
              timestamp: Date.now(),
            });
          }
          modelStatusOverride = {
            provider: "ds4",
            phase: "failed",
            label: "Pi task failed",
            detail: event.error || "Unknown error after model request",
            updatedAt: Date.now(),
          };
          broadcastModelRuntimeStatus(true);
          broadcastSessionMessages(session);
        }
        recordRpcResponse(event);
        break;
      }

      case "model_change": {
        if (typeof event.provider === "string" && typeof event.modelId === "string") {
          const model = findModelByProviderId(event.provider, event.modelId);
          if (model) {
            session.modelId = model.id;
            session.modelLabel = model.label;
            persistSessionsSoon();
            broadcastAll(JSON.stringify({ type: "session_list", sessions: sessionList() }));
          }
        }
        break;
      }

      case "agent_start": {
        const id = generateMessageId("assistant");
        const activeModel = resolveModel(session.modelId);
        session.activeRun = true;
        session.activeAssistantId = id;
        modelStatusOverride = {
          provider: activeModel?.provider === "ds4" ? "ds4" : "omlx",
          phase: "generating",
          label: `${activeModel?.provider === "ds4" ? "DS4" : "oMLX"} generating`,
          detail: activeModel?.label || session.modelLabel,
          updatedAt: Date.now(),
        };
        broadcastModelRuntimeStatus(true);
        session.messages.push({
          id,
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          startedAt: Date.now(),
          isStreaming: true,
        });
        broadcastSessionMessages(session);
        break;
      }

      case "message_update": {
        if (event.assistantMessageEvent?.toolCall) {
          rememberToolDetail(session.id, event.assistantMessageEvent.toolCall);
        }
        const { text, thinking } = extractAssistantDelta(event.assistantMessageEvent);
        if (!text && !thinking) return;
        const assistant = getActiveAssistant(session);
        assistant.content = appendAssistantText(assistant.content, text);
        assistant.thinking = appendThinking(assistant.thinking, thinking);
        assistant.isThinkingStreaming = Boolean(thinking) || assistant.isThinkingStreaming;
        assistant.timestamp = Date.now();
        broadcastSessionMessagesSoon(session);
        break;
      }

      case "message": {
        if (event.message?.role !== "assistant") return;
        const { text, thinking } = extractAssistantContent(event.message);
        const errorText = assistantErrorMessage(event.message);
        if (!text && !thinking && !errorText) return;
        const assistant = getActiveAssistant(session);
        if (errorText) {
          assistant.role = "error";
          assistant.content = errorText;
          assistant.isStreaming = false;
          assistant.isThinkingStreaming = false;
          session.activeAssistantId = undefined;
          session.activeRun = false;
          modelStatusOverride = {
            provider: "ds4",
            phase: "failed",
            label: "Pi task failed",
            detail: errorText,
            updatedAt: Date.now(),
          };
          broadcastModelRuntimeStatus(true);
          broadcastSessionMessages(session);
          return;
        }
        mergeAssistantSnapshot(assistant, text, thinking);
        broadcastSessionMessagesSoon(session);
        break;
      }

      case "tool_execution_end": {
        const pendingTool = takeToolDetail(session.id, event.toolCallId);
        const assistant = session.messages.find((m) => m.id === session.activeAssistantId);
        if (assistant) {
          finishAssistantMetrics(assistant);
          assistant.isStreaming = false;
          assistant.isThinkingStreaming = false;
          assistant.timestamp = Date.now();
          session.activeAssistantId = undefined;
        }
        const output = Array.isArray(event.result?.content)
          ? event.result.content.map((part: any) => contentText(part)).filter(Boolean).join("\n")
          : "";
        session.messages.push({
          id: generateMessageId("tool"),
          role: "tool",
          content: event.toolName || "tool",
          toolName: event.toolName,
          toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
          detail: pendingTool?.detail,
          output,
          outputForContext: summarizeToolOutputForContext(output, event.toolName),
          timestamp: Date.now(),
        });
        broadcastSessionMessages(session);
        break;
      }

      case "agent_end": {
        const assistant = session.messages.find((m) => m.id === session.activeAssistantId);
        if (assistant) {
          finishAssistantMetrics(assistant);
          assistant.isStreaming = false;
          assistant.isThinkingStreaming = false;
          assistant.timestamp = Date.now();
        }
        session.activeAssistantId = undefined;
        session.activeRun = false;
        broadcastSessionMessages(session);
        break;
      }
    }
  } catch {
    // Non-JSON Pi output is still forwarded raw to the active browser, but not added to shared chat history.
  }
}

function recordRpcResponse(event: any) {
  const id = typeof event.id === "string" ? event.id : "";
  const pendingSlash = pendingSlashCommandRequests.get(id);
  if (pendingSlash) {
    pendingSlashCommandRequests.delete(id);
    if (pendingSlash.ws.readyState === WebSocket.OPEN) {
      pendingSlash.ws.send(JSON.stringify({
        type: "slash_commands",
        sessionId: pendingSlash.sessionId,
        commands: event.success && Array.isArray(event.data?.commands) ? event.data.commands : [],
      }));
    }
    return;
  }

  const pending = pendingRpcCommands.get(id);
  if (!pending) return;
  pendingRpcCommands.delete(id);

  const session = sessions.get(pending.sessionId);
  if (!session) return;

  const content = formatRpcResponse(pending.label, event);
  session.messages.push({
    id: generateMessageId(event.success ? "command" : "error"),
    role: event.success ? "assistant" : "error",
    content,
    timestamp: Date.now(),
  });
  broadcastSessionMessages(session);
}

function formatRpcResponse(label: string, event: any): string {
  if (!event.success) return `Command failed: ${label}\n\n${event.error || "Unknown error"}`;

  const data = event.data;
  switch (event.command) {
    case "get_commands": {
      const commands = Array.isArray(data?.commands) ? data.commands : [];
      if (commands.length === 0) return "No Pi slash commands are currently available in this session.";
      const rows = commands
        .map((command: any) => `| \`/${command.name}\` | ${command.source || ""} | ${command.description || ""} |`)
        .join("\n");
      return `Available Pi commands:\n\n| Command | Source | Description |\n|---|---|---|\n${rows}`;
    }
    case "get_state":
      return [
        "Session state:",
        "",
        `- Session: ${data?.sessionName || data?.sessionId || "current"}`,
        `- Model: ${data?.model?.provider && data?.model?.id ? `${data.model.provider}/${data.model.id}` : "unknown"}`,
        `- Thinking: ${data?.thinkingLevel || "unknown"}`,
        `- Messages: ${data?.messageCount ?? "unknown"}`,
        `- Pending: ${data?.pendingMessageCount ?? 0}`,
      ].join("\n");
    case "get_session_stats":
      return [
        "Session stats:",
        "",
        `- User messages: ${data?.userMessages ?? "unknown"}`,
        `- Assistant messages: ${data?.assistantMessages ?? "unknown"}`,
        `- Tool calls: ${data?.toolCalls ?? "unknown"}`,
        `- Cost: ${typeof data?.cost === "number" ? `$${data.cost.toFixed(4)}` : "unknown"}`,
        data?.contextUsage ? `- Context: ${data.contextUsage.tokens ?? "?"}/${data.contextUsage.contextWindow ?? "?"} tokens (${data.contextUsage.percent ?? "?"}%)` : "",
      ].filter(Boolean).join("\n");
    case "get_available_models": {
      const models = Array.isArray(data?.models) ? data.models : [];
      if (models.length === 0) return "No available models reported by Pi.";
      const rows = models
        .slice(0, 80)
        .map((model: any) => `| \`${model.provider}/${model.id}\` | ${model.name || model.label || ""} |`)
        .join("\n");
      return `Available models:\n\n| Model | Name |\n|---|---|\n${rows}`;
    }
    case "set_model":
      return `Model switched to \`${data?.provider || "unknown"}/${data?.id || "unknown"}\`.`;
    case "cycle_model":
      return data?.model ? `Model switched to \`${data.model.provider}/${data.model.id}\`.` : "No alternate model available to cycle to.";
    case "set_thinking_level":
      return "Thinking level updated.";
    case "cycle_thinking_level":
      return data?.level ? `Thinking level switched to \`${data.level}\`.` : "This model does not support thinking-level cycling.";
    case "compact":
      return [
        "Context compacted.",
        "",
        data?.summary ? data.summary : "",
      ].filter(Boolean).join("\n");
    case "bash":
      return `Bash command finished with exit code ${data?.exitCode ?? "unknown"}.\n\n\`\`\`\n${data?.output || ""}\n\`\`\``;
    case "export_html":
      return `Session exported to \`${data?.path || "unknown path"}\`.`;
    case "set_session_name":
      return "Pi session name updated.";
    case "set_auto_compaction":
      return "Auto-compaction setting updated.";
    case "set_auto_retry":
      return "Auto-retry setting updated.";
    case "abort_bash":
      return "Bash command aborted.";
    case "abort_retry":
      return "Retry aborted.";
    case "get_last_assistant_text":
      return data?.text ? `Last assistant response:\n\n${data.text}` : "No assistant response is available yet.";
    default:
      return `Command succeeded: ${label}`;
  }
}

function sendPiCommand(session: PiSession, command: Record<string, unknown>, label: string) {
  const id = generateCommandId();
  pendingRpcCommands.set(id, { sessionId: session.id, label });
  writePiCommand(session, { id, ...command });
}

function sendSlashCommands(ws: WebSocket, session: PiSession) {
  const id = generateCommandId();
  pendingSlashCommandRequests.set(id, { sessionId: session.id, ws });
  writePiCommand(session, { id, type: "get_commands" });
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function runLocalModelServer(action: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(MODEL_SERVER_HELPER, [action], {
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim();
}

function loadedOmlxModelIdsFromStats(stats: any): string[] {
  const models = Array.isArray(stats?.active_models?.models) ? stats.active_models.models : [];
  return models
    .map((model: any) => typeof model?.id === "string" ? model.id : "")
    .filter(Boolean);
}

async function unloadOmlxModel(modelId: string): Promise<boolean> {
  const config = readOmlxAdminConfig();
  if (!config) return false;
  const response = await fetch(`${config.baseUrl}/v1/models/${encodeURIComponent(modelId)}/unload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 400 || response.status === 404) return false;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`oMLX unload failed for ${modelId}: ${response.status}${body ? ` ${body.slice(0, 300)}` : ""}`);
  }
  return true;
}

async function prepareOmlxForModelSwitch(previousModel: ModelOption, nextModel: ModelOption) {
  if (previousModel.provider !== "omlx" && nextModel.provider !== "omlx") return;

  let loadedIds: string[] = [];
  const stats = await fetchOmlxAdminStats();
  if (stats) loadedIds = loadedOmlxModelIdsFromStats(stats);
  if (previousModel.provider === "omlx" && previousModel.model !== nextModel.model && !loadedIds.includes(previousModel.model)) {
    loadedIds.push(previousModel.model);
  }

  const unloadIds = Array.from(new Set(loadedIds.filter((id) => id && (nextModel.provider !== "omlx" || id !== nextModel.model))));
  if (unloadIds.length === 0) return;

  modelStatusOverride = {
    provider: "omlx",
    phase: "starting",
    label: "oMLX unloading previous model",
    detail: unloadIds.join(", "),
    updatedAt: Date.now(),
  };
  broadcastModelRuntimeStatus(true);

  try {
    for (const modelId of unloadIds) {
      await unloadOmlxModel(modelId);
    }

    for (let attempt = 0; attempt < 24; attempt += 1) {
      await sleep(1_000);
      const nextStats = await fetchOmlxAdminStats();
      const stillLoaded = loadedOmlxModelIdsFromStats(nextStats).filter((id) => unloadIds.includes(id));
      if (stillLoaded.length === 0) break;
      modelStatusOverride = {
        provider: "omlx",
        phase: "starting",
        label: "oMLX waiting for memory release",
        detail: stillLoaded.join(", "),
        updatedAt: Date.now(),
      };
      broadcastModelRuntimeStatus(true);
    }

    modelStatusOverride = {
      provider: "omlx",
      phase: "starting",
      label: "oMLX settling memory",
      detail: `${nextModel.label} will start after prior model memory settles`,
      updatedAt: Date.now(),
    };
    broadcastModelRuntimeStatus(true);
    await sleep(Number.isFinite(OMLX_SWITCH_SETTLE_MS) ? Math.max(0, OMLX_SWITCH_SETTLE_MS) : 8_000);
  } catch (error: any) {
    console.warn(`[Models] Direct oMLX unload failed before switching to ${nextModel.model}: ${error?.message || error}`);
    await runLocalModelServer("stop-omlx");
    if (nextModel.provider === "omlx") await runLocalModelServer("start-omlx");
    await sleep(Number.isFinite(OMLX_SWITCH_SETTLE_MS) ? Math.max(0, OMLX_SWITCH_SETTLE_MS) : 8_000);
  }
}

async function waitForModelSwitch(sessionId: string) {
  const pending = pendingModelSwitches.get(sessionId);
  if (pending) await pending;
}

async function prepareRuntimeForSession(session: PiSession) {
  const model = resolveModel(session.modelId);
  const action = model.provider === "ds4" ? "start-ds4" : model.provider === "omlx" ? "start-omlx" : undefined;
  if (!action) return;
  if (preparedRuntimeProvider === model.provider) return;
  const provider = model.provider === "ds4" ? "ds4" : "omlx";

  modelStatusOverride = {
    provider,
    phase: "starting",
    label: model.provider === "ds4" ? "Preparing DS4 chat" : "Preparing oMLX chat",
    detail: model.provider === "ds4"
      ? "Unloading active oMLX models before this DeepSeek chat resumes"
      : "Starting oMLX while leaving DS4 warm if it is already running",
    updatedAt: Date.now(),
  };
  broadcastModelRuntimeStatus(true);
  try {
    await runLocalModelServer(action);
    preparedRuntimeProvider = model.provider;
  } finally {
    modelStatusOverride = null;
    broadcastModelRuntimeStatus(true);
  }
}

async function switchSessionToModel(session: PiSession, modelId: ModelId) {
  const previousModel = resolveModel(session.modelId);
  const model = resolveModel(modelId);
  session.modelId = model.id;
  session.modelLabel = model.label;
  terminateSessionProcess(session);
  session.proc = undefined;
  session.activeAssistantId = undefined;
  session.activeRun = false;
  sessionStderrBuffers.delete(session.id);
  persistSessionsSoon();
  broadcastAll(JSON.stringify({ type: "session_list", sessions: sessionList() }));
  const preparation = prepareOmlxForModelSwitch(previousModel, model);
  pendingModelSwitches.set(session.id, preparation);
  try {
    await preparation;
  } finally {
    if (pendingModelSwitches.get(session.id) === preparation) pendingModelSwitches.delete(session.id);
  }
  return startSessionProcess(session);
}

async function handleLocalModelServerCommand(ws: WebSocket, session: PiSession, action: string) {
  const targetModelId = action === "start-ds4" ? "deepseek-v4-flash" : action === "start-omlx" ? DEFAULT_MODEL_ID : undefined;
  try {
    addChatMessage(session, "assistant", `Running local model server command: \`${action}\`...`);
    const output = await runLocalModelServer(action);
    if (action === "stop") preparedRuntimeProvider = null;
    if (action === "start-ds4") preparedRuntimeProvider = "ds4";
    if (action === "start-omlx") preparedRuntimeProvider = "omlx";
    if (targetModelId) {
      await switchSessionToModel(session, targetModelId);
      attachSession(ws, session);
    }
    const modelText = targetModelId ? `\n\nThis chat is now using \`${session.modelLabel}\`.` : "";
    addChatMessage(session, "assistant", `${output || "Done."}${modelText}`);
  } catch (error: any) {
    addChatMessage(session, "error", `Local model server command failed: \`${action}\`\n\n${error?.message || error}`);
  }
}

function addChatMessage(session: PiSession, role: ServerChatMessage["role"], content: string) {
  session.messages.push({
    id: generateMessageId(role === "user" ? "user" : role),
    role,
    content,
    timestamp: Date.now(),
  });
  broadcastSessionMessages(session);
}

function markSessionStopped(session: PiSession, content = "Stopped.") {
  const assistant = session.activeAssistantId
    ? session.messages.find((m) => m.id === session.activeAssistantId)
    : undefined;

  if (assistant) {
    finishAssistantMetrics(assistant);
    assistant.isStreaming = false;
    assistant.isThinkingStreaming = false;
    assistant.stopped = true;
    assistant.timestamp = Date.now();
    assistant.content = assistant.content.trim()
      ? `${assistant.content.trimEnd()}\n\n_${content}_`
      : content;
  } else {
    session.messages.push({
      id: generateMessageId("assistant"),
      role: "assistant",
      content,
      stopped: true,
      timestamp: Date.now(),
    });
  }

  session.activeAssistantId = undefined;
  session.activeRun = false;
  modelStatusOverride = {
    provider: resolveModel(session.modelId).provider === "ds4" ? "ds4" : "omlx",
    phase: "complete",
    label: "Stopped",
    detail: "pi-agent-web-stopped",
    updatedAt: Date.now(),
  };
  persistSessionsSoon();
  broadcastSessionMessages(session);
  broadcastAll(JSON.stringify({ type: "session_list", sessions: sessionList() }));
  broadcastModelRuntimeStatus(true);
}

function abortSession(session: PiSession) {
  if (!isProcessLive(session)) {
    markSessionStopped(session, "Stopped.");
    restartSessionProcess(session);
    return;
  }

  writePiCommand(session, { type: "abort" });
  writePiCommand(session, { type: "abort_bash" });
  writePiCommand(session, { type: "abort_retry" });

  const existingTimer = pendingAbortTimers.get(session.id);
  if (existingTimer) clearTimeout(existingTimer);

  pendingAbortTimers.set(session.id, setTimeout(() => {
    pendingAbortTimers.delete(session.id);
    const current = sessions.get(session.id);
    if (!current) return;
    if (!current.activeRun && !current.activeAssistantId) return;

    console.log(`[Session] Force-stopping Pi process for ${current.id}`);
    terminateSessionProcess(current);
    setTimeout(() => {
      if (isProcessLive(current)) terminateSessionProcess(current, "SIGKILL");
    }, 700).unref();
    current.proc = undefined;
    markSessionStopped(current, "Stopped. Pi was still busy, so this chat's Pi process was restarted.");
    startSessionProcess(current);
  }, 1500));
}

function parseSlashCommand(input: string) {
  const trimmed = input.trim();
  const [rawName = "", ...rest] = trimmed.slice(1).split(/\s+/);
  return {
    name: rawName.toLowerCase(),
    args: rest.join(" ").trim(),
  };
}

function modelRefFromOption(model: ModelOption) {
  return { provider: model.provider, modelId: model.model };
}

function modelRefForAlias(value: string) {
  const alias = value.toLowerCase();
  const models = getConfiguredModels();
  const compact = (model: ModelOption) => compactModelSearchText(`${model.id} ${model.label} ${model.provider} ${model.model} ${model.description || ""}`);
  const find = (predicate: (model: ModelOption, compactText: string) => boolean) => {
    const model = models.find((candidate) => predicate(candidate, compact(candidate)));
    return model ? modelRefFromOption(model) : undefined;
  };
  if (["mtp", "mtp-35b", "35b-mtp", "qwen-mtp"].includes(alias)) {
    return find((_model, text) => text.includes("mtp"));
  }
  if (["27", "27b", "dense", "qwen-dense"].includes(alias)) {
    return find((_model, text) => text.includes("dense") || text.includes("27b"));
  }
  if (["ds4", "deepseek", "deepseek-v4", "deepseek-v4-flash"].includes(alias)) {
    return find((model, text) => model.provider === "ds4" || text.includes("deepseek"));
  }
  if (["mistral", "mistral-small", "mistral4", "mistral-4", "small-4"].includes(alias)) {
    return find((model, text) => text.includes("mistral"));
  }
  if (["35", "35b", "a3b", "qwen"].includes(alias)) {
    return find((_model, text) => text.includes("qwen") && text.includes("35b") && !text.includes("mtp"));
  }
  return undefined;
}

function parseModelRef(input: string) {
  const value = input.trim();
  const alias = modelRefForAlias(value);
  if (alias) return alias;
  const slashIndex = value.indexOf("/");
  if (slashIndex > 0) {
    return {
      provider: value.slice(0, slashIndex),
      modelId: value.slice(slashIndex + 1),
    };
  }

  const query = value.toLowerCase();
  const compactQuery = compactModelSearchText(query);
  const terms = query.split(/[^a-z0-9.]+/i).map(term => term.trim()).filter(Boolean);
  const scored = getConfiguredModels()
    .map((model) => {
      const haystack = [
        model.id,
        model.label,
        model.provider,
        model.model,
        model.description || "",
      ].join(" ").toLowerCase();
      const compactHaystack = compactModelSearchText(haystack);
      const allTermsMatch = terms.length > 0 && terms.every(term => haystack.includes(term) || compactHaystack.includes(compactModelSearchText(term)));
      const compactMatch = compactQuery.length > 1 && compactHaystack.includes(compactQuery);
      const exactFieldMatch = [model.id, model.label, model.model].some(field => field.toLowerCase() === query);
      if (!allTermsMatch && !compactMatch && !exactFieldMatch) return null;
      let score = 0;
      if (exactFieldMatch) score += 100;
      if (compactHaystack === compactQuery) score += 80;
      if (compactMatch) score += 20 + compactQuery.length;
      if (allTermsMatch) score += 30 + terms.length * 4;
      if (model.id.toLowerCase().includes(query)) score += 10;
      if (model.label.toLowerCase().includes(query)) score += 8;
      return { model, score };
    })
    .filter((entry): entry is { model: ModelOption; score: number } => Boolean(entry))
    .sort((a, b) => b.score - a.score);
  if (scored.length > 0) {
    const match = scored[0].model;
    return modelRefFromOption(match);
  }

  return null;
}

function compactModelSearchText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function commandHelpText() {
  return [
    "Chat commands:",
    "",
    "| Command | What it does |",
    "|---|---|",
    "| `/commands` | Show slash commands exposed by Pi extensions, prompts, and skills |",
    "| `/reload` | Restart Pi for this chat and reload extensions/skills/prompts |",
    "| `/new [name]` | Start a new chat in the current project |",
    "| `/name <name>` | Rename this chat |",
    "| `/model` | List available Pi models |",
    "| `/model 35b`, `/model mtp`, or `/model dense` | Switch the current Pi session model. Partial names work too. |",
    "| `/model next` | Cycle to the next available model |",
    "| `/start-omlx` or `/omlx` | Start oMLX/Qwen while keeping DS4 warm if it is already running |",
    "| `/start-ds4` or `/ds4` | Unload active oMLX models, start DS4 if needed, and switch this chat to DeepSeek |",
    "| `/thinking [level]` | Set or cycle thinking level |",
    "| `/state` | Show current Pi session state |",
    "| `/stats` | Show current session stats |",
    "| `/compact [instructions]` | Ask Pi to summarize/compact the current context |",
    "| `/reset-context [instructions]` | Hard reset model context while keeping this chat and recent messages |",
    "| `/clear-context [instructions]` | Same as `/reset-context` |",
    "| `/auto-compact on/off` | Let Pi compact automatically when context gets large |",
    "| `/last` | Show the last assistant response text |",
    "| `/bash <command>` | Run a shell command through Pi |",
    "| `/export [path]` | Export this Pi session as HTML |",
    "",
    "Other slash commands are sent to Pi directly, so extension commands like `/your-command` still work.",
  ].join("\n");
}

function parseEnabledArg(args: string): boolean | null {
  const value = args.trim().toLowerCase();
  if (["on", "true", "yes", "1", "enable", "enabled"].includes(value)) return true;
  if (["off", "false", "no", "0", "disable", "disabled"].includes(value)) return false;
  return null;
}

function forwardSlashPrompt(session: PiSession, message: string, streamingBehavior?: unknown, images?: Array<{ type: "image"; data: string; mimeType: string }>) {
  writePiCommand(session, {
    type: "prompt",
    message,
    streamingBehavior,
    ...(images && images.length > 0 ? { images } : {}),
  });
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "attachment";
}

function normalizeAttachmentData(data: string): string {
  return data.includes(",") ? data.split(",").pop() || "" : data;
}

function savePromptAttachments(session: PiSession, attachments: unknown) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return {
      suffix: "",
      images: [] as Array<{ type: "image"; data: string; mimeType: string }>,
      previews: [] as NonNullable<ServerChatMessage["attachments"]>,
    };
  }

  const uploadDir = join(UPLOADS_DIR, session.id);
  mkdirSync(uploadDir, { recursive: true });

  const saved: string[] = [];
  const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  const previews: NonNullable<ServerChatMessage["attachments"]> = [];

  for (const raw of attachments.slice(0, 6) as IncomingAttachment[]) {
    const name = sanitizeFileName(typeof raw.name === "string" ? raw.name : "attachment");
    const mimeType = typeof raw.mimeType === "string" && raw.mimeType ? raw.mimeType : "application/octet-stream";
    const size = typeof raw.size === "number" ? raw.size : undefined;
    const data = typeof raw.data === "string" ? normalizeAttachmentData(raw.data) : "";
    if (!data) continue;

    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`;
    const path = join(uploadDir, fileName);
    writeFileSync(path, Buffer.from(data, "base64"));
    saved.push(`${name} (${mimeType}) -> ${path}`);
    previews.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      mimeType,
      size,
      url: `/uploads/${encodeURIComponent(session.id)}/${encodeURIComponent(fileName)}`,
    });

    if (mimeType.startsWith("image/")) {
      images.push({ type: "image", data, mimeType });
    }
  }

  return {
    suffix: saved.length > 0 ? `\n\nAttachments:\n${saved.map((item) => `- ${item}`).join("\n")}` : "",
    images,
    previews,
  };
}

function attachSession(ws: WebSocket, session: PiSession) {
  sessionOwners.set(session.id, ws);

  const buffered = sessionOutputBuffers.get(session.id);
  if (buffered) {
    for (const raw of buffered.split("\n")) {
      if (!raw.trim()) continue;
      sendToSession(ws, JSON.stringify({
        type: "pi_event",
        sessionId: session.id,
        raw,
      }));
    }
    sessionOutputBuffers.delete(session.id);
  }
}

function serializeSession(session: PiSession): PublicSession {
  const configuredModel = getConfiguredModels().find((model) => model.id === session.modelId);
  const profile = session.agentProfileId ? getAgentProfile(session.agentProfileId) : undefined;
  return {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    projectId: session.projectId,
    modelId: session.modelId,
    modelLabel: configuredModel?.label || session.modelLabel,
    modelProvider: configuredModel?.provider || resolveModel(session.modelId).provider,
    agentProfileId: profile?.id,
    agentProfileName: profile?.name,
    isQuick: Boolean(session.isQuick),
    isBusy: Boolean(session.activeRun || session.activeAssistantId),
  };
}

function sessionList(): PublicSession[] {
  return Array.from(sessions.values()).map(serializeSession);
}

function projectList(): Project[] {
  return Array.from(projects.values()).sort((a, b) => a.createdAt - b.createdAt);
}

function broadcastAgentProfiles(ws?: WebSocket) {
  const payload = JSON.stringify({
    type: "agent_profiles",
    profiles: agentProfiles,
    extensions: listAgentExtensions(),
    skills: listAgentSkills(),
  });
  if (ws) sendToSession(ws, payload);
  else broadcastAll(payload);
}

function broadcastProjectState() {
  broadcastAll(JSON.stringify({ type: "projects", projects: projectList(), defaultProjectId: DEFAULT_PROJECT_ID }));
  broadcastAll(JSON.stringify({ type: "session_list", sessions: sessionList() }));
}

function broadcastUiState() {
  broadcastAll(JSON.stringify({ type: "ui_state", uiState }));
}

function setActiveUiSession(sessionId: string | undefined) {
  if (sessionId && !sessions.has(sessionId)) return;
  uiState.activeSessionId = sessionId;
  persistSessionsSoon();
  broadcastUiState();
}

function parseDs4RuntimeStatus(): ModelRuntimeStatus | null {
  if (!existsSync(DS4_LOG_PATH)) return null;

  let text = "";
  let logUpdatedAt = Date.now();
  try {
    logUpdatedAt = statSync(DS4_LOG_PATH).mtimeMs;
    if (Date.now() - logUpdatedAt > 120_000) return null;
    text = readFileSync(DS4_LOG_PATH, "utf8").slice(-160_000);
  } catch {
    return null;
  }

  const lines = text.split(/\r?\n|\r/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];

    if (/sse headers failed/i.test(line)) {
      return {
        provider: "ds4",
        phase: "failed",
        label: "DS4 stream disconnected",
        detail: "The model did work, but Pi lost the streaming response before tokens reached the web UI. Resetting context usually fixes oversized requests.",
        updatedAt: logUpdatedAt,
      };
    }

    const prefill = line.match(/chat ctx=.*?(?:\s+(TOOLS))?\s+prefill chunk\s+(\d+)\/(\d+)\s+\(([\d.]+)%\).*?avg=([\d.]+)\s+t\/s\s+([\d.]+)s/);
    if (prefill) {
      const current = Number(prefill[2]);
      const total = Number(prefill[3]);
      const percent = Number(prefill[4]);
      const tokensPerSecond = Number(prefill[5]);
      const elapsedSeconds = Number(prefill[6]);
      return {
        provider: "ds4",
        phase: "prefill",
        label: `DS4 prefilling ${percent.toFixed(1)}%`,
        detail: `${current.toLocaleString()} / ${total.toLocaleString()} tokens at ${tokensPerSecond.toFixed(0)} tok/s`,
        current,
        total,
        percent,
        tokensPerSecond,
        elapsedSeconds,
        estimatedRemainingSeconds: tokensPerSecond > 0 ? Math.max(0, (total - current) / tokensPerSecond) : undefined,
        updatedAt: logUpdatedAt,
      };
    }

    const generating = line.match(/chat ctx=.*?\s+gen=(\d+).*?avg=([\d.]+)\s+t\/s\s+([\d.]+)s/);
    if (generating) {
      const current = Number(generating[1]);
      const tokensPerSecond = Number(generating[2]);
      const elapsedSeconds = Number(generating[3]);
      return {
        provider: "ds4",
        phase: "generating",
        label: `DS4 generating ${current.toLocaleString()} tokens`,
        detail: `${tokensPerSecond.toFixed(1)} tok/s`,
        current,
        tokensPerSecond,
        elapsedSeconds,
        updatedAt: logUpdatedAt,
      };
    }

    const finish = line.match(/chat ctx=.*?\s+gen=(\d+)\s+.*?finish=([^\s]+)\s+([\d.]+)s/);
    if (finish) {
      const current = Number(finish[1]);
      const elapsedSeconds = Number(finish[3]);
      return {
        provider: "ds4",
        phase: "complete",
        label: "DS4 model output finished",
        detail: `${current.toLocaleString()} generated tokens in ${elapsedSeconds.toFixed(1)}s; Pi may still be processing it`,
        current,
        elapsedSeconds,
        updatedAt: logUpdatedAt,
      };
    }

    if (/prompt done/.test(line)) {
      return {
        provider: "ds4",
        phase: "generating",
        label: "DS4 prompt ready",
        detail: "Generation should begin shortly",
        updatedAt: logUpdatedAt,
      };
    }

    if (/prompt start/.test(line)) {
      return {
        provider: "ds4",
        phase: "prefill",
        label: "DS4 prefill started",
        detail: "Waiting for first progress chunk",
        percent: 0,
        updatedAt: logUpdatedAt,
      };
    }

    if (/listening on http:\/\/127\.0\.0\.1:8001/.test(line)) {
      return {
        provider: "ds4",
        phase: "idle",
        label: "DS4 ready",
        detail: "Waiting for a request",
        updatedAt: logUpdatedAt,
      };
    }

    if (/Metal device|backend initialized/.test(line)) {
      return {
        provider: "ds4",
        phase: "starting",
        label: "DS4 Metal starting",
        detail: "Preparing model buffers",
        updatedAt: logUpdatedAt,
      };
    }
  }

  return parseRecentPiFailureStatus();
}

function parseLogTimestamp(line: string): number | undefined {
  const match = line.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:,\d+)?/);
  if (!match) return undefined;
  const parsed = Date.parse(`${match[1]}T${match[2]}`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readOmlxAdminConfig(): { baseUrl: string; apiKey: string } | null {
  try {
    const settings = JSON.parse(readFileSync(OMLX_SETTINGS_PATH, "utf8"));
    const host = process.env.OMLX_HOST || settings?.server?.host || "127.0.0.1";
    const port = Number(process.env.OMLX_PORT || settings?.server?.port || 8000);
    const apiKey = process.env.OMLX_API_KEY || settings?.auth?.api_key || "";
    if (!apiKey || !Number.isFinite(port)) return null;
    return { baseUrl: `http://${host}:${port}`, apiKey };
  } catch {
    return null;
  }
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(numberValue)) return numberValue;
  }
  return undefined;
}

function modelStatusFromOmlxAdminStats(stats: any): ModelRuntimeStatus | null {
  const now = Date.now();
  const models = Array.isArray(stats?.active_models?.models) ? stats.active_models.models : [];
  const activeModel = models.find((model: any) =>
    model?.is_loading ||
    Number(model?.active_requests || 0) > 0 ||
    Number(model?.waiting_requests || 0) > 0 ||
    (Array.isArray(model?.prefilling) && model.prefilling.length > 0) ||
    (Array.isArray(model?.generating) && model.generating.length > 0)
  ) || models[0];

  if (activeModel?.is_loading) {
    const elapsedSeconds = firstNumber(activeModel.loading_elapsed_seconds);
    const estimatedRemainingSeconds = firstNumber(activeModel.loading_remaining_seconds_estimate);
    return {
      provider: "omlx",
      phase: "starting",
      label: "oMLX loading model",
      detail: activeModel.id || "Preparing model",
      elapsedSeconds,
      estimatedRemainingSeconds,
      updatedAt: now,
    };
  }

  const prefilling = Array.isArray(activeModel?.prefilling) ? activeModel.prefilling[0] : undefined;
  if (prefilling) {
    const current = firstNumber(prefilling.processed);
    const total = firstNumber(prefilling.total);
    const tokensPerSecond = firstNumber(prefilling.speed);
    const estimatedRemainingSeconds = firstNumber(prefilling.eta);
    const percent = current !== undefined && total ? (current / total) * 100 : undefined;
    return {
      provider: "omlx",
      phase: "prefill",
      label: `oMLX reading prompt${percent !== undefined ? ` ${percent.toFixed(0)}%` : ""}`,
      detail: [
        activeModel.id,
        current !== undefined && total !== undefined ? `${current.toLocaleString()} / ${total.toLocaleString()} prompt tokens` : undefined,
        tokensPerSecond ? `${tokensPerSecond.toFixed(0)} tok/s` : undefined,
      ].filter(Boolean).join(" · "),
      current,
      total,
      percent,
      tokensPerSecond,
      estimatedRemainingSeconds,
      updatedAt: now,
    };
  }

  const generatingCount = Array.isArray(activeModel?.generating)
    ? activeModel.generating.length
    : Math.max(0, Number(activeModel?.active_requests || 0));
  if (generatingCount > 0) {
    const tokensPerSecond = firstNumber(stats?.avg_generation_tps);
    return {
      provider: "omlx",
      phase: "generating",
      label: "oMLX generating",
      detail: [
        activeModel?.id,
        `${generatingCount} active request${generatingCount === 1 ? "" : "s"}`,
        tokensPerSecond ? `${tokensPerSecond.toFixed(1)} avg tok/s` : undefined,
      ].filter(Boolean).join(" · "),
      tokensPerSecond,
      updatedAt: now,
    };
  }

  if (activeModel) {
    const totalRequests = firstNumber(stats?.total_requests);
    const avgPrefill = firstNumber(stats?.avg_prefill_tps);
    const avgGeneration = firstNumber(stats?.avg_generation_tps);
    return {
      provider: "omlx",
      phase: "idle",
      label: "oMLX ready",
      detail: [
        activeModel.id,
        totalRequests !== undefined ? `${totalRequests.toLocaleString()} requests this run` : undefined,
        avgPrefill ? `${avgPrefill.toFixed(0)} prompt tok/s` : undefined,
        avgGeneration ? `${avgGeneration.toFixed(1)} output tok/s` : undefined,
      ].filter(Boolean).join(" · "),
      tokensPerSecond: avgGeneration,
      updatedAt: now,
    };
  }

  return null;
}

async function fetchOmlxAdminStats(retryLogin = true): Promise<any | null> {
  const config = readOmlxAdminConfig();
  if (!config) return null;

  const headers: Record<string, string> = {};
  if (omlxAdminCookie) headers.Cookie = omlxAdminCookie;

  try {
    let response = await fetch(`${config.baseUrl}/admin/api/stats`, { headers, signal: AbortSignal.timeout(1500) });
    if (response.status === 401 && retryLogin) {
      const login = await fetch(`${config.baseUrl}/admin/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: config.apiKey }),
        signal: AbortSignal.timeout(1500),
      });
      if (!login.ok) {
        omlxAdminCookie = "";
        return null;
      }
      const setCookie = login.headers.get("set-cookie");
      omlxAdminCookie = setCookie ? setCookie.split(";")[0] : "";
      return await fetchOmlxAdminStats(false);
    }
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function refreshOmlxAdminStatus() {
  const stats = await fetchOmlxAdminStats();
  const status = stats ? modelStatusFromOmlxAdminStats(stats) : null;
  cachedOmlxAdminStatus = status;
}

function parseOmlxRuntimeStatus(): ModelRuntimeStatus | null {
  if (cachedOmlxAdminStatus && Date.now() - cachedOmlxAdminStatus.updatedAt < 8_000) {
    return cachedOmlxAdminStatus;
  }

  if (!existsSync(OMLX_LOG_PATH)) return null;

  let text = "";
  try {
    text = readFileSync(OMLX_LOG_PATH, "utf8").slice(-160_000);
  } catch {
    return null;
  }

  const lines = text.split(/\r?\n|\r/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const timestamp = parseLogTimestamp(line) || Date.now();
    if (Date.now() - timestamp > 120_000) continue;

    const completion = line.match(/Chat completion:\s+(\d+)\s+tokens in\s+([\d.]+)s\s+\(([\d.]+)\s+tok\/s\),\s+prompt:\s+(\d+)/i);
    if (completion) {
      const current = Number(completion[1]);
      const elapsedSeconds = Number(completion[2]);
      const tokensPerSecond = Number(completion[3]);
      const promptTokens = Number(completion[4]);
      return {
        provider: "omlx",
        phase: "complete",
        label: "oMLX output finished",
        detail: `${current.toLocaleString()} generated tokens at ${tokensPerSecond.toFixed(1)} tok/s; prompt ${promptTokens.toLocaleString()} tokens`,
        current,
        tokensPerSecond,
        elapsedSeconds,
        updatedAt: timestamp,
      };
    }

    const cache = line.match(/Using boundary cache snapshot.*?storing\s+(\d+)\/(\d+)\s+tokens/i);
    if (cache) {
      const current = Number(cache[1]);
      const total = Number(cache[2]);
      const percent = total > 0 ? (current / total) * 100 : undefined;
      return {
        provider: "omlx",
        phase: "prefill",
        label: `oMLX cache ${percent ? percent.toFixed(1) : "active"}%`,
        detail: `${current.toLocaleString()} / ${total.toLocaleString()} prompt tokens cached`,
        current,
        total,
        percent,
        updatedAt: timestamp,
      };
    }

    const loading = line.match(/Loading model:\s+(.+)$/i);
    if (loading) {
      return {
        provider: "omlx",
        phase: "starting",
        label: "oMLX loading model",
        detail: loading[1],
        updatedAt: timestamp,
      };
    }

    const loaded = line.match(/Loaded model:\s+(.+?)\s+\(estimated:\s+([^,]+),\s+total:\s+([^)]+)\)/i);
    if (loaded) {
      return {
        provider: "omlx",
        phase: "idle",
        label: "oMLX ready",
        detail: `${loaded[1]} loaded, ${loaded[3]} active`,
        updatedAt: timestamp,
      };
    }

    if (/Uvicorn running on http:\/\/127\.0\.0\.1:8000/i.test(line)) {
      return {
        provider: "omlx",
        phase: "idle",
        label: "oMLX server ready",
        detail: "Listening on port 8000",
        updatedAt: timestamp,
      };
    }
  }

  return null;
}

function parseModelRuntimeStatus(): ModelRuntimeStatus | null {
  const ds4 = parseDs4RuntimeStatus();
  const omlx = parseOmlxRuntimeStatus();
  const parsed = ds4 && omlx ? (ds4.updatedAt >= omlx.updatedAt ? ds4 : omlx) : (ds4 || omlx);

  const overrideMaxAge = modelStatusOverride?.phase === "failed" ? 15_000 : 120_000;
  if (modelStatusOverride && Date.now() - modelStatusOverride.updatedAt < overrideMaxAge) {
    if (modelStatusOverride.detail === "pi-agent-web-stopped") return modelStatusOverride;
    if (parsed && parsed.updatedAt > modelStatusOverride.updatedAt) return parsed;
    return modelStatusOverride;
  }

  return parsed;
}

function parseRecentPiFailureStatus(): ModelRuntimeStatus | null {
  if (!existsSync(PI_SESSIONS_DIR)) return null;

  try {
    const recentFiles = readdirSync(PI_SESSIONS_DIR)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => {
        const path = join(PI_SESSIONS_DIR, name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 5);

    for (const file of recentFiles) {
      if (Date.now() - file.mtimeMs > 15_000) continue;
      const lines = readFileSync(file.path, "utf8").trim().split(/\r?\n/).slice(-80).reverse();
      for (const line of lines) {
        if (!line.includes("errorMessage") && !line.includes('"role":"error"')) continue;
        const parsed = JSON.parse(line);
        const errorMessage = parsed?.message?.errorMessage || parsed?.errorMessage || parsed?.content;
        if (typeof errorMessage !== "string" || !errorMessage.trim()) continue;
        return {
          provider: "ds4",
          phase: "failed",
          label: "Pi task failed",
          detail: errorMessage,
          updatedAt: Date.now(),
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

let lastModelStatusJson = "";
function broadcastModelRuntimeStatus(force = false) {
  const status = parseModelRuntimeStatus();
  if (!status) {
    if (lastModelStatusJson) {
      lastModelStatusJson = "";
      broadcastAll(JSON.stringify({ type: "model_status", status: null }));
    }
    return;
  }
  const payload = JSON.stringify({ type: "model_status", status });
  if (!force && payload === lastModelStatusJson) return;
  lastModelStatusJson = payload;
  broadcastAll(payload);
}

function sendSessionMessages(ws: WebSocket, session: PiSession) {
  sendToSession(ws, JSON.stringify({
    type: "messages",
    sessionId: session.id,
    isBusy: Boolean(session.activeRun || session.activeAssistantId),
    messages: visibleSessionMessages(session),
  }));
}

function broadcastSessionMessages(session: PiSession) {
  clearLiveMessageBroadcast(session.id);
  broadcastSessionMessagesNow(session, { persist: true });
}

function broadcastSessionMessagesNow(session: PiSession, options: { persist: boolean }) {
  trimSessionMessages(session);
  if (options.persist) persistSessionsSoon();
  broadcastAll(JSON.stringify({
    type: "messages",
    sessionId: session.id,
    isBusy: Boolean(session.activeRun || session.activeAssistantId),
    messages: visibleSessionMessages(session),
  }));
}

function broadcastSessionMessagesSoon(session: PiSession, delayMs = 180) {
  if (liveMessageBroadcastTimers.has(session.id)) return;
  const sessionId = session.id;
  const timer = setTimeout(() => {
    liveMessageBroadcastTimers.delete(sessionId);
    const current = sessions.get(sessionId);
    if (current) broadcastSessionMessagesNow(current, { persist: false });
  }, delayMs);
  liveMessageBroadcastTimers.set(sessionId, timer);
}

function clearLiveMessageBroadcast(sessionId: string) {
  const timer = liveMessageBroadcastTimers.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  liveMessageBroadcastTimers.delete(sessionId);
}

function visibleSessionMessages(session: PiSession) {
  return session.messages.slice(-MAX_VISIBLE_MESSAGES).map((message) => {
    const { outputForContext: _outputForContext, ...visibleMessage } = message;
    return {
      ...visibleMessage,
      content: typeof message.content === "string" ? normalizeMessageText(message.content) : message.content,
      thinking: message.thinking ? normalizeThinkingText(message.thinking) : undefined,
    };
  });
}

function trimSessionMessages(session: PiSession) {
  if (session.messages.length <= MAX_VISIBLE_MESSAGES) return;
  const activeAssistant = session.activeAssistantId
    ? session.messages.find((message) => message.id === session.activeAssistantId)
    : undefined;
  session.messages = session.messages.slice(-MAX_VISIBLE_MESSAGES);
  if (activeAssistant && !session.messages.some((message) => message.id === activeAssistant.id)) {
    session.messages.push(activeAssistant);
  }
}

function sanitizeClientMessages(messages: unknown): ServerChatMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message && typeof message === "object")
    .map((message: any) => ({
      id: typeof message.id === "string" ? message.id : generateMessageId(String(message.role || "message")),
      role: ["user", "assistant", "tool", "error"].includes(message.role) ? message.role : "assistant",
      content: typeof message.content === "string" ? normalizeMessageText(message.content) : "",
      attachments: Array.isArray(message.attachments)
        ? message.attachments
          .filter((attachment: any) => attachment && typeof attachment === "object")
          .map((attachment: any) => ({
            id: typeof attachment.id === "string" ? attachment.id : generateMessageId("attachment"),
            name: typeof attachment.name === "string" ? attachment.name : "attachment",
            mimeType: typeof attachment.mimeType === "string" ? attachment.mimeType : "application/octet-stream",
            size: typeof attachment.size === "number" ? attachment.size : undefined,
            url: typeof attachment.url === "string" ? attachment.url : undefined,
          }))
        : undefined,
      toolName: typeof message.toolName === "string" ? message.toolName : undefined,
      toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
      detail: typeof message.detail === "string" ? message.detail : undefined,
      output: typeof message.output === "string" ? message.output : undefined,
      outputForContext: typeof message.outputForContext === "string"
        ? message.outputForContext
        : typeof message.output === "string"
          ? summarizeToolOutputForContext(message.output, message.toolName)
          : undefined,
      thinking: typeof message.thinking === "string" ? normalizeThinkingText(message.thinking) : undefined,
      timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
      startedAt: typeof message.startedAt === "number" ? message.startedAt : undefined,
      completedAt: typeof message.completedAt === "number" ? message.completedAt : undefined,
      speedTokensPerSecond: typeof message.speedTokensPerSecond === "number" ? message.speedTokensPerSecond : undefined,
      modelTokensPerSecond: typeof message.modelTokensPerSecond === "number" ? message.modelTokensPerSecond : undefined,
      tokenEstimate: typeof message.tokenEstimate === "number" ? message.tokenEstimate : undefined,
      isStreaming: false,
      isThinkingStreaming: false,
      stopped: Boolean(message.stopped),
    }));
}

function persistedSessionsPayload() {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    projects: projectList(),
    uiState,
    sessions: Array.from(sessions.values()).map((session) => ({
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      projectId: session.projectId,
      modelId: session.modelId,
      modelLabel: session.modelLabel,
      modelProvider: resolveModel(session.modelId).provider,
      agentProfileId: session.agentProfileId,
      agentProfileName: session.agentProfileId ? getAgentProfile(session.agentProfileId).name : undefined,
      isQuick: Boolean(session.isQuick),
      sessionFile: session.sessionFile,
      messages: session.messages.slice(-MAX_VISIBLE_MESSAGES).map((message) => ({
        ...message,
        content: normalizeMessageText(message.content),
        outputForContext: message.role === "tool"
          ? message.outputForContext || (message.output ? summarizeToolOutputForContext(message.output, message.toolName) : undefined)
          : undefined,
        thinking: message.thinking ? normalizeThinkingText(message.thinking) : undefined,
        isStreaming: false,
        isThinkingStreaming: false,
      })),
    })),
  };
}

function savePersistedSessions() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tempFile = `${SESSIONS_FILE}.tmp`;
  writeFileSync(tempFile, JSON.stringify(persistedSessionsPayload(), null, 2));
  renameSync(tempFile, SESSIONS_FILE);
}

function persistSessionsSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      savePersistedSessions();
    } catch (err) {
      console.error("[Persist] Failed to save sessions:", err);
    }
  }, 150);
}

function loadPersistedSessions() {
  if (!existsSync(SESSIONS_FILE)) return;

  try {
    const data = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    if (Array.isArray(data.projects)) {
      for (const project of data.projects) {
        if (!project?.id || typeof project.name !== "string") continue;
        projects.set(project.id, {
          id: project.id,
          name: project.name.trim() || "Untitled",
          createdAt: typeof project.createdAt === "number" ? project.createdAt : Date.now(),
        });
      }
      if (!projects.has(DEFAULT_PROJECT_ID)) {
        projects.set(DEFAULT_PROJECT_ID, { id: DEFAULT_PROJECT_ID, name: "Inbox", createdAt: 0 });
      }
    }
    if (data.uiState && typeof data.uiState === "object") {
      uiState = {
        activeSessionId: typeof data.uiState.activeSessionId === "string" ? data.uiState.activeSessionId : undefined,
        collapsedProjectIds: Array.isArray(data.uiState.collapsedProjectIds)
          ? data.uiState.collapsedProjectIds.filter((id: unknown): id is string => typeof id === "string")
          : [],
      };
    }
    const persistedSessions = Array.isArray(data.sessions) ? data.sessions : [];
    for (const persisted of persistedSessions) {
      if (!persisted?.id || sessions.has(persisted.id)) continue;
      createSession(
        persisted.name || "Restored Chat",
        undefined,
        persisted.modelId,
        {
          id: persisted.id,
          createdAt: typeof persisted.createdAt === "number" ? persisted.createdAt : Date.now(),
          projectId: typeof persisted.projectId === "string" ? persisted.projectId : DEFAULT_PROJECT_ID,
          agentProfileId: typeof persisted.agentProfileId === "string" ? persisted.agentProfileId : undefined,
          isQuick: Boolean(persisted.isQuick),
          sessionFile: typeof persisted.sessionFile === "string" ? persisted.sessionFile : sessionFileForId(persisted.id),
          messages: sanitizeClientMessages(persisted.messages),
          restoredFromClient: true,
          skipPersist: true,
          startProcess: false,
        },
      );
    }
    if (uiState.activeSessionId && !sessions.has(uiState.activeSessionId)) {
      uiState.activeSessionId = undefined;
    }
    console.log(`[Persist] Loaded ${persistedSessions.length} session(s) from disk`);
  } catch (err) {
    console.error("[Persist] Failed to load sessions:", err);
  }
}

function isProcessLive(session: PiSession) {
  if (!session.proc) return false;
  return session.proc.exitCode === null && session.proc.signalCode === null && !session.proc.killed && session.proc.stdin.writable;
}

function terminateSessionProcess(session: PiSession, signal: NodeJS.Signals = "SIGTERM") {
  const proc = session.proc;
  if (!proc || !isProcessLive(session)) return;
  try {
    if (proc.pid) process.kill(-proc.pid, signal);
    else proc.kill(signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // The process may already have exited between the liveness check and the signal.
    }
  }
}

function restartSessionProcess(session: PiSession) {
  console.log(`[Session] Restarting Pi process for ${session.id}`);
  terminateSessionProcess(session);
  session.proc = undefined;
  session.activeAssistantId = undefined;
  session.activeRun = false;
  return startSessionProcess(session);
}

// Send to all connected clients (use sparingly)
function broadcastAll(data: string) {
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// Send only to the WebSocket that owns a session
function sendToSession(ws: WebSocket, data: string) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
}

// ── Express Server ──────────────────────────────────────────────────

const app = express();
const server = createServer(app);

const clientDist = join(__dirname, "../client/dist");
const publicDir = join(__dirname, "../public");
const buildDir = existsSync(clientDist) ? clientDist : existsSync(publicDir) ? publicDir : null;

app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

if (buildDir) {
  app.use(express.static(buildDir, {
    etag: false,
    lastModified: false,
  }));
}

app.use("/uploads", express.static(UPLOADS_DIR, {
  etag: false,
  lastModified: false,
  fallthrough: false,
}));

app.get("/api/sessions", (_req, res) => {
  res.json(sessionList());
});

app.get("/api/runtime", (_req, res) => {
  const allSessions = Array.from(sessions.values());
  const activeSessions = allSessions.filter((session) => isProcessLive(session));
  const streamingSessions = allSessions.filter((session) => Boolean(session.activeAssistantId));
  res.json({
    safeToRestart: streamingSessions.length === 0,
    sessions: allSessions.length,
    activeProcesses: activeSessions.length,
    dormantSessions: allSessions.length - activeSessions.length,
    streamingSessions: streamingSessions.map((session) => ({
      id: session.id,
      name: session.name,
    })),
  });
});

app.get("*", (_req, res) => {
  if (buildDir) res.sendFile(join(buildDir, "index.html"));
  else res.send("Pi Agent Web");
});

// ── WebSocket Server ────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

loadPersistedSessions();
let omlxStatsPollInFlight = false;
setInterval(() => {
  if (omlxStatsPollInFlight) return;
  omlxStatsPollInFlight = true;
  refreshOmlxAdminStatus()
    .catch(() => undefined)
    .finally(() => {
      omlxStatsPollInFlight = false;
      broadcastModelRuntimeStatus();
    });
}, 1500).unref();

wss.on("connection", (ws) => {
  console.log("[WS] Client connected");

  ws.send(JSON.stringify({
    type: "session_list",
    sessions: sessionList(),
  }));
  ws.send(JSON.stringify({
    type: "projects",
    projects: projectList(),
    defaultProjectId: DEFAULT_PROJECT_ID,
  }));
  ws.send(JSON.stringify({
    type: "models",
    models: getConfiguredModels(),
    defaultModelId: getDefaultModelId(),
  }));
  broadcastAgentProfiles(ws);
  ws.send(JSON.stringify({ type: "ui_state", uiState }));
  const initialModelStatus = parseModelRuntimeStatus();
  if (initialModelStatus) {
    ws.send(JSON.stringify({ type: "model_status", status: initialModelStatus }));
  }
  if (uiState.activeSessionId) {
    const activeSession = sessions.get(uiState.activeSessionId);
    if (activeSession) {
      attachSession(ws, activeSession);
      sendSessionMessages(ws, activeSession);
    }
  }

  ws.on("message", async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      const cmdType = msg.type as string;
      const sessionId = msg.sessionId as string;

      console.log("[WS]", cmdType, sessionId ? `for ${sessionId}` : "(no sessionId)");
      if (!sessionId) {
        console.log("[WS] Available sessions:", Array.from(sessions.keys()));
      }

      switch (cmdType) {
        case "restore_client_state": {
          // The server is the source of truth. Older browser caches must not resurrect deleted chats.
          ws.send(JSON.stringify({
            type: "session_list",
            sessions: sessionList(),
          }));
          ws.send(JSON.stringify({
            type: "projects",
            projects: projectList(),
            defaultProjectId: DEFAULT_PROJECT_ID,
          }));
          broadcastAgentProfiles(ws);
          ws.send(JSON.stringify({ type: "ui_state", uiState }));
          break;
        }

        case "resume_session": {
          const requestedSessionId = msg.sessionId as string | undefined;
          let session = requestedSessionId ? sessions.get(requestedSessionId) : undefined;
          let resumed = Boolean(session);

          if (!session) {
            if (requestedSessionId) {
              ws.send(JSON.stringify({ type: "session_deleted", sessionId: requestedSessionId }));
              ws.send(JSON.stringify({
                type: "session_list",
                sessions: sessionList(),
              }));
              break;
            }
            session = createSession(msg.name || "New Chat", undefined, msg.modelId as string | undefined, {
              projectId: typeof msg.projectId === "string" ? msg.projectId : DEFAULT_PROJECT_ID,
              agentProfileId: typeof msg.agentProfileId === "string" ? msg.agentProfileId : undefined,
              isQuick: Boolean(msg.isQuick),
            });
            resumed = false;
            console.log(`[WS] Created replacement session ${session.id}`);
          } else {
            if (!isProcessLive(session)) session = restartSessionProcess(session);
            console.log(`[WS] Resumed session ${session.id}`);
          }

          attachSession(ws, session);
          setActiveUiSession(session.id);
          ws.send(JSON.stringify({
            type: "connected",
            sessionId: session.id,
            resumed,
          }));
          sendSessionMessages(ws, session);
          ws.send(JSON.stringify({
            type: "session_list",
            sessions: sessionList(),
          }));
          break;
        }

        case "restore_history": {
          const target = sessions.get(sessionId);
          if (target) {
            const msgs = msg.messages as Array<{role: string, content: string}> | undefined;
            if (msgs && Array.isArray(msgs)) {
              for (const m of msgs) {
                writePiCommand(target, { type: "prompt", message: m.content });
              }
              ws.send(JSON.stringify({ type: "history_restored", sessionId }));
            }
          }
          break;
        }

        case "prompt": {
          let target = sessions.get(sessionId);
          if (!target) {
            console.error(`[WS] Session ${sessionId} not found! Available: ${Array.from(sessions.keys()).join(", ")}`);
            ws.send(JSON.stringify({ type: "error", data: `Session ${sessionId} not found` }));
            break;
          }
          await waitForModelSwitch(target.id);
          target = sessions.get(sessionId) || target;
          await prepareRuntimeForSession(target);
          if (!isProcessLive(target)) {
            target = restartSessionProcess(target);
            attachSession(ws, target);
          }
          const attachments = savePromptAttachments(target, msg.attachments);
          const visibleText = String(msg.message || "");
          const messageText = `${visibleText}${attachments.suffix}`;
          target.messages.push({
            id: generateMessageId("user"),
            role: "user",
            content: visibleText,
            ...(attachments.previews.length > 0 ? { attachments: attachments.previews } : {}),
            timestamp: Date.now(),
          });
          broadcastSessionMessages(target);
          writePiCommand(target, {
            type: "prompt",
            message: messageText,
            streamingBehavior: msg.streamingBehavior,
            ...(attachments.images.length > 0 ? { images: attachments.images } : {}),
          });
          break;
        }

        case "slash_command": {
          let target = sessions.get(sessionId);
          if (!target) {
            console.error(`[WS] Session ${sessionId} not found! Available: ${Array.from(sessions.keys()).join(", ")}`);
            ws.send(JSON.stringify({ type: "error", data: `Session ${sessionId} not found` }));
            break;
          }
          await waitForModelSwitch(target.id);
          target = sessions.get(sessionId) || target;
          if (!isProcessLive(target)) {
            target = restartSessionProcess(target);
            attachSession(ws, target);
          }

          const attachments = savePromptAttachments(target, msg.attachments);
          const visibleText = String(msg.message || "").trim();
          const text = `${visibleText}${attachments.suffix}`;
          if (!text.startsWith("/")) {
            target.messages.push({
              id: generateMessageId("user"),
              role: "user",
              content: visibleText,
              ...(attachments.previews.length > 0 ? { attachments: attachments.previews } : {}),
              timestamp: Date.now(),
            });
            broadcastSessionMessages(target);
            forwardSlashPrompt(target, text, msg.streamingBehavior, attachments.images);
            break;
          }

          target.messages.push({
            id: generateMessageId("user"),
            role: "user",
            content: visibleText,
            ...(attachments.previews.length > 0 ? { attachments: attachments.previews } : {}),
            timestamp: Date.now(),
          });
          broadcastSessionMessages(target);
          const { name, args } = parseSlashCommand(text);

          switch (name) {
            case "help":
              addChatMessage(target, "assistant", commandHelpText());
              break;

            case "commands":
              sendPiCommand(target, { type: "get_commands" }, "/commands");
              break;

            case "start-ds4":
            case "ds4":
              await handleLocalModelServerCommand(ws, target, "start-ds4");
              break;

            case "start-omlx":
            case "omlx":
              await handleLocalModelServerCommand(ws, target, "start-omlx");
              break;

            case "stop-model-server":
            case "stop-model-servers":
              await handleLocalModelServerCommand(ws, target, "stop");
              break;

            case "reload": {
              terminateSessionProcess(target);
              target = createSession(target.name, undefined, target.modelId, {
                id: target.id,
                createdAt: target.createdAt,
                projectId: target.projectId,
                agentProfileId: target.agentProfileId,
                isQuick: target.isQuick,
                sessionFile: target.sessionFile,
                messages: target.messages,
                restoredFromClient: target.restoredFromClient,
                skipPersist: true,
              });
              attachSession(ws, target);
              ws.send(JSON.stringify({ type: "session_switched", sessionId: target.id }));
              broadcastAll(JSON.stringify({ type: "session_list", sessions: sessionList() }));
              addChatMessage(target, "assistant", "Reloaded Pi for this chat. Extensions, skills, prompts, and context files will be picked up by the new process.");
              break;
            }

            case "new": {
              const newSession = createSession(args || "New Chat", undefined, msg.modelId as string | undefined, {
                projectId: target.projectId,
                agentProfileId: target.agentProfileId,
                isQuick: target.isQuick,
              });
              attachSession(ws, newSession);
              ws.send(JSON.stringify({
                type: "session_created",
                sessionId: newSession.id,
                projectId: newSession.projectId,
                modelId: newSession.modelId,
                modelLabel: newSession.modelLabel,
                modelProvider: resolveModel(newSession.modelId).provider,
                agentProfileId: newSession.agentProfileId,
                agentProfileName: newSession.agentProfileId ? getAgentProfile(newSession.agentProfileId).name : undefined,
                isQuick: Boolean(newSession.isQuick),
              }));
              sendSessionMessages(ws, newSession);
              broadcastAll(JSON.stringify({ type: "session_list", sessions: sessionList() }));
              if (args) {
                newSession.name = args;
                persistSessionsSoon();
                broadcastAll(JSON.stringify({ type: "session_list", sessions: sessionList() }));
              }
              break;
            }

            case "name":
              if (!args) {
                addChatMessage(target, "assistant", "Usage: `/name <chat name>`");
                break;
              }
              target.name = args;
              persistSessionsSoon();
              broadcastAll(JSON.stringify({ type: "session_list", sessions: sessionList() }));
              sendPiCommand(target, { type: "set_session_name", name: args }, "/name");
              break;

            case "state":
            case "session":
              sendPiCommand(target, { type: "get_state" }, `/${name}`);
              break;

            case "stats":
              sendPiCommand(target, { type: "get_session_stats" }, "/stats");
              break;

            case "messages":
              sendPiCommand(target, { type: "get_messages" }, "/messages");
              break;

            case "model": {
              const modelArg = args.trim();
              if (!modelArg) {
                sendPiCommand(target, { type: "get_available_models" }, "/model");
                break;
              }
              if (["next", "cycle"].includes(modelArg.toLowerCase())) {
                sendPiCommand(target, { type: "cycle_model" }, "/model next");
                break;
              }
              const modelRef = parseModelRef(modelArg);
              if (!modelRef) {
                addChatMessage(target, "assistant", "Usage: `/model`, `/model next`, `/model 35b`, `/model dense`, or `/model provider/model-id`");
                break;
              }
              const configuredModel = findModelByProviderId(modelRef.provider, modelRef.modelId);
              if (!configuredModel) {
                addChatMessage(target, "assistant", `Unknown model \`${modelArg}\`.`);
                break;
              }
              await switchSessionToModel(target, configuredModel.id);
              attachSession(ws, target);
              sendSessionMessages(ws, target);
              broadcastAll(JSON.stringify({
                type: "session_model_changed",
                sessionId: target.id,
                modelId: target.modelId,
                modelLabel: target.modelLabel,
                modelProvider: resolveModel(target.modelId).provider,
              }));
              addChatMessage(target, "assistant", `This chat is now using \`${target.modelLabel}\`.`);
              break;
            }

            case "thinking": {
              const level = args.trim().toLowerCase();
              if (!level || level === "next" || level === "cycle") {
                sendPiCommand(target, { type: "cycle_thinking_level" }, "/thinking");
                break;
              }
              if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(level)) {
                addChatMessage(target, "assistant", "Usage: `/thinking`, `/thinking low`, `/thinking medium`, `/thinking high`, or `/thinking xhigh`");
                break;
              }
              sendPiCommand(target, { type: "set_thinking_level", level }, `/thinking ${level}`);
              break;
            }

            case "compact":
              sendPiCommand(target, {
                type: "compact",
                ...(args ? { customInstructions: args } : {}),
              }, args ? `/compact ${args}` : "/compact");
              break;

            case "reset-context":
            case "clear-context":
              target = hardResetSessionContext(target, args.trim());
              attachSession(ws, target);
              addChatMessage(
                target,
                "assistant",
                "Context reset for this chat. I kept only a small slice of the most recent conversation for Pi and left the visible chat history intact.",
              );
              break;

            case "auto-compact":
            case "autocompact": {
              const enabled = parseEnabledArg(args);
              if (enabled === null) {
                addChatMessage(target, "assistant", "Usage: `/auto-compact on` or `/auto-compact off`");
                break;
              }
              sendPiCommand(target, { type: "set_auto_compaction", enabled }, `/${name} ${enabled ? "on" : "off"}`);
              break;
            }

            case "auto-retry":
            case "autoretry": {
              const enabled = parseEnabledArg(args);
              if (enabled === null) {
                addChatMessage(target, "assistant", "Usage: `/auto-retry on` or `/auto-retry off`");
                break;
              }
              sendPiCommand(target, { type: "set_auto_retry", enabled }, `/${name} ${enabled ? "on" : "off"}`);
              break;
            }

            case "bash":
              if (!args) {
                addChatMessage(target, "assistant", "Usage: `/bash <command>`");
                break;
              }
              sendPiCommand(target, { type: "bash", command: args }, "/bash");
              break;

            case "abort-bash":
            case "abortbash":
              sendPiCommand(target, { type: "abort_bash" }, "/abort-bash");
              break;

            case "abort-retry":
            case "abortretry":
              sendPiCommand(target, { type: "abort_retry" }, "/abort-retry");
              break;

            case "export":
            case "export-html":
              sendPiCommand(target, {
                type: "export_html",
                ...(args ? { outputPath: args } : {}),
              }, args ? `/export ${args}` : "/export");
              break;

            case "last":
              sendPiCommand(target, { type: "get_last_assistant_text" }, "/last");
              break;

            case "steer":
              if (!args) {
                addChatMessage(target, "assistant", "Usage: `/steer <message>`");
                break;
              }
              sendPiCommand(target, { type: "steer", message: args }, "/steer");
              break;

            case "followup":
            case "follow-up":
              if (!args) {
                addChatMessage(target, "assistant", "Usage: `/followup <message>`");
                break;
              }
              sendPiCommand(target, { type: "follow_up", message: args }, "/followup");
              break;

            default:
              forwardSlashPrompt(target, text, msg.streamingBehavior, attachments.images);
              break;
          }
          break;
        }

        case "set_session_model": {
          const target = sessions.get(sessionId);
          if (!target) {
            console.error(`[WS] Session ${sessionId} not found! Available: ${Array.from(sessions.keys()).join(", ")}`);
            ws.send(JSON.stringify({ type: "error", data: `Session ${sessionId} not found` }));
            break;
          }
          const requestedModel = resolveModel(typeof msg.modelId === "string" ? msg.modelId : undefined);
          if (typeof msg.modelId !== "string" || requestedModel.id !== msg.modelId) {
            ws.send(JSON.stringify({ type: "error", data: `Unknown model ${msg.modelId}` }));
            break;
          }
          if (target.activeRun || target.activeAssistantId) {
            ws.send(JSON.stringify({
              type: "error",
              data: "The model cannot be changed while this chat is responding.",
            }));
            break;
          }

          await switchSessionToModel(target, requestedModel.id);
          sendSessionMessages(ws, target);
          broadcastAll(JSON.stringify({
            type: "session_model_changed",
            sessionId: target.id,
            modelId: target.modelId,
            modelLabel: target.modelLabel,
            modelProvider: resolveModel(target.modelId).provider,
          }));
          break;
        }

        case "set_session_profile": {
          const target = sessions.get(sessionId);
          if (!target) {
            ws.send(JSON.stringify({ type: "error", data: `Session ${sessionId} not found` }));
            break;
          }
          const profileId = typeof msg.agentProfileId === "string" ? msg.agentProfileId : "";
          const profile = agentProfiles.find((candidate) => candidate.id === profileId);
          if (!profile) {
            ws.send(JSON.stringify({ type: "error", data: `Unknown agent profile ${profileId}` }));
            break;
          }
          if (target.activeRun || target.activeAssistantId) {
            ws.send(JSON.stringify({
              type: "error",
              data: "The agent profile cannot be changed while this chat is responding.",
            }));
            break;
          }

          const selectedModel = resolveModel(profile.modelId);
          target.agentProfileId = profile.id;
          target.modelId = selectedModel.id;
          target.modelLabel = selectedModel.label;
          restartSessionProcess(target);
          attachSession(ws, target);
          persistSessionsSoon();
          broadcastAll(JSON.stringify({
            type: "session_profile_changed",
            sessionId: target.id,
            agentProfileId: profile.id,
            agentProfileName: profile.name,
            modelId: target.modelId,
            modelLabel: target.modelLabel,
            modelProvider: resolveModel(target.modelId).provider,
          }));
          sendSessionMessages(ws, target);
          break;
        }

        case "abort": {
          let target = sessions.get(sessionId);
          if (target) {
            abortSession(target);
          }
          break;
        }

        case "new_session": {
          let newSession = Boolean(msg.isQuick) ? getQuickSession() : undefined;
          const reusedQuickSession = Boolean(newSession && msg.isQuick);
          if (!newSession) {
            newSession = createSession(msg.name || "New Chat", undefined, msg.modelId as string | undefined, {
              projectId: typeof msg.projectId === "string" ? msg.projectId : DEFAULT_PROJECT_ID,
              agentProfileId: typeof msg.agentProfileId === "string" ? msg.agentProfileId : undefined,
              isQuick: Boolean(msg.isQuick),
            });
          } else if (!isProcessLive(newSession)) {
            newSession = restartSessionProcess(newSession);
          }
          attachSession(ws, newSession);
          setActiveUiSession(newSession.id);
          ws.send(JSON.stringify({
            type: reusedQuickSession ? "session_switched" : "session_created",
            sessionId: newSession.id,
            projectId: newSession.projectId,
            modelId: newSession.modelId,
            modelLabel: newSession.modelLabel,
            modelProvider: resolveModel(newSession.modelId).provider,
            agentProfileId: newSession.agentProfileId,
            agentProfileName: newSession.agentProfileId ? getAgentProfile(newSession.agentProfileId).name : undefined,
            isQuick: Boolean(newSession.isQuick),
          }));
          sendSessionMessages(ws, newSession);
          // Also broadcast to others so they know about the new session
          broadcastAll(JSON.stringify({ type: "session_list", sessions: sessionList() }));
          break;
        }

        case "create_project": {
          const name = typeof msg.name === "string" ? msg.name.trim() : "";
          if (!name) {
            ws.send(JSON.stringify({ type: "error", data: "Project name required" }));
            break;
          }
          const project: Project = { id: generateProjectId(), name, createdAt: Date.now() };
          projects.set(project.id, project);
          persistSessionsSoon();
          broadcastProjectState();
          break;
        }

        case "save_agent_profile": {
          const incoming = msg.profile;
          const id = typeof incoming?.id === "string" && incoming.id ? incoming.id : generateAgentProfileId();
          const existing = agentProfiles.find((profile) => profile.id === id);
          const normalized = normalizeAgentProfile({ ...incoming, id }, existing);
          if (!normalized) {
            ws.send(JSON.stringify({ type: "error", data: "Agent profile could not be saved." }));
            break;
          }
          const index = agentProfiles.findIndex((profile) => profile.id === normalized.id);
          if (index >= 0) agentProfiles[index] = normalized;
          else agentProfiles.push(normalized);
          saveAgentProfiles();
          broadcastAgentProfiles();
          break;
        }

        case "delete_agent_profile": {
          const profileId = typeof msg.profileId === "string" ? msg.profileId : "";
          if (!profileId || agentProfiles.length <= 1) {
            ws.send(JSON.stringify({ type: "error", data: "At least one agent profile must remain." }));
            break;
          }
          const nextProfiles = agentProfiles.filter((profile) => profile.id !== profileId);
          if (nextProfiles.length !== agentProfiles.length) {
            agentProfiles = nextProfiles;
            saveAgentProfiles();
            broadcastAgentProfiles();
          }
          break;
        }

        case "rename_project": {
          const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
          const name = typeof msg.name === "string" ? msg.name.trim() : "";
          const project = projects.get(projectId);
          if (project && projectId !== DEFAULT_PROJECT_ID && name) {
            project.name = name;
            persistSessionsSoon();
            broadcastProjectState();
          }
          break;
        }

        case "delete_project": {
          const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
          if (projectId && projectId !== DEFAULT_PROJECT_ID && projects.delete(projectId)) {
            for (const session of sessions.values()) {
              if (session.projectId === projectId) session.projectId = DEFAULT_PROJECT_ID;
            }
            persistSessionsSoon();
            broadcastProjectState();
          }
          break;
        }

        case "move_session": {
          const target = sessions.get(sessionId);
          const projectId = typeof msg.projectId === "string" && projects.has(msg.projectId) ? msg.projectId : DEFAULT_PROJECT_ID;
          if (target) {
            target.projectId = projectId;
            target.isQuick = false;
            persistSessionsSoon();
            broadcastAll(JSON.stringify({ type: "session_list", sessions: sessionList() }));
          }
          break;
        }

        case "switch_session": {
          let target = sessions.get(msg.targetSessionId as string);
          if (target) {
            if (!isProcessLive(target)) target = restartSessionProcess(target);
            attachSession(ws, target);
            setActiveUiSession(target.id);
            ws.send(JSON.stringify({ type: "session_switched", sessionId: target.id }));
            sendSessionMessages(ws, target);
          } else {
            ws.send(JSON.stringify({ type: "error", data: "Session not found" }));
          }
          break;
        }

        case "delete_session": {
          const toDelete = sessions.get(msg.sessionId as string);
          if (toDelete) {
            deletedSessions.add(toDelete.id);
            terminateSessionProcess(toDelete);
            sessions.delete(toDelete.id);
            if (uiState.activeSessionId === toDelete.id) uiState.activeSessionId = undefined;
            sessionOwners.delete(toDelete.id);
            sessionOutputBuffers.delete(toDelete.id);
            clearLiveMessageBroadcast(toDelete.id);
            const abortTimer = pendingAbortTimers.get(toDelete.id);
            if (abortTimer) clearTimeout(abortTimer);
            pendingAbortTimers.delete(toDelete.id);
            persistSessionsSoon();
            broadcastAll(JSON.stringify({ type: "session_deleted", sessionId: toDelete.id }));
            broadcastAll(JSON.stringify({ type: "session_list", sessions: sessionList() }));
            broadcastUiState();
          }
          break;
        }

        case "update_ui_state": {
          if (typeof msg.activeSessionId === "string" && sessions.has(msg.activeSessionId)) {
            uiState.activeSessionId = msg.activeSessionId;
          } else if (msg.activeSessionId === null) {
            uiState.activeSessionId = undefined;
          }
          if (Array.isArray(msg.collapsedProjectIds)) {
            uiState.collapsedProjectIds = msg.collapsedProjectIds.filter((id: unknown): id is string => typeof id === "string");
          }
          persistSessionsSoon();
          broadcastUiState();
          break;
        }

        case "rename_session": {
          const target = sessions.get(sessionId);
          const name = typeof msg.name === "string" ? msg.name.trim() : "";
          if (target && name) {
            target.name = name;
            persistSessionsSoon();
            broadcastAll(JSON.stringify({ type: "session_list", sessions: sessionList() }));
          }
          break;
        }

        case "get_state":
        case "get_messages":
        case "get_session_stats":
        case "compact": {
          const target = sessions.get(sessionId);
          if (target) writePiCommand(target, msg);
          break;
        }

        case "refresh_slash_commands": {
          let target = sessions.get(sessionId);
          if (!target) break;
          if (!isProcessLive(target)) {
            target = restartSessionProcess(target);
            attachSession(ws, target);
          }
          sendSlashCommands(ws, target);
          break;
        }

        default:
          console.log("[WS] Forwarding:", cmdType);
          const target = sessions.get(sessionId);
          if (target) writePiCommand(target, msg);
      }
    } catch (err) {
      console.error("[WS] Parse error:", err);
    }
  });

  ws.on("close", () => {
    console.log("[WS] Client disconnected");
    for (const [sid, ownerWs] of sessionOwners.entries()) {
      if (ownerWs === ws) {
        sessionOwners.delete(sid);
      }
    }
  });
});

// ── Start ───────────────────────────────────────────────────────────

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Server] π Agent Web → http://0.0.0.0:${PORT}`);
});

process.on("SIGINT", () => {
  console.log("\n[Server] Shutting down...");
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  savePersistedSessions();
  sessions.forEach((s) => terminateSessionProcess(s));
  wss.close();
  server.close(() => process.exit(0));
});
