import { useRef, useEffect, useState, useCallback } from 'react';
import Message from './Message';
import { usePiAgent } from '../contexts/PiAgentContext';
import type { ActiveActivity, ComposerAttachment, ModelRuntimeStatus, SlashCommand } from '../types';

declare global {
  interface Window {
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    SpeechRecognition?: SpeechRecognitionConstructor;
  }
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

interface SpeechRecognitionEvent {
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
  resultIndex: number;
}

const BUILT_IN_SLASH_COMMANDS: SlashCommand[] = [
  { command: '/reset-context', description: 'Hard reset context, keep recent chat' },
  { command: '/clear-context', description: 'Same as reset-context' },
  { command: '/compact', description: 'Summarize older context' },
  { command: '/model', description: 'List or switch models' },
  { command: '/thinking', description: 'Set or cycle thinking level' },
  { command: '/reload', description: 'Restart Pi and reload extensions' },
  { command: '/state', description: 'Show current session state' },
  { command: '/stats', description: 'Show message and tool counts' },
  { command: '/commands', description: 'Show Pi extension commands' },
  { command: '/name', description: 'Rename this chat' },
  { command: '/new', description: 'Start a new chat' },
  { command: '/auto-compact', description: 'Turn auto compaction on/off' },
  { command: '/bash', description: 'Run a shell command through Pi' },
  { command: '/export', description: 'Export this session as HTML' },
  { command: '/help', description: 'Show chat command help' },
  { command: '/last', description: 'Show last assistant response' },
];

function mergeSlashCommands(dynamicCommands: SlashCommand[]): SlashCommand[] {
  const byCommand = new Map<string, SlashCommand>();
  for (const command of [...BUILT_IN_SLASH_COMMANDS, ...dynamicCommands]) {
    if (!command.command.startsWith('/')) continue;
    byCommand.set(command.command, command);
  }
  return Array.from(byCommand.values()).sort((a, b) => a.command.localeCompare(b.command));
}

function compactSearchText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function modelCommandAlias(model: { id: string; label: string }) {
  const id = model.id.toLowerCase();
  if (id.includes('mtp')) return 'MTP';
  if (id.includes('dense') || id.includes('27b')) return 'Dense';
  if (id.includes('deepseek') || id.includes('ds4')) return 'DS4';
  return model.label;
}

function joinSpeechText(base: string, addition: string) {
  const cleanAddition = addition.replace(/\s+/g, ' ').trim();
  if (!cleanAddition) return base;
  const cleanBase = base.replace(/\s+$/g, '');
  if (!cleanBase) return cleanAddition;
  if (/[\s([{/"'“‘-]$/.test(cleanBase)) return `${cleanBase}${cleanAddition}`;
  if (/^[.,!?;:%)\]}”’]/.test(cleanAddition)) return `${cleanBase}${cleanAddition}`;
  return `${cleanBase} ${cleanAddition}`;
}

export default function ChatArea() {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesPaneRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const userScrollIntentAtRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const speechBaseRef = useRef('');
  const speechCommittedRef = useRef('');
  const speechInterimRef = useRef('');
  const speechLastValueRef = useRef('');
  const composerDraftsRef = useRef<Record<string, { input: string; attachments: ComposerAttachment[] }>>({});
  const currentDraftKeyRef = useRef('__no_session__');
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [showChatHeader, setShowChatHeader] = useState(true);
  const [showStatusChrome, setShowStatusChrome] = useState(true);
  const [showComposer, setShowComposer] = useState(true);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const {
    isConnected,
    messages,
    sendMessage,
    createSession,
    deleteSession,
    renameSession,
    abort,
    activeSession,
    activeSessionId,
    activeActivity,
    activeSessionBusy,
    defaultProjectId,
    models,
    agentProfiles,
    selectedAgentProfileId,
    setSelectedAgentProfileId,
    selectedModelId,
    setSelectedModelId,
    switchSessionModel,
    switchSessionProfile,
    modelStatus,
    moveSession,
    slashCommands,
    refreshSlashCommands,
  } = usePiAgent();
  const [isRenamingChat, setIsRenamingChat] = useState(false);
  const [chatNameDraft, setChatNameDraft] = useState('');
  const draftKey = activeSessionId || '__no_session__';

  const isStreaming = messages.some(m => m.role === 'assistant' && m.isStreaming);
  const isWorking = isStreaming || activeSessionBusy || Boolean(activeActivity);
  const activeModelProvider = activeSession?.modelProvider === 'ds4' ? 'ds4' : 'omlx';
  const displayedModelStatus: ModelRuntimeStatus | null = modelStatus
    ? modelStatus.provider === activeModelProvider
      ? modelStatus
      : {
          provider: activeModelProvider,
          phase: 'idle',
          label: activeModelProvider === 'ds4' ? 'DS4 chat selected' : 'oMLX chat selected',
          detail: activeSession?.modelLabel,
          updatedAt: modelStatus.updatedAt,
        }
    : null;
  const visibleStatusBars = showStatusChrome ? Number(Boolean(displayedModelStatus)) + Number(Boolean(activeActivity)) : 0;
  const topRestorePosition = !showChatHeader && visibleStatusBars === 0
    ? 'chrome-restore-top-all-hidden'
    : showChatHeader
      ? 'chrome-restore-top-below-header'
      : visibleStatusBars > 1
        ? 'chrome-restore-top-below-status-stack'
        : 'chrome-restore-top-below-status';
  const isSingleLineSlash = input.startsWith('/') && !input.includes('\n');
  const modelCommandMatch = isSingleLineSlash ? input.match(/^\/model\s+(.*)$/i) : null;
  const modelQuery = (modelCommandMatch?.[1] || '').trim().toLowerCase();
  const slashQuery = isSingleLineSlash ? input.slice(1).toLowerCase() : '';
  const showSlashPalette = isSingleLineSlash && !input.includes(' ');
  const showModelPalette = Boolean(modelCommandMatch);
  const allSlashCommands = mergeSlashCommands(slashCommands);
  const modelMatches: SlashCommand[] = showModelPalette
    ? models
      .filter((model) => {
        if (!modelQuery) return true;
        const haystack = [model.id, model.label, model.model, model.description || ''].join(' ').toLowerCase();
        const compactHaystack = compactSearchText(haystack);
        const terms = modelQuery.split(/[^a-z0-9.]+/i).map(term => term.trim()).filter(Boolean);
        return terms.every(term => haystack.includes(term) || compactHaystack.includes(compactSearchText(term)));
      })
      .map((model) => ({
        command: `/model ${modelCommandAlias(model)}`,
        description: `${model.label}${model.description ? ` - ${model.description}` : ''}`,
      }))
      .slice(0, 8)
    : [];
  const slashMatches = showModelPalette
    ? modelMatches
    : showSlashPalette
      ? allSlashCommands.filter(item => item.command.slice(1).includes(slashQuery)).slice(0, 8)
      : [];

  useEffect(() => {
    setSelectedSlashIndex(0);
  }, [slashQuery, modelQuery]);

  useEffect(() => {
    if (showSlashPalette || input.toLowerCase() === '/model') refreshSlashCommands();
  }, [input, showSlashPalette, refreshSlashCommands]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior, block: 'end' });
    setShowJumpToBottom(false);
  }, []);

  const resizeComposer = useCallback(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, []);

  const scrollComposerToLatest = useCallback((force = false) => {
    requestAnimationFrame(() => {
      const textarea = inputRef.current;
      if (!textarea) return;
      const cursorAtEnd = textarea.selectionStart >= textarea.value.length - 1
        && textarea.selectionEnd >= textarea.value.length - 1;
      if (force || (document.activeElement === textarea && cursorAtEnd)) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    });
  }, []);

  useEffect(() => {
    resizeComposer();
    scrollComposerToLatest(isListening);
  }, [input, isListening, resizeComposer, scrollComposerToLatest]);

  useEffect(() => {
    composerDraftsRef.current[currentDraftKeyRef.current] = { input, attachments };
  }, [attachments, input]);

  useEffect(() => {
    const previousKey = currentDraftKeyRef.current;
    if (previousKey === draftKey) return;

    composerDraftsRef.current[previousKey] = { input, attachments };
    const nextDraft = composerDraftsRef.current[draftKey] || { input: '', attachments: [] };
    currentDraftKeyRef.current = draftKey;
    setInput(nextDraft.input);
    setAttachments(nextDraft.attachments);
    requestAnimationFrame(resizeComposer);
  }, [draftKey, resizeComposer]);

  useEffect(() => {
    if (shouldAutoScrollRef.current) scrollToLatest();
  }, [messages, scrollToLatest]);

  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) {
      inputRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !isWorking) return;
      event.preventDefault();
      event.stopPropagation();
      abort();
    };
    window.addEventListener('keydown', handleEscape, { capture: true });
    return () => window.removeEventListener('keydown', handleEscape, { capture: true });
  }, [abort, isWorking]);

  const noteUserScrollIntent = useCallback(() => {
    userScrollIntentAtRef.current = Date.now();
  }, []);

  const handleMessagesScroll = useCallback(() => {
    const pane = messagesPaneRef.current;
    if (!pane) return;
    const distanceFromBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
    const nearBottom = Math.max(360, pane.clientHeight * 0.35);
    const farFromBottom = Math.max(760, pane.clientHeight * 0.85);
    const recentUserScroll = Date.now() - userScrollIntentAtRef.current < 900;

    if (distanceFromBottom <= nearBottom) {
      shouldAutoScrollRef.current = true;
    } else if (recentUserScroll && distanceFromBottom > nearBottom) {
      shouldAutoScrollRef.current = false;
    }

    setShowJumpToBottom(distanceFromBottom > farFromBottom);
  }, []);

  const jumpToBottom = useCallback(() => {
    shouldAutoScrollRef.current = true;
    scrollToLatest();
  }, [scrollToLatest]);

  const stopSpeechInput = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onend = null;
    recognition.onerror = null;
    recognitionRef.current = null;
    speechBaseRef.current = '';
    speechCommittedRef.current = '';
    speechInterimRef.current = '';
    speechLastValueRef.current = '';
    setIsListening(false);
    try {
      recognition.stop();
    } catch {
      // Browser speech recognition can throw if it has already stopped.
    }
  }, []);

  const hideComposer = useCallback(() => {
    stopSpeechInput();
    setShowComposer(false);
  }, [stopSpeechInput]);

  const handleSubmit = useCallback((e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() && attachments.length === 0) return;
    const outgoingText = input.trim() || 'Please review the attached file.';
    stopSpeechInput();
    sendMessage(outgoingText, {
      ...(isWorking ? { streamingBehavior: 'steer' as const } : {}),
      attachments,
    });
    composerDraftsRef.current[currentDraftKeyRef.current] = { input: '', attachments: [] };
    setInput('');
    requestAnimationFrame(resizeComposer);
    setAttachments([]);
  }, [attachments, input, isWorking, resizeComposer, sendMessage, stopSpeechInput]);

  const chooseSlashCommand = useCallback((command: string) => {
    setInput(`${command} `);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      resizeComposer();
    });
  }, [resizeComposer]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedSlashIndex(index => (index + 1) % slashMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedSlashIndex(index => (index - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        chooseSlashCommand(slashMatches[selectedSlashIndex]?.command || slashMatches[0].command);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        chooseSlashCommand(slashMatches[selectedSlashIndex]?.command || slashMatches[0].command);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setInput('');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  }, [chooseSlashCommand, handleSubmit, selectedSlashIndex, slashMatches]);

  const handleResize = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = e.target.value;
    setInput(nextValue);
    if (isListening && nextValue !== speechLastValueRef.current) {
      speechBaseRef.current = nextValue.trimEnd();
      speechCommittedRef.current = '';
      speechInterimRef.current = '';
      speechLastValueRef.current = nextValue;
    }
  }, [isListening]);

  const startRenameChat = useCallback(() => {
    setChatNameDraft(activeSession?.name || 'New Chat');
    setIsRenamingChat(true);
  }, [activeSession?.name]);

  const finishRenameChat = useCallback(() => {
    const nextName = chatNameDraft.trim();
    if (activeSession?.id && nextName) {
      renameSession(activeSession.id, nextName);
    }
    setIsRenamingChat(false);
  }, [activeSession?.id, chatNameDraft, renameSession]);

  const handleDeleteActiveChat = useCallback(() => {
    if (!activeSession?.id) return;
    const label = activeSession.name || 'this chat';
    if (window.confirm(`Delete "${label}"?`)) {
      deleteSession(activeSession.id);
    }
  }, [activeSession?.id, activeSession?.name, deleteSession]);

  const handleSaveQuickChat = useCallback(() => {
    if (!activeSession?.id) return;
    moveSession(activeSession.id, defaultProjectId);
  }, [activeSession?.id, defaultProjectId, moveSession]);

  const handleAttachFiles = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;

    const maxBytes = 12 * 1024 * 1024;
    const loaded = await Promise.all(files.map(async (file) => {
      if (file.size > maxBytes) {
        alert(`${file.name} is too large. Please keep attachments under 12 MB for now.`);
        return null;
      }
      const data = await readFileAsBase64(file);
      return {
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        data,
      } satisfies ComposerAttachment;
    }));

    setAttachments(prev => [...prev, ...loaded.filter(Boolean) as ComposerAttachment[]].slice(0, 6));
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(attachment => attachment.id !== id));
  }, []);

  const toggleSpeech = useCallback(() => {
    const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionImpl) {
      alert('Speech input is not available in this browser yet.');
      return;
    }
    if (recognitionRef.current && isListening) {
      stopSpeechInput();
      return;
    }

    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    speechBaseRef.current = input.trimEnd();
    speechCommittedRef.current = '';
    speechInterimRef.current = '';
    speechLastValueRef.current = input;

    recognition.onresult = (event) => {
      let finalTranscript = '';
      let interim = '';
      for (let index = event.resultIndex || 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const phrase = (result[0]?.transcript || '').trim();
        if (!phrase) continue;
        if (result.isFinal) finalTranscript = joinSpeechText(finalTranscript, phrase);
        else interim += phrase;
      }
      if (finalTranscript) {
        speechCommittedRef.current = joinSpeechText(speechCommittedRef.current, finalTranscript);
        speechInterimRef.current = '';
      } else {
        speechInterimRef.current = interim;
      }
      const withFinal = joinSpeechText(speechBaseRef.current, speechCommittedRef.current);
      const nextValue = joinSpeechText(withFinal, speechInterimRef.current);
      speechLastValueRef.current = nextValue;
      setInput(nextValue);
      scrollComposerToLatest(true);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setIsListening(false);
      speechBaseRef.current = speechLastValueRef.current.trimEnd();
      speechCommittedRef.current = '';
      speechInterimRef.current = '';
      setInput((current) => current.replace(/\s*\[listening:.*?\]\s*$/i, '').trimEnd());
    };
    recognition.onerror = () => {
      recognitionRef.current = null;
      speechBaseRef.current = speechLastValueRef.current.trimEnd();
      speechCommittedRef.current = '';
      speechInterimRef.current = '';
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    setIsListening(true);
    recognition.start();
  }, [input, isListening, scrollComposerToLatest, stopSpeechInput]);

  return (
    <div className="relative flex min-h-0 flex-col h-full overflow-x-hidden">
      {/* Header */}
      {showChatHeader && (
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-surface-800 bg-surface-900/80 backdrop-blur-sm shrink-0">
        <div className="chat-header-title min-w-0 flex-1">
          {isRenamingChat ? (
            <input
              value={chatNameDraft}
              onChange={(event) => setChatNameDraft(event.target.value)}
              onBlur={finishRenameChat}
              onKeyDown={(event) => {
                if (event.key === 'Enter') finishRenameChat();
                if (event.key === 'Escape') setIsRenamingChat(false);
              }}
              className="chat-title-input"
              autoFocus
            />
          ) : (
            <button
              type="button"
              onClick={activeSession ? startRenameChat : undefined}
              className="chat-title-button"
              title="Rename chat"
            >
              <span className="truncate">{activeSession?.name || 'Quick Chat'}</span>
            </button>
          )}
          {models.length > 0 && (
            <select
              value={activeSession?.modelId || selectedModelId}
              onChange={(event) => {
                const nextModelId = event.target.value;
                if (activeSession?.id) {
                  switchSessionModel(activeSession.id, nextModelId);
                } else {
                  setSelectedModelId(nextModelId);
                }
              }}
              className="chat-model-select"
              disabled={!isConnected || isWorking}
              title={isWorking ? 'Model cannot be changed while Pi is responding' : 'Select model'}
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          )}
          {agentProfiles.length > 0 && (
            <select
              value={activeSession?.agentProfileId || selectedAgentProfileId}
              onChange={(event) => {
                const nextProfileId = event.target.value;
                if (activeSession?.id) {
                  switchSessionProfile(activeSession.id, nextProfileId);
                } else {
                  setSelectedAgentProfileId(nextProfileId);
                }
              }}
              className="chat-model-select"
              disabled={!isConnected || isWorking}
              title={isWorking ? 'Profile cannot be changed while Pi is responding' : 'Select agent profile'}
            >
              {agentProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          )}
          {!isConnected && <span className="text-xs text-red-400 ml-2">(disconnected)</span>}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {activeSession?.isQuick && (
            <button onClick={handleSaveQuickChat} className="header-icon-button" title="Save quick chat to Inbox" aria-label="Save quick chat to Inbox">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 11v5m0 0l-2-2m2 2l2-2" />
              </svg>
            </button>
          )}
          {activeSession?.id && (
            <button onClick={startRenameChat} className="header-icon-button" title="Rename chat" aria-label="Rename chat">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.86 3.49l3.65 3.65M4 20h4.25L19.7 8.55a2.58 2.58 0 00-3.65-3.65L4.6 16.35 4 20z" />
              </svg>
            </button>
          )}
          <button onClick={() => createSession(undefined, undefined, { isQuick: true })} className="header-icon-button" title="New quick chat" aria-label="New quick chat">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
          {activeSession?.id && (
            <button onClick={handleDeleteActiveChat} className="header-icon-button text-slate-500 hover:text-red-300" title="Delete chat" aria-label="Delete chat">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 7h12m-9 0V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0l.7 12a1 1 0 001 .94h6.6a1 1 0 001-.94L17 7" />
              </svg>
            </button>
          )}
          <button onClick={() => setShowStatusChrome(false)} className="header-icon-button" title="Hide model status" aria-label="Hide model status">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8h16M8 16h8" />
            </svg>
          </button>
          <button onClick={() => setShowChatHeader(false)} className="header-icon-button" title="Hide chat header" aria-label="Hide chat header">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <div className="flex items-center pl-1">
            <div className={`w-2 h-2 rounded-full ${isWorking ? 'bg-yellow-400 animate-pulse' : isConnected ? 'bg-green-400' : 'bg-red-400'}`} title={isWorking ? 'Working' : isConnected ? 'Ready' : 'Connecting'} />
          </div>
        </div>
      </header>
      )}

      {showStatusChrome && displayedModelStatus && <ModelStatusBar status={displayedModelStatus} menuSafe={!showChatHeader} onHide={() => setShowStatusChrome(false)} />}

      {showStatusChrome && activeActivity && <ActivityBanner activity={activeActivity} menuSafe={!showChatHeader} onHide={() => setShowStatusChrome(false)} />}

      {/* Messages */}
      <div
        ref={messagesPaneRef}
        onScroll={handleMessagesScroll}
        onWheel={noteUserScrollIntent}
        onTouchStart={noteUserScrollIntent}
        onPointerDown={noteUserScrollIntent}
        className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 pt-4 ${showComposer ? 'pb-4' : 'pb-12'}`}
      >
        {messages.length === 0 ? (
          <WelcomeScreen />
        ) : (
          <>
            {messages.map((msg) => <Message key={msg.id} message={msg} />)}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {showJumpToBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          className={`jump-bottom-button ${showComposer ? '' : 'jump-bottom-button-compact'}`}
          aria-label="Jump to latest message"
          title="Jump to latest message"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m0 0l-5-5m5 5l5-5" />
          </svg>
        </button>
      )}

      {(!showChatHeader || !showStatusChrome) && (
        <div className={`chrome-restore-top ${topRestorePosition}`} aria-label="Hidden chat controls">
          {!showChatHeader && (
            <button type="button" className="chrome-restore-button" onClick={() => setShowChatHeader(true)}>
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 9l7 7 7-7" />
              </svg>
              Header
            </button>
          )}
          {!showStatusChrome && (
            <button type="button" className="chrome-restore-button" onClick={() => setShowStatusChrome(true)}>
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M6 12h12M8 17h8" />
              </svg>
              Status
            </button>
          )}
        </div>
      )}

      {!showComposer && (
        <button type="button" className="chrome-restore-bottom" onClick={() => setShowComposer(true)}>
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
          Input
        </button>
      )}

      {/* Input */}
      {showComposer && (
      <div className="chat-input-bar border-t border-surface-800 bg-surface-900/80 backdrop-blur-sm px-3 pt-3 shrink-0">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto">
          <div className="relative">
            {slashMatches.length > 0 && (
              <div className="slash-command-palette">
                {slashMatches.map((item, index) => (
                  <button
                    key={item.command}
                    type="button"
                    className={`slash-command-option ${index === selectedSlashIndex ? 'active' : ''}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      chooseSlashCommand(item.command);
                    }}
                  >
                    <span className="font-mono text-slate-100">{item.command}</span>
                    <span className="truncate text-slate-500">{item.description}</span>
                  </button>
                ))}
              </div>
            )}
            {attachments.length > 0 && (
              <div className="attachment-tray">
                {attachments.map((attachment) => (
                  <span key={attachment.id} className="attachment-chip">
                    {attachment.mimeType.startsWith('image/') && (
                      <img
                        src={`data:${attachment.mimeType};base64,${attachment.data}`}
                        alt=""
                        className="attachment-chip-thumb"
                      />
                    )}
                    <span className="truncate">{attachment.name}</span>
                    <button type="button" onClick={() => removeAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`}>
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleResize}
              onKeyDown={handleKeyDown}
              placeholder={isWorking ? 'Steer Pi while it works...' : 'Message π Agent...'}
              className="input min-h-12 pl-24 pr-32 leading-6 overflow-y-auto"
              rows={1}
              disabled={!isConnected}
              style={{ maxHeight: '220px' }}
            />
            <div className="composer-actions composer-actions-left">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleAttachFiles}
              />
              <button type="button" onClick={() => fileInputRef.current?.click()} className="composer-action text-slate-400 hover:bg-surface-700 hover:text-white" title="Attach file">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.5 6.5l-7.78 7.78a2.5 2.5 0 103.54 3.54l8.13-8.13a4.5 4.5 0 10-6.36-6.36L5.9 11.46a6.5 6.5 0 109.2 9.19l6.36-6.36" />
                </svg>
              </button>
              <button type="button" onClick={toggleSpeech} className={`composer-action ${isListening ? 'bg-accent/20 text-accent-light' : 'text-slate-400 hover:bg-surface-700 hover:text-white'}`} title={isListening ? 'Stop speech input' : 'Speech input'}>
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3a3 3 0 00-3 3v6a3 3 0 106 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3m-4 0h8" />
                </svg>
              </button>
            </div>
            <div className="composer-actions composer-actions-right">
              {isWorking && (
                <button type="button" onClick={abort} className="composer-action text-red-400 hover:bg-red-900/30" title="Stop">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
                </button>
              )}
              <button type="submit" disabled={(!input.trim() && attachments.length === 0) || !isConnected} className="composer-action bg-accent text-white hover:bg-accent-dark disabled:opacity-30 disabled:cursor-not-allowed" title={isWorking ? 'Send as steering message' : 'Send'}>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5m0 0l-4 4m4-4l4 4" />
                  </svg>
              </button>
              <button type="button" onClick={hideComposer} className="composer-action text-slate-400 hover:bg-surface-700 hover:text-white" title="Hide input" aria-label="Hide input">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 9l7 7 7-7" />
                </svg>
              </button>
            </div>
          </div>
        </form>
      </div>
      )}
    </div>
  );
}

function ModelStatusBar({ status, menuSafe, onHide }: { status: ModelRuntimeStatus; menuSafe?: boolean; onHide?: () => void }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (typeof status.estimatedRemainingSeconds !== 'number') return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [status.estimatedRemainingSeconds, status.updatedAt]);

  const percent = typeof status.percent === 'number'
    ? Math.max(0, Math.min(100, status.percent))
    : status.phase === 'complete'
      ? 100
      : undefined;
  const isActive = status.phase === 'prefill' || status.phase === 'generating' || status.phase === 'starting';
  const isFailed = status.phase === 'failed';
  const elapsed = typeof status.elapsedSeconds === 'number'
    ? formatElapsed(status.elapsedSeconds * 1000)
    : null;
  const eta = typeof status.estimatedRemainingSeconds === 'number'
    ? Math.max(0, status.estimatedRemainingSeconds - Math.max(0, Date.now() - status.updatedAt) / 1000)
    : null;
  const providerLabel = status.provider === 'omlx' ? 'oMLX' : 'DS4';

  return (
    <div className={`model-status-bar ${menuSafe ? 'model-status-menu-safe' : ''} ${isFailed ? 'model-status-bar-failed' : ''} ${status.provider === 'omlx' ? 'model-status-bar-omlx' : ''}`}>
      <div className="model-status-inner">
        <div className={`model-status-dot ${isActive ? 'model-status-dot-active' : ''} ${isFailed ? 'model-status-dot-failed' : ''}`} aria-hidden="true" />
        <div className="model-status-copy">
          <div className="model-status-main">
            <span className="model-status-provider">{providerLabel}</span>
            <span className="model-status-label">{status.label}</span>
            {typeof status.tokensPerSecond === 'number' && status.tokensPerSecond > 0 && (
              <span className="model-status-pill">{status.tokensPerSecond.toFixed(1)} tok/s</span>
            )}
            {elapsed && <span className="model-status-pill">{elapsed}</span>}
            {eta !== null && <span className="model-status-pill">ETA {formatElapsed(eta * 1000)}</span>}
          </div>
          {status.detail && <div className="model-status-detail" title={status.detail}>{status.detail}</div>}
        </div>
        {typeof percent === 'number' && (
          <div className="model-status-progress" aria-label={`Model progress ${percent.toFixed(0)} percent`}>
            <div className="model-status-progress-fill" style={{ width: `${percent}%` }} />
          </div>
        )}
        {onHide && (
          <button type="button" className="chrome-inline-hide" onClick={onHide} title="Hide model status" aria-label="Hide model status">
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

function ActivityBanner({ activity, menuSafe, onHide }: { activity: ActiveActivity; menuSafe?: boolean; onHide?: () => void }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const elapsedFrom = activity.startedAt || activity.updatedAt;
  const elapsed = formatElapsed(Date.now() - elapsedFrom);
  const detail = activity.detail?.trim();

  return (
    <div className={`shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 ${menuSafe ? 'activity-menu-safe' : ''}`}>
      <div className="mx-auto flex max-w-3xl items-start gap-3 text-xs text-amber-100">
        <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-amber-300 animate-pulse" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
            <span>{activity.label}</span>
            <span className="rounded-full border border-amber-300/30 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber-200/90">
              {activity.state === 'running' ? `active ${elapsed}` : 'queued'}
            </span>
          </div>
          {detail && (
            <div className="mt-1 truncate font-mono text-[11px] text-amber-100/70" title={detail}>
              {detail}
            </div>
          )}
        </div>
        {onHide && (
          <button type="button" className="chrome-inline-hide text-amber-200/70 hover:bg-amber-400/10 hover:text-amber-100" onClick={onHide} title="Hide activity" aria-label="Hide activity">
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

function formatElapsed(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function WelcomeScreen() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-4">
      <div className="text-6xl mb-4 opacity-20 select-none">π</div>
      <h2 className="text-xl font-semibold text-slate-300 mb-2">How can I help?</h2>
      <p className="text-sm text-slate-500 max-w-md mb-8">
        Send a message to start a quick chat. Save it to a project later if it turns into something worth keeping.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-lg">
        {['💰 Record a budget transaction', '🎵 Help with my music career', '📧 Check my inbox', '🏠 Check my Wyze lights'].map((s) => (
          <WelcomeSuggestion key={s} text={s} />
        ))}
      </div>
    </div>
  );
}

function WelcomeSuggestion({ text }: { text: string }) {
  const { sendMessage } = usePiAgent();
  return (
    <button onClick={() => sendMessage(text)} className="text-left p-3 bg-surface-800/50 border border-surface-700/50 rounded-xl text-sm text-slate-400 hover:bg-surface-800 hover:text-slate-300 transition-colors">
      {text}
    </button>
  );
}
