import { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { ChatMessage } from './types';

export interface Session {
  id: string;
  name: string;
  createdAt: number;
}

interface PiAgentContextValue {
  isConnected: boolean;
  hasReadySession: boolean;
  sessions: Session[];
  activeSessionId: string | null;
  messages: ChatMessage[];  // Active session's messages
  sendMessage: (text: string) => void;
  abort: () => void;
  createSession: (name?: string) => void;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, name: string) => void;
}

const PiAgentContext = createContext<PiAgentContextValue | null>(null);

export function usePiAgent(): PiAgentContextValue {
  const ctx = useContext(PiAgentContext);
  if (!ctx) throw new Error('usePiAgent must be used within PiAgentProvider');
  return ctx;
}

const WS_URL = import.meta.env.DEV
  ? `ws://${window.location.hostname}:3001`
  : `ws://${window.location.host}/ws`;

export function PiAgentProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Map<string, ChatMessage[]>>(new Map());
  const [hasReadySession, setHasReadySession] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Record<string, string>>({});  // sessionId → streaming text
  const idCounterRef = useRef(0);

  // Helpers
  const getActiveMessages = useCallback((msgs: Map<string, ChatMessage[]>, sid: string | null) => {
    return sid ? (msgs.get(sid) || []) : [];
  }, []);

  // Connect WebSocket
  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => setIsConnected(true);
    ws.onclose = () => setIsConnected(false);
    ws.onmessage = (e) => {
      try { handleWs(JSON.parse(e.data)); } catch {}
    };

    return () => { ws.close(); wsRef.current = null; };
  }, []);

  const handleWs = useCallback((data: any) => {
    switch (data.type) {
      case 'session_list':
        setSessions(data.sessions || []);
        break;

      case 'connected':
        // First session for this connection — activate it
        if (data.sessionId) {
          setSessions(prev => {
            if (prev.find(s => s.id === data.sessionId)) return prev;
            return [...prev, { id: data.sessionId, name: 'New Chat', createdAt: Date.now() }];
          });
          setMessages(prev => {
            const next = new Map(prev);
            if (!next.has(data.sessionId)) next.set(data.sessionId, []);
            return next;
          });
          setActiveSessionId(data.sessionId);
          setHasReadySession(true);
        }
        break;

      case 'session_created':
        if (data.sessionId) {
          const session = { id: data.sessionId, name: 'New Chat', createdAt: Date.now() };
          setSessions(prev => [...prev, session]);
          setMessages(prev => {
            const next = new Map(prev);
            next.set(data.sessionId, []);
            return next;
          });
          setActiveSessionId(data.sessionId);
        }
        break;

      case 'session_deleted':
        setSessions(prev => prev.filter(s => s.id !== data.sessionId));
        setMessages(prev => {
          const next = new Map(prev);
          next.delete(data.sessionId);
          pendingRef.current[data.sessionId] = '';
          return next;
        });
        if (activeSessionId === data.sessionId) {
          const remaining = sessions.filter(s => s.id !== data.sessionId);
          setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
        }
        break;

      case 'session_closed':
        if (data.sessionId) {
          // Session Pi process died, remove it
          setSessions(prev => prev.filter(s => s.id !== data.sessionId));
          setMessages(prev => {
            const next = new Map(prev);
            next.delete(data.sessionId);
            pendingRef.current[data.sessionId] = '';
            return next;
          });
        }
        break;

      case 'pi_event':
        try {
          const raw = JSON.parse(data.raw);
          handlePiEvent(raw);
        } catch { /* ignore */ }
        break;

      case 'messages':
        // Update messages for active session
        if (data.messages && activeSessionId) {
          const chatMessages: ChatMessage[] = data.messages
            .filter((m: any) => m.role === 'user' || m.role === 'assistant')
            .map((m: any, i: number) => ({
              id: `m-${i}`, role: m.role === 'user' ? 'user' : 'assistant',
              content: typeof m.content === 'string' ? m.content : m.content?.[0]?.text || '',
              timestamp: m.timestamp || Date.now(),
            }));
          setMessages(prev => {
            const next = new Map(prev);
            next.set(activeSessionId!, chatMessages);
            return next;
          });
        }
        break;
    }
  }, [sessions, activeSessionId]);

  const handlePiEvent = useCallback((event: any) => {
    switch (event.type) {
      case 'agent_start':
        if (!activeSessionId) return;
        pendingRef.current[activeSessionId] = '';
        idCounterRef.current++;
        setMessages(prev => {
          const msg: ChatMessage = {
            id: `s-${idCounterRef.current}`,
            role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true,
          };
          const next = new Map(prev);
          const existing = next.get(activeSessionId) || [];
          next.set(activeSessionId, [...existing, msg]);
          return next;
        });
        break;

      case 'message_update': {
        if (!activeSessionId || event.assistantMessageEvent?.type !== 'text_delta') return;
        pendingRef.current[activeSessionId] += event.assistantMessageEvent.delta;
        setMessages(prev => {
          const next = new Map(prev);
          const msgs = next.get(activeSessionId) || [];
          const updated = msgs.map(m =>
            m.role === 'assistant' && m.isStreaming ? { ...m, content: pendingRef.current[activeSessionId] } : m
          );
          next.set(activeSessionId, updated);
          return next;
        });
        break;
      }

      case 'tool_execution_end':
        if (!activeSessionId) return;
        const txt = event.result?.content?.[0]?.text || '';
        setMessages(prev => {
          const next = new Map(prev);
          const msgs = next.get(activeSessionId) || [];
          next.set(activeSessionId, [...msgs, {
            id: `tool-${event.toolCallId}-${Date.now()}`,
            role: 'tool', content: event.toolName || 'tool',
            toolName: event.toolName, output: txt.slice(0, 100), timestamp: Date.now(),
          }]);
          return next;
        });
        break;

      case 'agent_end':
        if (!activeSessionId) return;
        setMessages(prev => {
          const next = new Map(prev);
          const msgs = next.get(activeSessionId) || [];
          next.set(activeSessionId, msgs.map(m =>
            m.role === 'assistant' && m.isStreaming ? { ...m, isStreaming: false } : m
          ));
          return next;
        });
        break;
    }
  }, [activeSessionId]);

  const sendMessage = useCallback((text: string) => {
    if (!hasReadySession || !activeSessionId) {
      console.log('[Context] No ready session, buffering:', text.slice(0, 40));
      return;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`, role: 'user', content: text, timestamp: Date.now(),
    };
    setMessages(prev => {
      const next = new Map(prev);
      const msgs = next.get(activeSessionId!) || [];
      next.set(activeSessionId!, [...msgs, userMsg]);
      return next;
    });

    ws.send(JSON.stringify({ type: 'prompt', sessionId: activeSessionId, message: text }));
  }, [activeSessionId]);

  const abort = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && activeSessionId) {
      ws.send(JSON.stringify({ type: 'abort', sessionId: activeSessionId }));
    }
  }, [activeSessionId]);

  const createSession = useCallback((name?: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'new_session', name: name || 'New Chat' }));
    }
  }, []);

  const switchSession = useCallback((id: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'switch_session', targetSessionId: id }));
    }
    setActiveSessionId(id);
  }, []);

  const deleteSession = useCallback((id: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'delete_session', sessionId: id }));
    }
  }, []);

  const renameSession = useCallback((id: string, name: string) => {
    setSessions(prev => prev.map(s => s.id === id ? { ...s, name } : s));
  }, []);

  const isStreaming = useMemo(() => {
    if (!activeSessionId) return false;
    const msgs = messages.get(activeSessionId) || [];
    return msgs.some(m => m.role === 'assistant' && m.isStreaming);
  }, [messages, activeSessionId]);

  const contextValue = useMemo<PiAgentContextValue>(() => ({
    isConnected,
    sessions,
    activeSessionId,
    messages: getActiveMessages(messages, activeSessionId),
    sendMessage,
    abort,
    createSession,
    switchSession,
    deleteSession,
    renameSession,
  }), [isConnected, sessions, activeSessionId, getActiveMessages(messages, activeSessionId),
    hasReadySession, sendMessage, abort, createSession, switchSession, deleteSession, renameSession]);

  return (
    <PiAgentContext.Provider value={contextValue}>
      {children}
    </PiAgentContext.Provider>
  );
}
