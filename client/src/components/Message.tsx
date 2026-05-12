import MarkdownRenderer from './MarkdownRenderer';
import { ChatMessage } from '../types';

interface MessageProps {
  message: ChatMessage;
}

export default function Message({ message }: MessageProps) {
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const isError = message.role === 'error';
  const isStreaming = message.isStreaming;

  if (isTool) {
    return (
      <div className="flex flex-col items-center my-1">
        <div className="message-tool flex items-center gap-2 py-2 px-3 text-xs">
          <span className="text-yellow-400">⚡</span>
          <span className="text-slate-400 font-mono">
            {message.toolName || 'tool'}
          </span>
          {message.output && (
            <span className="text-slate-600 truncate max-w-[200px]">
              → {message.output.slice(0, 80)}
              {message.output.length > 80 ? '...' : ''}
            </span>
          )}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex justify-center my-2">
        <div className="bg-red-900/30 border border-red-800/50 rounded-xl px-4 py-2 text-sm text-red-300 max-w-[90%] text-center">
          ⚠️ {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3 animate-fade-in`}>
      <div className={`message-bubble ${isUser ? 'message-user' : 'message-assistant'} ${isStreaming ? 'border-accent/30' : ''}`}>
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">
            {message.content}
          </p>
        ) : (
          <div className="text-sm leading-relaxed">
            <MarkdownRenderer content={message.content} />
            {isStreaming && (
              <span className="inline-block w-2 h-4 bg-accent ml-1 animate-pulse" />
            )}
          </div>
        )}
        <div className={`text-[10px] text-slate-500 mt-1 ${isUser ? 'text-right' : 'text-left'}`}>
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {isStreaming && ' · typing...'}
        </div>
      </div>
    </div>
  );
}
