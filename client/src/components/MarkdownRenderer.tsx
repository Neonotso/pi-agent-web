import ReactMarkdown from 'react-markdown';
import { useState } from 'react';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export default function MarkdownRenderer({ content, className = '' }: MarkdownRendererProps) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const handleCopy = (code: string, key: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(key);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  return (
    <div className={className}>
      <ReactMarkdown
        components={{
          // Code blocks
          pre({ children, ...props }) {
            const key = Math.random().toString(36).slice(2);
            const codeText = children?.toString() || '';
            return (
              <div className="relative group my-3">
                <button
                  onClick={() => handleCopy(codeText, key)}
                  className="absolute top-2 right-2 px-2 py-1 text-xs bg-surface-700 text-slate-300 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  {copiedCode === key ? 'Copied!' : 'Copy'}
                </button>
                <pre className="bg-surface-900 rounded-lg p-4 overflow-x-auto text-sm font-mono border border-surface-800">
                  {children}
                </pre>
              </div>
            );
          },
          code({ className, children, ...props }) {
            // Inline code (not in pre)
            const isBlock = className?.includes('language-') || className?.includes('language');
            if (isBlock) return null; // Handled by pre
            return (
              <code
                className="bg-surface-800 px-1.5 py-0.5 rounded text-sm font-mono text-accent-light"
                {...props}
              >
                {children}
              </code>
            );
          },
          // Lists
          ul({ children }) {
            return <ul className="list-disc list-inside ml-2 space-y-1 my-2">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="list-decimal list-inside ml-2 space-y-1 my-2">{children}</ol>;
          },
          li({ children }) {
            return <li className="ml-2">{children}</li>;
          },
          // Tables
          table({ children }) {
            return (
              <div className="overflow-x-auto my-3">
                <table className="min-w-full border-collapse border border-surface-700 text-sm">
                  {children}
                </table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th className="border border-surface-700 px-3 py-2 bg-surface-800 font-semibold text-left">
                {children}
              </th>
            );
          },
          td({ children }) {
            return <td className="border border-surface-700 px-3 py-2">{children}</td>;
          },
          // Links
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-light underline hover:text-accent"
              >
                {children}
              </a>
            );
          },
          // Headings
          h1({ children }) {
            return <h1 className="text-lg font-bold mt-4 mb-2 text-white">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="text-base font-bold mt-3 mb-1.5 text-white">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="text-sm font-bold mt-2 mb-1 text-white">{children}</h3>;
          },
          // Blockquotes
          blockquote({ children }) {
            return (
              <blockquote className="border-l-4 border-surface-600 pl-4 my-2 text-slate-400 italic">
                {children}
              </blockquote>
            );
          },
          // Horizontal rules
          hr() {
            return <hr className="border-surface-700 my-4" />;
          },
          // Paragraphs
          p({ children }) {
            return <p className="my-1.5 leading-relaxed">{children}</p>;
          },
          // Strong
          strong({ children }) {
            return <strong className="font-semibold text-white">{children}</strong>;
          },
          // Em
          em({ children }) {
            return <em className="italic">{children}</em>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
