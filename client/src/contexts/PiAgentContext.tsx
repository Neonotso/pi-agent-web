import { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { ActiveActivity, ChatMessage, ComposerAttachment, ModelRuntimeStatus, SlashCommand } from '../types';

export interface Session {
  id: string;
  name: string;
  createdAt: number;
  projectId?: string;
  modelId?: string;
  modelLabel?: string;
  modelProvider?: string;
  agentProfileId?: string;
  agentProfileName?: string;
  isBusy?: boolean;
  isQuick?: boolean;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
}

export interface ModelOption {
  id: string;
  label: string;
  provider?: string;
  model: string;
  description?: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  modelId: string;
  extensionIds: string[];
  skillIds: string[];
  instructions?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentCapability {
  id: string;
  label: string;
  path: string;
}

interface PiAgentContextValue {
  isConnected: boolean;
  hasReadySession: boolean;
  sessions: Session[];
  projects: Project[];
  defaultProjectId: string;
  activeSessionId: string | null;
  activeSession: Session | null;
  collapsedProjectIds: Set<string>;
  unreadSessionIds: Set<string>;
  models: ModelOption[];
  agentProfiles: AgentProfile[];
  agentExtensions: AgentCapability[];
  agentSkills: AgentCapability[];
  modelStatus: ModelRuntimeStatus | null;
  activeSessionBusy: boolean;
  slashCommands: SlashCommand[];
  refreshSlashCommands: () => void;
  selectedModelId: string;
  setSelectedModelId: (id: string) => void;
  selectedAgentProfileId: string;
  setSelectedAgentProfileId: (id: string) => void;
  switchSessionModel: (sessionId: string, modelId: string) => void;
  switchSessionProfile: (sessionId: string, agentProfileId: string) => void;
  saveAgentProfile: (profile: Partial<AgentProfile> & { id?: string }) => void;
  deleteAgentProfile: (id: string) => void;
  messages: ChatMessage[];  // Active session's messages
  activeActivity: ActiveActivity | null;
  sendMessage: (text: string, options?: { streamingBehavior?: 'steer' | 'followUp'; attachments?: ComposerAttachment[] }) => void;
  abort: () => void;
  createSession: (name?: string, projectId?: string, options?: { isQuick?: boolean; agentProfileId?: string }) => void;
  switchSession: (id: string) => void;
  setCollapsedProjectIds: (ids: Set<string>) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, name: string) => void;
  createProject: (name: string) => void;
  renameProject: (id: string, name: string) => void;
  deleteProject: (id: string) => void;
  moveSession: (sessionId: string, projectId: string) => void;
}

const PiAgentContext = createContext<PiAgentContextValue | null>(null);

export function usePiAgent(): PiAgentContextValue {
  const ctx = useContext(PiAgentContext);
  if (!ctx) throw new Error('usePiAgent must be used within PiAgentProvider');
  return ctx;
}

const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = import.meta.env.DEV
  ? `${WS_PROTOCOL}//${window.location.hostname}:3001`
  : `${WS_PROTOCOL}//${window.location.host}/ws`;
const DEFAULT_MODEL_ID = 'qwen-35b-mtp';
const DEFAULT_PROJECT_ID = 'project-inbox';
const DEFAULT_PROJECT: Project = { id: DEFAULT_PROJECT_ID, name: 'Inbox', createdAt: 0 };
const MAX_VISIBLE_MESSAGES = 160;

function capMessages(messages: ChatMessage[]) {
  return messages.slice(-MAX_VISIBLE_MESSAGES);
}

function contentText(part: any): string {
  if (!part || typeof part !== 'object') return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  if (typeof part.delta === 'string') return part.delta;
  return '';
}

function contentThinking(part: any): string {
  if (!part || typeof part !== 'object') return '';
  if (typeof part.thinking === 'string') return part.thinking;
  if (typeof part.reasoning === 'string') return part.reasoning;
  if (typeof part.reasoningContent === 'string') return part.reasoningContent;
  if (typeof part.reasoning_content === 'string') return part.reasoning_content;
  if (typeof part.thinkingContent === 'string') return part.thinkingContent;
  if (typeof part.thinking_content === 'string') return part.thinking_content;
  if (typeof part.summary === 'string') return part.summary;
  if (typeof part.text === 'string' && /thinking|reasoning/i.test(String(part.type || ''))) return part.text;
  if (typeof part.delta === 'string' && /thinking|reasoning/i.test(String(part.type || ''))) return part.delta;
  return '';
}

function extractAssistantContent(message: any): { text: string; thinking: string } {
  const content = message?.content;
  if (typeof content === 'string') return { text: content, thinking: '' };
  if (!Array.isArray(content)) return { text: '', thinking: '' };

  let text = '';
  let thinking = '';
  for (const part of content) {
    const type = String(part?.type || '');
    if (/thinking|reasoning/i.test(type)) thinking += contentThinking(part);
    else if (type === 'text' || typeof part?.text === 'string') text += contentText(part);
  }
  return { text, thinking };
}

function extractAssistantDelta(assistantMessageEvent: any): { text: string; thinking: string } {
  const type = String(assistantMessageEvent?.type || '');
  const delta = typeof assistantMessageEvent?.delta === 'string' ? assistantMessageEvent.delta : '';
  if (/tool[_-]?call|toolcall/i.test(type) || assistantMessageEvent?.toolCall) return { text: '', thinking: '' };
  if (/thinking|reasoning/i.test(type)) return { text: '', thinking: delta };
  if (type === 'text_delta') return { text: delta, thinking: '' };

  const snapshot = extractAssistantContent({ content: assistantMessageEvent?.partial?.content });
  return {
    text: snapshot.text || contentText(assistantMessageEvent),
    thinking: snapshot.thinking || contentThinking(assistantMessageEvent),
  };
}

function assistantErrorMessage(message: any): string {
  const stopReason = String(message?.stopReason || '');
  const errorMessage = typeof message?.errorMessage === 'string' ? message.errorMessage.trim() : '';
  if (!errorMessage && stopReason !== 'error') return '';
  if (/Prompt has \d+ tokens.*configured context size is \d+ tokens/i.test(errorMessage)) {
    return [
      "Pi could not answer because this chat's model context is too large for the selected model.",
      '',
      errorMessage,
      '',
      'Run `/reset-context` in this chat to keep the chat name and recent visible history while dropping the old model context.',
    ].join('\n');
  }
  return `Pi could not answer this message: ${errorMessage || 'Unknown model error'}`;
}

function toolOutput(event: any): string {
  return Array.isArray(event.result?.content)
    ? event.result.content.map((part: any) => contentText(part)).filter(Boolean).join('\n')
    : '';
}

function toolDetail(toolCall: any): string | undefined {
  const args = toolCall?.arguments ?? toolCall?.args;
  if (!args) return undefined;

  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    if (typeof parsed?.command === 'string') return parsed.command;
    if (typeof parsed?.url === 'string') return parsed.url;
    if (typeof parsed?.query === 'string') return parsed.query;
    if (Array.isArray(parsed?.queries)) return parsed.queries.join(', ');
    return JSON.stringify(parsed);
  } catch {
    return typeof args === 'string' ? args : undefined;
  }
}

