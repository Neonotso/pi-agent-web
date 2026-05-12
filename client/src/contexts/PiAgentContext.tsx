import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { PiEvent, ChatMessage } from './types';

interface PiAgentContextValue {
  isConnected: boolean;
  isStreaming: boolean;
  currentSessionId: string | null;
  sessions: Array<{ id: string; name: string; createdAt: number }>;
  messages: ChatMessage[];
  appendMessage: (msg: ChatMessage) => void;
  updateStreamingMessage: (text: string) => void;
  finishStreamingMessage: () => ChatMessage | null;
  sendMessage: (text: string, options?: { streamingBehavior?: 'steer' | 'followUp' }) => void;
  abort: () => void;
  createSession: (name?: string) => void;
  switchSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  compact: (instructions?: string) => void;
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
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Array<{ id: string; name: string; createdAt: number }>>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingStreamingRef = useRef<string>('');
  const streamingMsgIdRef = useRef<string>('');

  // Connect to WebSocket
  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[WS] Connected');
      setIsConnected(true);
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      setIsConnected(false);
      // Auto-reconnect
      setTimeout(() => {
        if (wsRef.current?.readyState !== WebSocket.OPEN) {
          const retry = new WebSocket(WS_URL);
          wsRef.current = retry;
        }
      }, 2000);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleWsMessage(data);
      } catch (err) {
        console.error('[WS] Parse error:', err, event.data);
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  const handleWsMessage = useCallback((data: any) => {
    switch (data.type) {
      case 'connected':
        setCurrentSessionId(data.sessionId);
        break;

      case 'session_created':
      case 'session_switched': {
        setCurrentSessionId(data.sessionId || data.sessionId);
        setMessages([]); // Clear messages when switching
        break;
      }

      case 'session_deleted':
        setSessions((prev) => prev.filter((s) => s.id !== data.sessionId));
        break;

      case 'pi_event': {
        // Parse raw JSON from Pi RPC
        try {
          const rawEvent = JSON.parse(data.raw);
          handlePiEvent(rawEvent);
        } catch {
          // Not valid JSON, just log
          console.log('[Pi raw]', data.raw.slice(0, 200));
        }
        break;
      }

      case 'response': {
        // RPC response - could be state, messages, stats, etc.
        console.log('[Pi response]', data.command, data.success);
        if (data.command === 'get_state' && data.data) {
          // Update session info
        }
        break;
      }
    }
  }, []);

  const handlePiEvent = useCallback((event: PiEvent) => {
    switch (event.type) {
      case 'agent_start': {
        setIsStreaming(true);
        // Start streaming accumulator
        pendingStreamingRef.current = '';
        const msgId = `stream-${Date.now()}`;
        streamingMsgIdRef.current = msgId;
        setMessages((prev) => [
          ...prev,
          {
            id: msgId,
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            isStreaming: true,
          },
        ]);
        break;
      }

      case 'message_update': {
        const delta = event.assistantMessageEvent;
        if (delta.type === 'text_delta' && delta.delta) {
          pendingStreamingRef.current += delta.delta;
          // Debounced update to avoid too many re-renders
          setMessages((prev) =>
            prev.map((m) =>
              m.role === 'assistant' && m.isStreaming
                ? { ...m, content: pendingStreamingRef.current }
                : m
            )
          );
        }
        break;
      }

      case 'tool_execution_start': {
        console.log(`[Tool] ${event.toolName} started`);
        break;
      }

      case 'tool_execution_end': {
        console.log(`[Tool] ${event.toolName} done`);
        // Add tool result message
        const resultText = event.result?.content?.[0]?.text || '';
        setMessages((prev) => [
          ...prev,
          {
            id: `tool-${event.toolCallId}-${Date.now()}`,
            role: 'tool',
            content: event.toolName || 'tool',
            toolName: event.toolName,
            output: resultText.slice(0, 100),
            timestamp: Date.now(),
          },
        ]);
        break;
      }

      case 'agent_end': {
        setIsStreaming(false);
        // Finalize streaming message
        setMessages((prev) =>
          prev.map((m) =>
            m.role === 'assistant' && m.isStreaming
              ? { ...m, isStreaming: false }
              : m
          )
        );
        break;
      }

      case 'messages': {
        // Received message list from get_messages
        if (event.messages) {
          // Convert Pi messages to our ChatMessage format
          const chatMessages: ChatMessage[] = event.messages
            .filter((m: any) => m.role === 'user' || m.role === 'assistant')
            .map((m: any, i: number) => ({
              id: `msg-${i}`,
              role: m.role === 'user' ? 'user' : 'assistant',
              content: typeof m.content === 'string' ? m.content : m.content?.[0]?.text || '',
              timestamp: m.timestamp || Date.now(),
            }));
          setMessages(chatMessages);
        }
        break;
      }
    }
  }, []);

  const appendMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const updateStreamingMessage = useCallback((text: string) => {
    pendingStreamingRef.current = text;
  }, []);

  const finishStreamingMessage = useCallback((): ChatMessage | null => {
    setIsStreaming(false);
    const finalMsg: ChatMessage = {
      id: `stream-${Date.now()}`,
      role: 'assistant',
      content: pendingStreamingRef.current,
      timestamp: Date.now(),
      isStreaming: false,
    };
    setMessages((prev) => [
      ...prev.filter((m) => m.isStreaming),
      finalMsg,
    ]);
    pendingStreamingRef.current = '';
    return finalMsg;
  }, []);

  const sendMessage = useCallback(
    (text: string, options?: { streamingBehavior?: 'steer' | 'followUp' }) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

      wsRef.current.send(
        JSON.stringify({
          type: 'prompt',
          message: text,
          streamingBehavior: options?.streamingBehavior,
        })
      );
    },
    []
  );

  const abort = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'abort' }));
    }
  }, []);

  const createSession = useCallback((name?: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'new_session' }));
  }, []);

  const switchSession = useCallback((sessionId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'switch_session', targetSessionId: sessionId }));
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'delete_session', sessionId }));
  }, []);

  const compact = useCallback((instructions?: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(
      JSON.stringify({
        type: 'compact',
        customInstructions: instructions,
      })
    );
  }, []);

  return (
    <PiAgentContext.Provider
      value={{
        isConnected,
        isStreaming,
        currentSessionId,
        sessions,
        messages,
        appendMessage,
        updateStreamingMessage,
        finishStreamingMessage,
        sendMessage,
        abort,
        createSession,
        switchSession,
        deleteSession,
        compact,
      }}
    >
      {children}
    </PiAgentContext.Provider>
  );
}
