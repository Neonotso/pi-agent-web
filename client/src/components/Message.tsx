import { useState } from 'react';
import MarkdownRenderer from './MarkdownRenderer';
import type { ChatMessage, MessageAttachment } from '../types';
import { useSettings } from '../contexts/SettingsContext';

interface MessageProps {
  message: ChatMessage;
}

function displayText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function formatFileSize(size?: number) {
  if (typeof size !== 'number' || !Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentPreview({ attachment, align }: { attachment: MessageAttachment; align: 'left' | 'right' }) {
  const src = attachment.dataUrl || attachment.url;
  const isImage = attachment.mimeType.startsWith('image/') && src;
  const size = formatFileSize(attachment.size);

  if (isImage) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className={`message-attachment-image ${align === 'right' ? 'ml-auto' : ''}`}
        title={attachment.name}
      >
        <img src={src} alt={attachment.name} loading="lazy" />
        <span>{attachment.name}</span>
      </a>
    );
  }

  return (
    <a
      href={attachment.url || attachment.dataUrl || '#'}
      target={attachment.url || attachment.dataUrl ? '_blank' : undefined}
      rel="noreferrer"
      className={`message-attachment-file ${align === 'right' ? 'ml-auto' : ''}`}
      title={attachment.name}
    >
      <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 3v5h5" />
      </svg>
      <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
      {size && <span className="shrink-0 text-slate-500">{size}</span>}
    </a>
  );
}

export default function Message({ message }: MessageProps) {
  const { settings } = useSettings();
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const isError = message.role === 'error';
  const isStreaming = message.isStreaming;
  const content = displayText(message.content);
  const thinking = displayText(message.thinking);
  const canCopy = !isTool && !isError && content.trim().length > 0;
  const attachments = message.attachments || [];

  const handleCopy = async () => {
    if (!content.trim()) return;
    try {
      await copyText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      console.error('[Message] Copy failed:', error);
    }
  };

  if (isTool) {
    const detail = displayText(message.detail).trim();
    const rawOutput = displayText(message.output);
    const preview = detail || rawOutput.trim() || '(no output)';
    return (
      <div className="flex flex-col items-center my-1">
        <details className="message-tool group" open={settings.showToolDetailsByDefault}>
          <summary className="tool-summary">
            <span className="text-yellow-400">⚡</span>
            <span className="text-slate-400 font-mono">
              {message.toolName || 'tool'}
            </span>
            <span className="tool-preview">
              → {preview.slice(0, 120)}
              {preview.length > 120 ? '...' : ''}
            </span>
          </summary>
          {detail && (
            <div className="tool-detail">
              <div className="tool-detail-label">Command</div>
              <pre>{detail}</pre>
            </div>
          )}
          <div className="tool-output-wrap">
            <div className="tool-detail-label">Output</div>
            <pre className="tool-output">{rawOutput || '(no output)'}</pre>
          </div>
        </details>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex justify-center my-2">
        <div className="bg-red-900/30 border border-red-800/50 rounded-xl px-4 py-2 text-sm text-red-300 max-w-[90%] text-center">
          ⚠️ {content}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3 animate-fade-in`}>
      <div className={`message-bubble ${isUser ? 'message-user' : 'message-assistant'} ${isStreaming ? 'border-accent/30' : ''}`}>
        {canCopy && (
          <button
            type="button"
            onClick={handleCopy}
            onMouseDown={(event) => event.preventDefault()}
            className="message-copy-button"
            aria-label={copied ? 'Copied message' : 'Copy message'}
            title={copied ? 'Copied' : 'Copy message'}
          >
            {copied ? (
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 8h10v12H8z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 16H5a1 1 0 01-1-1V5a1 1 0 011-1h10a1 1 0 011 1v1" />
              </svg>
            )}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        )}
        {isUser ? (
          <>
            {content.trim() && (
              <p className="message-text text-sm whitespace-pre-wrap break-words leading-relaxed">
                {content}
              </p>
            )}
            {attachments.length > 0 && (
              <div className="message-attachments justify-end">
                {attachments.map((attachment) => (
                  <AttachmentPreview key={attachment.id} attachment={attachment} align="right" />
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="message-text text-sm leading-relaxed">
            {thinking && (
              <details className="thinking-panel" open={settings.showThinkingByDefault}>
                <summary>Thinking</summary>
                <div className="thinking-content">
                  {thinking}
                </div>
              </details>
            )}
            <MarkdownRenderer content={content} />
            {attachments.length > 0 && (
              <div className="message-attachments justify-start">
                {attachments.map((attachment) => (
                  <AttachmentPreview key={attachment.id} attachment={attachment} align="left" />
                ))}
              </div>
            )}
            {isStreaming && (
              <span className="inline-block w-2 h-4 bg-accent ml-1 animate-pulse" />
            )}
          </div>
        )}
        <div className={`text-[10px] text-slate-500 mt-1 ${isUser ? 'text-right' : 'text-left'}`}>
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {typeof message.speedTokensPerSecond === 'number' && (
            <> · visible ~{message.speedTokensPerSecond.toFixed(1)} tok/s</>
          )}
          {typeof message.modelTokensPerSecond === 'number' && (
            <> · model {message.modelTokensPerSecond.toFixed(1)} tok/s</>
          )}
          {isStreaming && ' · typing...'}
          {message.stopped && ' · stopped'}
        </div>
      </div>
    </div>
  );
}