function activityLabel(toolName: string) {
  if (toolName === 'bash') return 'Running shell command';
  if (toolName === 'fetch_content') return 'Reading web page';
  if (toolName === 'web_search') return 'Searching the web';
  return `Running ${toolName}`;
}

function appendUnique(existing: string | undefined, addition: string) {
  if (!addition) return normalizeRepeatedText(existing || '');
  if (!existing) return normalizeRepeatedText(addition);

  const trimmedAddition = addition.trim();
  const trimmedExisting = existing.trim();

  if (addition.startsWith(existing)) return normalizeRepeatedText(addition);
  if (trimmedAddition.startsWith(trimmedExisting)) return normalizeRepeatedText(addition);

  if (trimmedAddition.length > 30) {
    if (trimmedExisting.includes(trimmedAddition)) return normalizeRepeatedText(existing);
    if (trimmedAddition.includes(trimmedExisting)) return normalizeRepeatedText(addition);
  }

  const maxOverlap = Math.min(existing.length, addition.length);
  for (let size = maxOverlap; size >= 2; size--) {
    if (existing.endsWith(addition.slice(0, size))) {
      return normalizeRepeatedText(`${existing}${addition.slice(size)}`);
    }
  }

  return normalizeRepeatedText(`${existing}${addition}`);
}

function normalizeRepeatedText(text: string): string {
  const paragraphs = text.split(/\n{2,}/);
  const deduped: string[] = [];

  for (const paragraph of paragraphs) {
    const current = canonicalParagraph(paragraph);
    const previous = canonicalParagraph(deduped[deduped.length - 1] || '');
    if (current && current === previous) continue;
    deduped.push(paragraph);
    collapseRepeatedSuffix(deduped);
  }

  return collapseRepeatedTextSuffix(deduped.join('\n\n'));
}

function canonicalParagraph(paragraph: string): string {
  return paragraph
    .trim()
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\|[\s:|.-]+\|/g, (match) => match.replace(/[-:]+/g, '-'))
    .replace(/-{3,}/g, '---')
    .toLowerCase();
}

function canonicalTextBlock(text: string): string {
  return text
    .trim()
    .replace(/\r/g, '')
    .replace(/\|[\s:|.-]+\|/g, (match) => match.replace(/[-:]+/g, '-'))
    .replace(/-{3,}/g, '---')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function collapseRepeatedTextSuffix(text: string): string {
  const trimmed = text.trimEnd();
  const trailing = text.slice(trimmed.length);
  const lines = trimmed.split('\n');
  for (let length = Math.floor(lines.length / 2); length >= 2; length -= 1) {
    const start = lines.length - length * 2;
    if (start < 0) continue;
    const first = lines.slice(start, start + length).join('\n');
    const second = lines.slice(start + length).join('\n');
    if (canonicalTextBlock(first) && canonicalTextBlock(first) === canonicalTextBlock(second)) {
      return `${lines.slice(0, start + length).join('\n')}${trailing}`;
    }
  }
  return text;
}

function collapseRepeatedSuffix(paragraphs: string[]) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let length = Math.floor(paragraphs.length / 2); length >= 1; length -= 1) {
      const start = paragraphs.length - length * 2;
      if (start < 0) continue;
      const first = paragraphs.slice(start, start + length).map(canonicalParagraph);
      const second = paragraphs.slice(start + length).map(canonicalParagraph);
      if (first.every((paragraph, index) => paragraph && paragraph === second[index])) {
        paragraphs.splice(start + length, length);
        changed = true;
        break;
      }
    }
  }
}

