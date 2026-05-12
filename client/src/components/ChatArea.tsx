import { useRef, useEffect, useState, useCallback } from 'react';
import Message from './Message';
import { usePiAgent } from '../contexts/PiAgentContext';

export default function ChatArea() {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState('');
  const {
    isConnected,
    isStreaming,
    messages,
    sendMessage,
    abort,
    createSession,
  } = usePiAgent();

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!input.trim() || isStreaming) return;

      const text = input.trim();
      setInput('');
      sendMessage(text);
      inputRef.current?.focus();
    },
    [input, isStreaming, sendMessage]
  );

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  const handleResize = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      e.target.style.height = 'auto';
      e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
      setInput(e.target.value);
    },
    []
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-surface-800 bg-surface-900/80 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-accent font-bold text-lg">π</span>
          <span className="text-slate-400 text-sm hidden sm:inline">Agent</span>
          {!isConnected && (
            <span className="text-xs text-red-400 ml-2">(disconnected)</span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* New chat button */}
          <button
            onClick={() => createSession()}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-surface-800 transition-colors"
            title="New chat"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>

          {/* Status indicator */}
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                isStreaming ? 'bg-yellow-400 animate-pulse' : isConnected ? 'bg-green-400' : 'bg-red-400'
              }`}
            />
            <span className="text-xs text-slate-500 hidden sm:inline">
              {isStreaming ? 'Thinking...' : isConnected ? 'Ready' : 'Connecting...'}
            </span>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <WelcomeScreen />
        ) : (
          <>
            {messages.map((msg) => (
              <Message key={msg.id} message={msg} />
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-surface-800 bg-surface-900/80 backdrop-blur-sm p-3 shrink-0">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto">
          <div className="relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleResize}
              onKeyDown={handleKeyDown}
              placeholder={isStreaming ? 'Processing... (Esc to abort)' : 'Message π Agent...'}
              className="input pr-14"
              rows={1}
              disabled={isStreaming || !isConnected}
              style={{ maxHeight: '200px' }}
            />
            <div className="absolute right-2 bottom-2 flex items-center gap-1">
              {isStreaming ? (
                <button
                  type="button"
                  onClick={abort}
                  className="p-1.5 rounded-lg text-red-400 hover:bg-red-900/30 transition-colors"
                  title="Abort"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim() || !isConnected}
                  className="p-1.5 rounded-lg bg-accent text-white hover:bg-accent-dark disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5m0 0l-4 4m4-4l4 4" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </form>
        <p className="text-center text-[10px] text-slate-600 mt-2">
          π Agent runs locally on your Mac
        </p>
      </div>
    </div>
  );
}

function WelcomeScreen() {
  const suggestions = [
    { icon: '💰', text: 'Record a budget transaction' },
    { icon: '🎵', text: 'Help with my music career' },
    { icon: '📧', text: 'Check my inbox' },
    { icon: '🏠', text: 'Check my Wyze lights' },
  ];

  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-4">
      <div className="text-6xl mb-4 opacity-20 select-none">π</div>
      <h2 className="text-xl font-semibold text-slate-300 mb-2">
        How can I help?
      </h2>
      <p className="text-sm text-slate-500 max-w-md mb-8">
        Send a message to start a conversation. Switch between projects using the sidebar.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-lg">
        {suggestions.map((s) => (
          <WelcomeSuggestion key={s.text} {...s} />
        ))}
      </div>
    </div>
  );
}

function WelcomeSuggestion({ icon, text }: { icon: string; text: string }) {
  const { sendMessage } = usePiAgent();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  return (
    <button
      onClick={() => {
        sendMessage(text);
        inputRef.current?.focus();
      }}
      className="text-left p-3 bg-surface-800/50 border border-surface-700/50 rounded-xl text-sm text-slate-400 hover:bg-surface-800 hover:text-slate-300 transition-colors"
    >
      <span className="mr-2">{icon}</span>
      {text}
    </button>
  );
}
