import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, PiEvent, StreamingState } from '../types';

const WS_URL = import.meta.env.DEV
  ? `ws://${window.location.hostname}:3001`
  : `ws://${window.location.host}/ws`;

interface UseWebSocketResult {
  sendMessage: (message: string, options?: { streamingBehavior?: 'steer' | 'followUp' }) => void;
  abort: () => void;
  createSession: () => void;
  switchSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  getSessionInfo: () => any;
  getState: () => void;
  getMessages: () => void;
  compact: (instructions?: string) => void;
  isConnecting: boolean;
  isConnected: boolean;
  streaming: boolean;
  streamingState: StreamingState;
}

export function useWebSocket(): UseWebSocketResult {
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [streamingState, setStreamingState] = useState<StreamingState>({
    assistantMessageId: null,
    accumulatedText: '',
    toolCalls: [],
  });
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Set<string>>(new Set());
  const [messageCallbacks] = useState<Map<string, (msg: any) => void>>(new Map());

  // Callback ref for sendMessage to access current sessionId
  const sendMessageRef = useRef<(msg: string, options?: any) => void>(null!);

  // Session callbacks ref
  const sessionCallbacksRef = useRef<Map<string, (sessions: Set<string>, sessionId?: string) => void>>(new Map());

  const registerSessionCallback = useCallback((callback: (sessions: Set<string>, sessionId?: string) => void) => {
    const id = Math.random().toString(36).slice(2);
    sessionCallbacksRef.current.set(id, callback);
    return () => sessionCallbacksRef.current.delete(id);
  }, []);

  // Connection management
  useEffect(() => {
    connect();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  const connect = useCallback(() => {
    setIsConnecting(true);
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[WS] Connected');
      setIsConnected(true);
      setIsConnecting(false);
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      setIsConnected(false);
      setIsConnecting(true);
      // Auto-reconnect after 2s
      setTimeout(connect, 2000);
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
      setIsConnected(false);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case 'session_info':
          case 'session_started':
          case 'session_created':
          case 'session_switched': {
            const sid = data.sessionId || data.newSession;
            setCurrentSessionId(sid);
            if (data.sessions) {
              setSessions(new Set(data.sessions));
            }
            // Notify registered callbacks
            sessionCallbacksRef.current.forEach((cb) => cb(sessions, sid));
            break;
          }

          case 'event': {
            const piEvent: PiEvent = data.data;
            handlePiEvent(piEvent);
            break;
          }

          case 'stderr': {
            console.error(`[Pi ${data.sessionId}]`, data.data);
            break;
          }

          case 'session_closed': {
            console.log(`[Session ${data.sessionId}] closed`);
            setSessions((prev) => {
              const next = new Set(prev);
              next.delete(data.sessionId);
              return next;
            });
            break;
          }

          case 'session_deleted': {
            setSessions((prev) => {
              const next = new Set(prev);
              next.delete(data.sessionId);
              return next;
            });
            break;
          }
        }
      } catch (err) {
        console.error('[WS] Parse error:', err, event.data);
      }
    };

    // Setup send handler
    sendMessageRef.current = (message: string, options?: any) => {
      if (ws.readyState === WebSocket.OPEN && currentSessionId) {
        ws.send(JSON.stringify({
          type: 'prompt',
          message,
          streamingBehavior: options?.streamingBehavior,
        }));
      }
    };
  }, [currentSessionId]); // eslint-disable-line

  const handlePiEvent = useCallback((event: PiEvent) => {
    // console.log('[Pi Event]', event.type, event);

    switch (event.type) {
      case 'agent_start': {
        setStreaming(true);
        // Start a new assistant message accumulator
        setStreamingState({
          assistantMessageId: null,
          accumulatedText: '',
          toolCalls: [],
        });
        break;
      }

      case 'message_update': {
        const delta = event.assistantMessageEvent;
        if (delta.type === 'text_delta' && delta.delta) {
          setStreamingState((prev) => ({
            ...prev,
            accumulatedText: prev.accumulatedText + delta.delta,
          }));
        }
        // Handle tool calls
        if (delta.type === 'toolcall_delta') {
          // Tool call arguments streaming
        }
        if (delta.type === 'toolcall_end') {
          setStreamingState((prev) => ({
            ...prev,
            toolCalls: [...prev.toolCalls, {
              id: delta.toolCall.id,
              name: delta.toolCall.name,
              args: delta.toolCall.arguments || '{}',
            }],
          }));
        }
        break;
      }

      case 'message_end': {
        // Message complete
        break;
      }

      case 'tool_execution_start': {
        console.log(`[Tool] ${event.toolName} starting`);
        break;
      }

      case 'tool_execution_end': {
        console.log(`[Tool] ${event.toolName} complete`);
        setStreamingState((prev) => ({
          ...prev,
          toolCalls: prev.toolCalls.map((tc) =>
            tc.id === event.toolCallId
              ? { ...tc, result: event.result?.content?.[0]?.text || '', isError: event.isError }
              : tc
          ),
        }));
        break;
      }

      case 'agent_end': {
        setStreaming(false);
        setStreamingState({
          assistantMessageId: null,
          accumulatedText: '',
          toolCalls: [],
        });
        // Auto-refresh messages
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'get_messages' }));
        }
        break;
      }

      case 'messages': {
        // Received messages list (from get_messages)
        // This would trigger a chat refresh
        break;
      }
    }
  }, []);

  // Public methods
  const sendMessage = useCallback((message: string, options?: { streamingBehavior?: 'steer' | 'followUp' }) => {
    sendMessageRef.current(message, options);
  }, []);

  const abort = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'abort' }));
    }
  }, []);

  const createSession = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'create_session' }));
    }
  }, []);

  const switchSession = useCallback((sessionId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'switch_session', targetSessionId: sessionId }));
      setCurrentSessionId(sessionId);
    }
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'delete_session', sessionId }));
    }
  }, []);

  const getSessionInfo = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return { sessionId: currentSessionId, sessions: Array.from(sessions) };
    }
    return null;
  }, [currentSessionId, sessions]);

  const getState = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'get_state' }));
    }
  }, []);

  const getMessages = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'get_messages' }));
    }
  }, []);

  const compact = useCallback((instructions?: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'compact',
        customInstructions: instructions,
      }));
    }
  }, []);

  return {
    sendMessage,
    abort,
    createSession,
    switchSession,
    deleteSession,
    getSessionInfo,
    getState,
    getMessages,
    compact,
    isConnecting,
    isConnected,
    streaming,
    streamingState,
  };
}