export function PiAgentProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<Project[]>([DEFAULT_PROJECT]);
  const [defaultProjectId, setDefaultProjectId] = useState(DEFAULT_PROJECT_ID);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [agentProfiles, setAgentProfiles] = useState<AgentProfile[]>([]);
  const [agentExtensions, setAgentExtensions] = useState<AgentCapability[]>([]);
  const [agentSkills, setAgentSkills] = useState<AgentCapability[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelRuntimeStatus | null>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [selectedModelId, setSelectedModelIdState] = useState(DEFAULT_MODEL_ID);
  const [selectedAgentProfileId, setSelectedAgentProfileIdState] = useState('agent-default');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [collapsedProjectIdsState, setCollapsedProjectIdsState] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<Map<string, ChatMessage[]>>(new Map());
  const [activities, setActivities] = useState<Map<string, ActiveActivity>>(new Map());
  const [busySessionIds, setBusySessionIds] = useState<Set<string>>(new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(new Set());
  const [hasReadySession, setHasReadySession] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Record<string, string>>({});  // sessionId → streaming text
  const idCounterRef = useRef(0);                          // For generating unique message IDs
  const activeSessionRef = useRef<string | null>(null);    // Ref for latest activeSessionId
  const reconnectAttemptsRef = useRef(0);                  // Reconnect backoff counter
  const messageCountsRef = useRef<Map<string, number>>(new Map());
  const sessionsRef = useRef<Session[]>([]);
  const deletingSessionIdsRef = useRef<Set<string>>(new Set());
  // Buffer messages sent before session is ready
  const messageBufferRef = useRef<Array<{ text: string; attachments?: ComposerAttachment[] }>>([]);

  // Keep ref in sync with state
  useEffect(() => {
    activeSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const setSessionsSynced = useCallback((updater: Session[] | ((prev: Session[]) => Session[])) => {
    setSessions(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      sessionsRef.current = next;
      return next;
    });
  }, []);

  const setSelectedModelId = useCallback((id: string) => {
    setSelectedModelIdState(id);
    safeLocalStorageSet('pi-web-selected-model', id);
  }, []);

  const setSelectedAgentProfileId = useCallback((id: string) => {
    setSelectedAgentProfileIdState(id);
    safeLocalStorageSet('pi-web-selected-agent-profile', id);
  }, []);

  const STORAGE_KEY_SESSIONS = 'pi-web-sessions';
  const STORAGE_KEY_PROJECTS = 'pi-web-projects';
  const STORAGE_KEY_MESSAGES = 'pi-web-messages';
  const STORAGE_KEY_ACTIVE = 'pi-web-active-session';

  function safeLocalStorageGet(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeLocalStorageSet(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch (error) {
      console.warn('[Context] Browser storage unavailable:', error);
    }
  }

  function safeLocalStorageRemove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.warn('[Context] Browser storage unavailable:', error);
    }
  }

  function clearLegacyClientCache() {
    try {
      localStorage.removeItem(STORAGE_KEY_MESSAGES);
      localStorage.removeItem(STORAGE_KEY_SESSIONS);
      localStorage.removeItem(STORAGE_KEY_PROJECTS);
    } catch (error) {
      console.warn('[Context] Failed to clear browser cache:', error);
    }
  }

  // The server is now the source of truth for sessions, projects, and messages.
  // Clear older browser-side snapshots because full tool output can exceed iOS storage.
  useEffect(() => {
    clearLegacyClientCache();
    const storedActive = safeLocalStorageGet(STORAGE_KEY_ACTIVE);
    if (storedActive) {
      setActiveSessionId(storedActive);
    }
  }, []);

  // Save active session ID
  useEffect(() => {
    if (activeSessionId) {
      safeLocalStorageSet(STORAGE_KEY_ACTIVE, activeSessionId);
    } else {
      safeLocalStorageRemove(STORAGE_KEY_ACTIVE);
    }
  }, [activeSessionId]);

  const replayingRef = useRef(false);  // Suppress pi_events during history replay

  const refreshSlashCommands = useCallback((sessionId = activeSessionRef.current) => {
    const ws = wsRef.current;
    if (!sessionId || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'refresh_slash_commands',
      sessionId,
    }));
  }, []);

  // Helpers
  const getActiveMessages = useCallback((msgs: Map<string, ChatMessage[]>, sid: string | null) => {
    return sid ? (msgs.get(sid) || []) : [];
  }, []);

  // Flush any buffered messages once session is ready
  const flushBufferedMessages = useCallback((sid: string) => {
    const buffered = messageBufferRef.current.splice(0);
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    for (const bufferedMessage of buffered) {
      const { text, attachments } = bufferedMessage;
      // Add user message to UI
      const userMsg: ChatMessage = {
        id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'user', content: text, timestamp: Date.now(),
      };
          setMessages(prev => {
            const next = new Map(prev);
            const msgs = next.get(sid) || [];
            next.set(sid, capMessages([...msgs, userMsg]));
            return next;
          });

      ws.send(JSON.stringify({
        type: text.trim().startsWith('/') ? 'slash_command' : 'prompt',
        sessionId: sid,
        message: text,
        modelId: selectedModelId,
        agentProfileId: selectedAgentProfileId,
        attachments,
      }));
    }
    console.log(`[Context] Flushed ${buffered.length} buffered messages to session ${sid}`);
  }, [selectedAgentProfileId, selectedModelId]);

  // Connect WebSocket with auto-reconnect
  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let isCleanup = false;

    const connect = () => {
      if (isCleanup) return;
      console.log('[Context] Connecting WebSocket...');
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[Context] WebSocket connected');
        setIsConnected(true);
        reconnectAttemptsRef.current = 0;
        setHasReadySession(Boolean(activeSessionRef.current));
      };
      ws.onclose = (event) => {
        console.log(`[Context] WebSocket closed (code ${event.code}, clean: ${event.wasClean})`);
        setIsConnected(false);
        // Auto-reconnect after a short delay (with backoff)
        if (!isCleanup) {
          reconnectAttemptsRef.current++;
          wsRef.current = null;
          const delay = Math.min(250 * 2 ** Math.max(0, reconnectAttemptsRef.current - 1), 2000);
          console.log(`[Context] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`);
          reconnectTimer = setTimeout(connect, delay);
        }
      };
      ws.onerror = (err) => {
        console.error('[Context] WebSocket error:', err);
      };
      ws.onmessage = (e) => {
        try { handleWs(JSON.parse(e.data)); } catch (err) { console.error('[Context] WS parse error:', err); }
      };
    };

    connect();

    return () => {
      isCleanup = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  const createSession = useCallback((name?: string, projectId?: string, options?: { isQuick?: boolean; agentProfileId?: string }) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const currentSessionId = activeSessionRef.current;
      const ownerProject = currentSessionId ? (sessionsRef.current.find(s => s.id === currentSessionId)?.projectId ?? defaultProjectId) : defaultProjectId;
      const agentProfileId = options?.agentProfileId || selectedAgentProfileId;
      const profile = agentProfiles.find((candidate) => candidate.id === agentProfileId);
      wsRef.current.send(JSON.stringify({
        type: 'new_session',
        name: name || (options?.isQuick ? 'Quick Chat' : 'New Chat'),
        modelId: profile?.modelId || selectedModelId,
        agentProfileId,
        projectId: projectId || ownerProject,
        isQuick: Boolean(options?.isQuick),
      }));
    }
  }, [agentProfiles, defaultProjectId, selectedAgentProfileId, selectedModelId]);

  const handleWs = useCallback((data: any) => {
    console.log('%c[PI-AGENT-v2]', 'color: #22c55e; font-weight: bold; font-size: 14px');
    console.log('[Context] WS event:', data.type, data.sessionId || '');
    switch (data.type) {
      case 'session_list':
        {
          const nextSessions = (data.sessions || [])
            .filter((session: Session) => !deletingSessionIdsRef.current.has(session.id))
            .map((session: Session) => ({
              ...session,
              projectId: session.projectId || defaultProjectId,
            }));
          setSessionsSynced(nextSessions);
          if (activeSessionRef.current && !nextSessions.some((session: Session) => session.id === activeSessionRef.current)) {
            setActiveSessionId(null);
            activeSessionRef.current = null;
            setHasReadySession(false);
          }
        }
        if (activeSessionRef.current && deletingSessionIdsRef.current.has(activeSessionRef.current)) {
          setActiveSessionId(null);
          activeSessionRef.current = null;
          setHasReadySession(false);
        }
        setBusySessionIds(prev => {
          const next = new Set(prev);
          for (const session of data.sessions || []) {
            if (!session?.id) continue;
            if (session.isBusy) next.add(session.id);
            else next.delete(session.id);
          }
          return next;
        });
        setActivities(prev => {
          const next = new Map(prev);
          for (const session of data.sessions || []) {
            if (session?.id && !session.isBusy) next.delete(session.id);
          }
          return next;
        });
        break;

      case 'projects':
        setDefaultProjectId(data.defaultProjectId || DEFAULT_PROJECT_ID);
        setProjects(ensureDefaultProject(data.projects || []));
        break;

      case 'models':
        setModels(data.models || []);
        {
          const modelList = Array.isArray(data.models) ? data.models : [];
          const savedModelId = safeLocalStorageGet('pi-web-selected-model');
          const nextModelId = savedModelId && modelList.some((model: ModelOption) => model.id === savedModelId)
            ? savedModelId
            : data.defaultModelId;
          if (nextModelId) {
            setSelectedModelId(nextModelId);
          }
        }
        break;

      case 'agent_profiles':
        {
          const profiles = Array.isArray(data.profiles) ? data.profiles : [];
          setAgentProfiles(profiles);
          const savedProfileId = safeLocalStorageGet('pi-web-selected-agent-profile');
          const nextProfileId = savedProfileId && profiles.some((profile: AgentProfile) => profile.id === savedProfileId)
            ? savedProfileId
            : profiles[0]?.id;
          if (nextProfileId) setSelectedAgentProfileId(nextProfileId);
        }
        setAgentExtensions(Array.isArray(data.extensions) ? data.extensions : []);
        setAgentSkills(Array.isArray(data.skills) ? data.skills : []);
        break;

      case 'connected':
        // This event is ONLY sent to the client that just connected (by server fix)
        if (data.sessionId) {
          console.log(`[Context] Session ready: ${data.sessionId}`);

          setSessionsSynced(prev => {
            if (prev.find(s => s.id === data.sessionId)) return prev;
            return [...prev, { id: data.sessionId, name: 'New Chat', projectId: defaultProjectId, createdAt: Date.now() }];
          });
          setMessages(prev => {
            const next = new Map(prev);
            if (!next.has(data.sessionId)) next.set(data.sessionId, []);
            return next;
          });
          setActiveSessionId(data.sessionId);
          setHasReadySession(true);
          refreshSlashCommands(data.sessionId);
          // Flush any messages buffered during connection
          flushBufferedMessages(data.sessionId);
        }
        break;

      case 'session_created':
        if (data.sessionId) {
          const selectedModel = models.find(model => model.id === selectedModelId);
          const session = {
            id: data.sessionId,
            name: data.isQuick ? 'Quick Chat' : 'New Chat',
            createdAt: Date.now(),
            projectId: data.projectId || defaultProjectId,
            modelId: data.modelId || selectedModelId,
            modelLabel: data.modelLabel || selectedModel?.label,
            modelProvider: data.modelProvider || selectedModel?.provider,
            agentProfileId: data.agentProfileId,
            agentProfileName: data.agentProfileName,
            isQuick: Boolean(data.isQuick),
          };
          deletingSessionIdsRef.current.delete(data.sessionId);
          setSessionsSynced(prev => prev.some(existing => existing.id === data.sessionId)
            ? prev.map(existing => existing.id === data.sessionId ? { ...existing, ...session } : existing)
            : [...prev, session]);
          setMessages(prev => {
            const next = new Map(prev);
            if (!next.has(data.sessionId)) next.set(data.sessionId, []);
            return next;
          });
          setActiveSessionId(data.sessionId);
          setHasReadySession(true);
          refreshSlashCommands(data.sessionId);
          flushBufferedMessages(data.sessionId);
        }
        break;

      case 'session_model_changed':
        if (data.sessionId && data.modelId) {
          setSessionsSynced(prev => prev.map(session => session.id === data.sessionId ? {
            ...session,
            modelId: data.modelId,
            modelLabel: data.modelLabel || session.modelLabel,
            modelProvider: data.modelProvider || session.modelProvider,
          } : session));
          if (data.sessionId === activeSessionRef.current) {
            setSelectedModelId(data.modelId);
          }
        }
        break;

      case 'session_profile_changed':
        if (data.sessionId && data.agentProfileId) {
          setSessionsSynced(prev => prev.map(session => session.id === data.sessionId ? {
            ...session,
            agentProfileId: data.agentProfileId,
            agentProfileName: data.agentProfileName || session.agentProfileName,
            modelId: data.modelId || session.modelId,
            modelLabel: data.modelLabel || session.modelLabel,
            modelProvider: data.modelProvider || session.modelProvider,
          } : session));
          if (data.sessionId === activeSessionRef.current) {
            setSelectedAgentProfileId(data.agentProfileId);
            if (data.modelId) setSelectedModelId(data.modelId);
          }
        }
        break;

      case 'session_switched':
        if (data.sessionId) {
          if (deletingSessionIdsRef.current.has(data.sessionId) || !sessionsRef.current.some(session => session.id === data.sessionId)) {
            break;
          }
          console.log('[Context] Switched to session:', data.sessionId);
          setActiveSessionId(data.sessionId);
          setHasReadySession(true);
          refreshSlashCommands(data.sessionId);
          flushBufferedMessages(data.sessionId);
        }
        break;

      case 'slash_commands': {
        const commands = Array.isArray(data.commands)
          ? data.commands
              .filter((command: any) => typeof command?.name === 'string' && command.name.trim())
              .map((command: any) => ({
                command: `/${command.name.replace(/^\/+/, '')}`,
                description: typeof command.description === 'string' ? command.description : 'Pi command',
                source: typeof command.source === 'string' ? command.source : undefined,
              }))
          : [];
        setSlashCommands(commands);
        break;
      }

      case 'model_status':
        setModelStatus(data.status || null);
        break;

      case 'ui_state': {
        const uiState = data.uiState || {};
        if (Array.isArray(uiState.collapsedProjectIds)) {
          setCollapsedProjectIdsState(new Set(uiState.collapsedProjectIds.filter((id: unknown) => typeof id === 'string')));
        }
        if (typeof uiState.activeSessionId === 'string' && uiState.activeSessionId !== activeSessionRef.current) {
          if (deletingSessionIdsRef.current.has(uiState.activeSessionId) || !sessionsRef.current.some(session => session.id === uiState.activeSessionId)) {
            break;
          }
          setActiveSessionId(uiState.activeSessionId);
          setHasReadySession(true);
          refreshSlashCommands(uiState.activeSessionId);
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'switch_session', targetSessionId: uiState.activeSessionId }));
          }
        } else if (
          typeof uiState.activeSessionId === 'string'
          && !deletingSessionIdsRef.current.has(uiState.activeSessionId)
          && sessionsRef.current.some(session => session.id === uiState.activeSessionId)
          && !messageCountsRef.current.has(uiState.activeSessionId)
        ) {
          setHasReadySession(true);
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'switch_session', targetSessionId: uiState.activeSessionId }));
          }
        }
        break;
      }

      case 'session_deleted': {
        const deletedId = data.sessionId;
        deletingSessionIdsRef.current.add(deletedId);
        const wasActive = activeSessionRef.current === deletedId;
        setSessionsSynced(prev => prev.filter(s => s.id !== deletedId));
        setMessages(prev => {
          const next = new Map(prev);
          next.delete(deletedId);
          pendingRef.current[deletedId] = '';
          messageCountsRef.current.delete(deletedId);
          return next;
        });
          setActivities(prev => {
            const next = new Map(prev);
            next.delete(deletedId);
            return next;
          });
          setBusySessionIds(prev => {
            const next = new Set(prev);
            next.delete(deletedId);
            return next;
          });
        setUnreadSessionIds(prev => {
          const next = new Set(prev);
          next.delete(deletedId);
          return next;
        });
        if (wasActive) {
          setActiveSessionId(null);
          activeSessionRef.current = null;
          setHasReadySession(false);
        }
        break;
      }

      case 'session_closed':
        if (data.sessionId) {
          deletingSessionIdsRef.current.add(data.sessionId);
          setSessionsSynced(prev => prev.filter(s => s.id !== data.sessionId));
          setMessages(prev => {
            const next = new Map(prev);
            next.delete(data.sessionId);
            pendingRef.current[data.sessionId] = '';
            messageCountsRef.current.delete(data.sessionId);
            return next;
          });
          setActivities(prev => {
            const next = new Map(prev);
            next.delete(data.sessionId);
            return next;
          });
          setBusySessionIds(prev => {
            const next = new Set(prev);
            next.delete(data.sessionId);
            return next;
          });
          setUnreadSessionIds(prev => {
            const next = new Set(prev);
            next.delete(data.sessionId);
            return next;
          });
          setActiveSessionId(prev => {
            if (prev !== data.sessionId) return prev;
            // Will be set when sessions update
            return null;
          });
        }
        break;

      case 'pi_event': {
        if (!data.raw || typeof data.raw !== 'string') break;
        try {
          handlePiEvent(JSON.parse(data.raw), data.sessionId);
        } catch {
          // Ignore non-JSON Pi output in the visible chat stream.
        }
        break;
      }

      case 'history_restored':
        replayingRef.current = false;
        console.log('[Context] History replay complete');
        break;

      case 'error':
        console.error('[Context] Server error:', data.data);
        break;

      case 'messages':
        // Update messages for the session that sent this
        if (data.messages && data.sessionId) {
          const previousCount = messageCountsRef.current.get(data.sessionId) || 0;
          const chatMessages: ChatMessage[] = data.messages
            .filter((m: any) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool' || m.role === 'error')
            .map((m: any, i: number) => ({
              id: m.id || `m-${i}`,
              role: m.role,
              content: typeof m.content === 'string' ? m.content : m.content?.[0]?.text || '',
              thinking: typeof m.thinking === 'string' ? m.thinking : undefined,
              toolName: m.toolName,
              toolCallId: m.toolCallId,
              detail: m.detail,
              output: m.output,
              speedTokensPerSecond: typeof m.speedTokensPerSecond === 'number' ? m.speedTokensPerSecond : undefined,
              modelTokensPerSecond: typeof m.modelTokensPerSecond === 'number' ? m.modelTokensPerSecond : undefined,
              tokenEstimate: typeof m.tokenEstimate === 'number' ? m.tokenEstimate : undefined,
              isError: m.isError,
              isStreaming: m.isStreaming,
              isThinkingStreaming: m.isThinkingStreaming,
              stopped: Boolean(m.stopped),
              timestamp: m.timestamp || Date.now(),
            }));
          setMessages(prev => {
            const next = new Map(prev);
            next.set(data.sessionId, capMessages(chatMessages));
            return next;
          });
          if (typeof data.isBusy === 'boolean') {
            setBusySessionIds(prev => {
              const next = new Set(prev);
              if (data.isBusy) next.add(data.sessionId);
              else next.delete(data.sessionId);
              return next;
            });
            if (!data.isBusy) {
              setActivities(prev => {
                const next = new Map(prev);
                next.delete(data.sessionId);
                return next;
              });
            }
          }
          messageCountsRef.current.set(data.sessionId, chatMessages.length);
          const lastMessage = chatMessages[chatMessages.length - 1];
          if (
            data.sessionId !== activeSessionRef.current
            && chatMessages.length > previousCount
            && lastMessage
            && lastMessage.role !== 'user'
          ) {
            setUnreadSessionIds(prev => {
              const next = new Set(prev);
              next.add(data.sessionId);
              return next;
            });
          }
        }
        break;
    }
  }, [defaultProjectId, flushBufferedMessages, models, selectedModelId, setSelectedModelId, createSession, refreshSlashCommands]);

  const handlePiEvent = useCallback((event: any, eventSessionId?: string) => {
    // Route to the session that sent this event, or fall back to active
    const targetSessionId = eventSessionId || activeSessionRef.current;
    if (!targetSessionId) return;

    switch (event.type) {
      case 'agent_start': {
        pendingRef.current[targetSessionId] = '';
        setBusySessionIds(prev => {
          const next = new Set(prev);
          next.add(targetSessionId);
          return next;
        });
        idCounterRef.current++;
        setMessages(prev => {
          const next = new Map(prev);
          const existing = next.get(targetSessionId) || [];
          if (existing.some(m => m.role === 'assistant' && m.isStreaming)) {
            next.set(targetSessionId, existing);
            return next;
          }
          const msg: ChatMessage = {
            id: `s-${idCounterRef.current}`,
            role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true,
          };
          next.set(targetSessionId, capMessages([...existing, msg]));
          return next;
        });
        break;
      }

      case 'message_update': {
        const delta = event.assistantMessageEvent;
        if (delta?.type === 'toolcall_end') {
          const toolCall = delta.toolCall || {};
          const toolName = String(toolCall.name || 'tool');
          setBusySessionIds(prev => {
            const next = new Set(prev);
            next.add(targetSessionId);
            return next;
          });
          setActivities(prev => {
            const next = new Map(prev);
            next.set(targetSessionId, {
              toolCallId: toolCall.id,
              toolName,
              label: activityLabel(toolName),
              detail: toolDetail(toolCall),
              state: 'queued',
              updatedAt: Date.now(),
            });
            return next;
          });
        }

        const { text, thinking } = extractAssistantDelta(event.assistantMessageEvent);
        if (!text && !thinking) return;
        setMessages(prev => {
          const next = new Map(prev);
          const msgs = next.get(targetSessionId) || [];
          const activeIndex = msgs.findIndex(m => m.role === 'assistant' && m.isStreaming);
          if (activeIndex === -1) {
            idCounterRef.current++;
            next.set(targetSessionId, capMessages([...msgs, {
              id: `s-${idCounterRef.current}`,
              role: 'assistant',
              content: text,
              thinking: thinking || undefined,
              timestamp: Date.now(),
              isStreaming: true,
              isThinkingStreaming: Boolean(thinking),
            }]));
            return next;
          }
          const updated = [...msgs];
          const active = updated[activeIndex];
          updated[activeIndex] = {
            ...active,
            content: appendUnique(active.content, text),
            thinking: appendUnique(active.thinking, thinking) || undefined,
            isThinkingStreaming: Boolean(thinking) || active.isThinkingStreaming,
            timestamp: Date.now(),
          };
          next.set(targetSessionId, capMessages(updated));
          return next;
        });
        break;
      }

      case 'tool_execution_start': {
        const toolName = String(event.toolName || 'tool');
        setBusySessionIds(prev => {
          const next = new Set(prev);
          next.add(targetSessionId);
          return next;
        });
        setActivities(prev => {
          const existing = prev.get(targetSessionId);
          const next = new Map(prev);
          next.set(targetSessionId, {
            toolCallId: event.toolCallId || existing?.toolCallId,
            toolName,
            label: activityLabel(toolName),
            detail: existing?.detail,
            state: 'running',
            startedAt: Date.now(),
            updatedAt: Date.now(),
          });
          return next;
        });
        break;
      }

      case 'message': {
        if (event.message?.role !== 'assistant') return;
        const { text, thinking } = extractAssistantContent(event.message);
        const errorText = assistantErrorMessage(event.message);
        if (!text && !thinking && !errorText) return;
        setMessages(prev => {
          const next = new Map(prev);
          const msgs = next.get(targetSessionId) || [];
          const activeIndex = msgs.findIndex(m => m.role === 'assistant' && m.isStreaming);
          if (errorText) {
            setBusySessionIds(prev => {
              const next = new Set(prev);
              next.delete(targetSessionId);
              return next;
            });
            if (activeIndex === -1) {
              idCounterRef.current++;
              next.set(targetSessionId, capMessages([...msgs, {
                id: `e-${idCounterRef.current}`,
                role: 'error',
                content: errorText,
                timestamp: Date.now(),
              }]));
              return next;
            }
            const updated = [...msgs];
            updated[activeIndex] = {
              ...updated[activeIndex],
              role: 'error',
              content: errorText,
              isStreaming: false,
              isThinkingStreaming: false,
              timestamp: Date.now(),
            };
            next.set(targetSessionId, capMessages(updated));
            return next;
          }
          if (activeIndex === -1) {
            idCounterRef.current++;
            next.set(targetSessionId, capMessages([...msgs, {
              id: `s-${idCounterRef.current}`,
              role: 'assistant',
              content: text,
              thinking: thinking || undefined,
              timestamp: Date.now(),
              isStreaming: true,
              isThinkingStreaming: Boolean(thinking),
            }]));
            return next;
          }
          const updated = [...msgs];
          const active = updated[activeIndex];
          updated[activeIndex] = {
            ...active,
            content: appendUnique(active.content, text),
            thinking: appendUnique(active.thinking, thinking) || undefined,
            isThinkingStreaming: Boolean(thinking) || active.isThinkingStreaming,
            timestamp: Date.now(),
          };
          next.set(targetSessionId, capMessages(updated));
          return next;
        });
        break;
      }

      case 'tool_execution_end': {
        const txt = toolOutput(event);
        let finishedActivity: ActiveActivity | undefined;
        setActivities(prev => {
          finishedActivity = prev.get(targetSessionId);
          const next = new Map(prev);
          next.delete(targetSessionId);
          return next;
        });
        setMessages(prev => {
          const next = new Map(prev);
          const msgs = next.get(targetSessionId) || [];
          const withoutActiveStreaming = msgs.map(m =>
            m.role === 'assistant' && m.isStreaming
              ? { ...m, isStreaming: false, isThinkingStreaming: false }
              : m
          );
          next.set(targetSessionId, capMessages([...withoutActiveStreaming, {
            id: `tool-${event.toolCallId}-${Date.now()}`,
            role: 'tool', content: event.toolName || 'tool',
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            detail: finishedActivity?.detail,
            output: txt,
            timestamp: Date.now(),
          }]));
          return next;
        });
        break;
      }

      case 'agent_end':
        setBusySessionIds(prev => {
          const next = new Set(prev);
          next.delete(targetSessionId);
          return next;
        });
        setActivities(prev => {
          const next = new Map(prev);
          next.delete(targetSessionId);
          return next;
        });
        setMessages(prev => {
          const next = new Map(prev);
          const msgs = next.get(targetSessionId) || [];
          next.set(targetSessionId, capMessages(msgs.map(m =>
            m.role === 'assistant' && m.isStreaming ? { ...m, isStreaming: false } : m
          )));
          return next;
        });
        break;
    }
  }, []);

  const activeSession = useMemo(() => {
    return sessions.find(session => session.id === activeSessionId) || null;
  }, [activeSessionId, sessions]);

  const sendMessage = useCallback((text: string, options?: { streamingBehavior?: 'steer' | 'followUp'; attachments?: ComposerAttachment[] }) => {
    console.log('[Context] sendMessage called, activeSessionId:', activeSessionId, 'hasReadySession:', hasReadySession);
    if (!activeSessionId) {
      console.log('[Context] No active session, creating quick chat for:', text.slice(0, 40));
      messageBufferRef.current.push({ text, attachments: options?.attachments });
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'new_session',
          name: 'Quick Chat',
          modelId: selectedModelId,
          agentProfileId: selectedAgentProfileId,
          projectId: defaultProjectId,
          isQuick: true,
        }));
      }
      return;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      attachments: options?.attachments?.map(attachment => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        dataUrl: attachment.mimeType.startsWith('image/')
          ? `data:${attachment.mimeType};base64,${attachment.data}`
          : undefined,
      })),
      timestamp: Date.now(),
    };
    setMessages(prev => {
      const next = new Map(prev);
      const msgs = next.get(activeSessionId!) || [];
      next.set(activeSessionId!, capMessages([...msgs, userMsg]));
      return next;
    });

    ws.send(JSON.stringify({
      type: text.trim().startsWith('/') ? 'slash_command' : 'prompt',
      sessionId: activeSessionId,
      message: text,
      modelId: selectedModelId,
      agentProfileId: activeSession?.agentProfileId || selectedAgentProfileId,
      streamingBehavior: options?.streamingBehavior,
      attachments: options?.attachments,
    }));
  }, [activeSession?.agentProfileId, activeSessionId, defaultProjectId, hasReadySession, selectedAgentProfileId, selectedModelId]);

  const abort = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && activeSessionId) {
      ws.send(JSON.stringify({ type: 'abort', sessionId: activeSessionId }));
    }
  }, [activeSessionId]);

  useEffect(() => {
    if (activeSession?.modelId && activeSession.modelId !== selectedModelId) {
      setSelectedModelId(activeSession.modelId);
    }
  }, [activeSession?.modelId, selectedModelId, setSelectedModelId]);

  useEffect(() => {
    if (activeSession?.agentProfileId && activeSession.agentProfileId !== selectedAgentProfileId) {
      setSelectedAgentProfileId(activeSession.agentProfileId);
    }
  }, [activeSession?.agentProfileId, selectedAgentProfileId, setSelectedAgentProfileId]);

  const activeActivity = useMemo(() => {
    return activeSessionId ? activities.get(activeSessionId) || null : null;
  }, [activeSessionId, activities]);

  const activeSessionBusy = useMemo(() => {
    return Boolean(activeSessionId && busySessionIds.has(activeSessionId));
  }, [activeSessionId, busySessionIds]);

  const switchSession = useCallback((id: string) => {
    if (deletingSessionIdsRef.current.has(id) || !sessionsRef.current.some(session => session.id === id)) return;
    setActiveSessionId(id);
    setHasReadySession(true);
    setUnreadSessionIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'switch_session', targetSessionId: id }));
    }
  }, []);

  const publishUiState = useCallback((patch: { activeSessionId?: string | null; collapsedProjectIds?: Set<string> }) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'update_ui_state',
      ...(patch.activeSessionId !== undefined ? { activeSessionId: patch.activeSessionId } : {}),
      ...(patch.collapsedProjectIds ? { collapsedProjectIds: Array.from(patch.collapsedProjectIds) } : {}),
    }));
  }, []);

  const setCollapsedProjectIds = useCallback((ids: Set<string>) => {
    setCollapsedProjectIdsState(new Set(ids));
    publishUiState({ collapsedProjectIds: ids });
  }, [publishUiState]);

  const deleteSession = useCallback((id: string) => {
    if (deletingSessionIdsRef.current.has(id)) return;
    deletingSessionIdsRef.current.add(id);
    const wasActive = activeSessionRef.current === id;
    setSessionsSynced(prev => prev.filter(session => session.id !== id));
    setMessages(prev => {
      const next = new Map(prev);
      next.delete(id);
      pendingRef.current[id] = '';
      messageCountsRef.current.delete(id);
      return next;
    });
    setActivities(prev => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setBusySessionIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setUnreadSessionIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (wasActive) {
      setActiveSessionId(null);
      activeSessionRef.current = null;
      setHasReadySession(false);
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'delete_session', sessionId: id }));
    }
  }, [setSessionsSynced]);

  const renameSession = useCallback((id: string, name: string) => {
    setSessionsSynced(prev => prev.map(s => s.id === id ? { ...s, name } : s));
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'rename_session', sessionId: id, name }));
    }
  }, [setSessionsSynced]);

  const switchSessionModel = useCallback((sessionId: string, modelId: string) => {
    setSelectedModelId(modelId);
    setSessionsSynced(prev => prev.map(session => {
      if (session.id !== sessionId) return session;
      const model = models.find(candidate => candidate.id === modelId);
      return {
        ...session,
        modelId,
        modelLabel: model?.label || session.modelLabel,
        modelProvider: model?.provider || session.modelProvider,
      };
    }));
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'set_session_model',
        sessionId,
        modelId,
      }));
    }
  }, [models, setSelectedModelId, setSessionsSynced]);

  const switchSessionProfile = useCallback((sessionId: string, agentProfileId: string) => {
    setSelectedAgentProfileId(agentProfileId);
    const profile = agentProfiles.find(candidate => candidate.id === agentProfileId);
    const model = profile ? models.find(candidate => candidate.id === profile.modelId) : undefined;
    setSessionsSynced(prev => prev.map(session => {
      if (session.id !== sessionId) return session;
      return {
        ...session,
        agentProfileId,
        agentProfileName: profile?.name || session.agentProfileName,
        modelId: profile?.modelId || session.modelId,
        modelLabel: model?.label || session.modelLabel,
        modelProvider: model?.provider || session.modelProvider,
      };
    }));
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'set_session_profile',
        sessionId,
        agentProfileId,
      }));
    }
  }, [agentProfiles, models, setSelectedAgentProfileId, setSessionsSynced]);

  const saveAgentProfile = useCallback((profile: Partial<AgentProfile> & { id?: string }) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'save_agent_profile',
        profile,
      }));
    }
  }, []);

  const deleteAgentProfile = useCallback((id: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'delete_agent_profile',
        profileId: id,
      }));
    }
  }, []);

  const createProject = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'create_project', name: trimmed }));
    }
  }, []);

  const renameProject = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed || id === defaultProjectId) return;
    setProjects(prev => prev.map(project => project.id === id ? { ...project, name: trimmed } : project));
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'rename_project', projectId: id, name: trimmed }));
    }
  }, [defaultProjectId]);

  const deleteProject = useCallback((id: string) => {
    if (id === defaultProjectId) return;
    setProjects(prev => ensureDefaultProject(prev.filter(project => project.id !== id)));
    setSessionsSynced(prev => prev.map(session => session.projectId === id ? { ...session, projectId: defaultProjectId } : session));
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'delete_project', projectId: id }));
    }
  }, [defaultProjectId, setSessionsSynced]);

  const moveSession = useCallback((sessionId: string, projectId: string) => {
    const targetProjectId = projects.some(project => project.id === projectId) ? projectId : defaultProjectId;
    setSessionsSynced(prev => prev.map(session => session.id === sessionId ? { ...session, projectId: targetProjectId } : session));
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'move_session', sessionId, projectId: targetProjectId }));
    }
  }, [defaultProjectId, projects, setSessionsSynced]);

  const isStreaming = useMemo(() => {
    if (!activeSessionId) return false;
    const msgs = messages.get(activeSessionId) || [];
    return msgs.some(m => m.role === 'assistant' && m.isStreaming);
  }, [messages, activeSessionId]);

  const contextValue = useMemo<PiAgentContextValue>(() => ({
    isConnected,
    hasReadySession,
    sessions,
    projects,
    defaultProjectId,
    activeSessionId,
    activeSession,
    collapsedProjectIds: collapsedProjectIdsState,
    unreadSessionIds,
    models,
    agentProfiles,
    agentExtensions,
    agentSkills,
    modelStatus,
    activeSessionBusy,
    slashCommands,
    refreshSlashCommands,
    selectedModelId,
    setSelectedModelId,
    selectedAgentProfileId,
    setSelectedAgentProfileId,
    switchSessionModel,
    switchSessionProfile,
    saveAgentProfile,
    deleteAgentProfile,
    messages: getActiveMessages(messages, activeSessionId),
    activeActivity,
    sendMessage,
    abort,
    createSession,
    switchSession,
    setCollapsedProjectIds,
    deleteSession,
    renameSession,
    createProject,
    renameProject,
    deleteProject,
    moveSession,
  }), [isConnected, hasReadySession, sessions, projects, defaultProjectId, activeSessionId, activeSession, collapsedProjectIdsState, unreadSessionIds, models, agentProfiles, agentExtensions, agentSkills, modelStatus, activeSessionBusy, slashCommands, refreshSlashCommands, selectedModelId, setSelectedModelId, selectedAgentProfileId, setSelectedAgentProfileId, switchSessionModel, switchSessionProfile, saveAgentProfile, deleteAgentProfile,
    activeActivity,
    getActiveMessages(messages, activeSessionId), sendMessage, abort, createSession, switchSession, setCollapsedProjectIds, deleteSession, renameSession,
    createProject, renameProject, deleteProject, moveSession]);

  return (
    <PiAgentContext.Provider value={contextValue}>
      {children}
    </PiAgentContext.Provider>
  );
}

function ensureDefaultProject(projects: Project[]): Project[] {
  const byId = new Map<string, Project>();
  byId.set(DEFAULT_PROJECT_ID, DEFAULT_PROJECT);
  for (const project of projects) {
    if (!project?.id || !project.name) continue;
    byId.set(project.id, project);
  }
  return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);
}
