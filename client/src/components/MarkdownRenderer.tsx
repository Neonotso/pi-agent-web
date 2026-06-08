import ReactMarkdown from 'react-markdown';
import { Children, isValidElement, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode, type UIEvent } from 'react';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export default function MarkdownRenderer({ content, className = '' }: MarkdownRendererProps) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const tableIndexRef = useRef(0);
  const tableScrollPositionsRef = useRef(new Map<string, number>());
  const contentRef = useRef<HTMLDivElement>(null);
  const selectionDragRef = useRef<{
    startRange: Range;
    startX: number;
    startY: number;
    selecting: boolean;
    pointerId: number;
  } | null>(null);
  const normalizedContent = normalizeMarkdownTables(content);
  tableIndexRef.current = 0;

  const handleCopy = async (code: string, key: string) => {
    await navigator.clipboard.writeText(code);
    setCopiedCode(key);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const handleSelectBlock = (event: MouseEvent<HTMLButtonElement>) => {
    const block = event.currentTarget.closest('.markdown-code-block')?.querySelector('pre');
    if (!block) return;

    const range = document.createRange();
    range.selectNodeContents(block);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const handleSelectionPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('button, input, textarea, select, summary')) return;

    const startRange = textRangeFromPoint(event.currentTarget, event.clientX, event.clientY);
    if (!startRange) return;

    selectionDragRef.current = {
      startRange,
      startX: event.clientX,
      startY: event.clientY,
      selecting: false,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleSelectionPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = selectionDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const hasMovedEnough = Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3;
    if (!hasMovedEnough) return;

    const root = contentRef.current || event.currentTarget;
    const endRange = textRangeFromPoint(root, event.clientX, event.clientY);
    if (!endRange) return;

    drag.selecting = true;
    event.preventDefault();
    event.stopPropagation();

    const range = createOrderedRange(drag.startRange, endRange);
    if (!range) return;

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const handleSelectionPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const drag = selectionDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.selecting) {
      event.preventDefault();
      event.stopPropagation();
    }
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    selectionDragRef.current = null;
  };

  return (
    <div
      ref={contentRef}
      className={`markdown-content ${className}`}
      onPointerDown={handleSelectionPointerDown}
      onPointerMove={handleSelectionPointerMove}
      onPointerUp={handleSelectionPointerUp}
      onPointerCancel={handleSelectionPointerUp}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Code blocks
          pre({ children, ...props }) {
            const codeText = extractText(children).replace(/\n$/, '');
            const key = codeText.slice(0, 40);
            return (
              <div className="markdown-code-block group">
                <div className="markdown-code-actions">
                  <button
                    type="button"
                    onClick={handleSelectBlock}
                    className="markdown-code-button"
                  >
                    Select
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopy(codeText, key)}
                    className="markdown-code-button"
                  >
                    {copiedCode === key ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <pre className="markdown-code-pre" {...props}>
                  {children}
                </pre>
              </div>
            );
          },
          code({ className, children, ...props }) {
            // Inline code (not in pre)
            const isBlock = className?.includes('language-') || className?.includes('language');
            if (isBlock) {
              return (
                <code className={`${className || ''} text-slate-100`} {...props}>
                  {children}
                </code>
              );
            }
            const codeText = extractText(children).trim();
            if (isLikelyUrl(codeText)) {
              return (
                <a
                  href={normalizeLinkHref(codeText)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="markdown-inline-code markdown-code-link"
                  onClick={(event) => event.stopPropagation()}
                  title="Open link"
                >
                  {children}
                </a>
              );
            }
            return (
              <code
                className="markdown-inline-code"
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
            const tableKey = `table-${tableIndexRef.current++}`;
            return (
              <ScrollableTable scrollKey={tableKey} scrollPositions={tableScrollPositionsRef.current}>
                <table className="markdown-table">
                  {children}
                </table>
              </ScrollableTable>
            );
          },
          th({ children }) {
            return (
              <th>
                {children}
              </th>
            );
          },
          td({ children }) {
            return <td>{children}</td>;
          },
          // Links
          a({ href, children }) {
            const safeHref = normalizeLinkHref(href);
            return (
              <a
                href={safeHref}
                target="_blank"
                rel="noopener noreferrer"
                className="markdown-link"
                onClick={(event) => {
                  event.stopPropagation();
                }}
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
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
}

function ScrollableTable({
  children,
  scrollKey,
  scrollPositions,
}: {
  children: ReactNode;
  scrollKey: string;
  scrollPositions: Map<string, number>;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const scrollLeft = scrollPositions.get(scrollKey);
    if (typeof scrollLeft === 'number') {
      element.scrollLeft = scrollLeft;
    }
  }, [children, scrollKey, scrollPositions]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    scrollPositions.set(scrollKey, event.currentTarget.scrollLeft);
  };

  return (
    <div ref={ref} className="markdown-table-wrap" onScroll={handleScroll}>
      {children}
    </div>
  );
}

function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractText(node.props.children);
  }
  return Children.toArray(node).map(extractText).join('');
}

function normalizeMarkdownTables(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      if (!looksLikeFlattenedTable(line)) return line;
      return splitFlattenedTable(line).join('\n');
    })
    .join('\n');
}

function looksLikeFlattenedTable(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|')
    && trimmed.includes('|---')
    && (trimmed.match(/\|\s*\|/g)?.length || 0) >= 2;
}

function splitFlattenedTable(line: string): string[] {
  const rows = line.trim().replace(/(?<=.)\|\s+(?=\|)/g, '|\n').split('\n').map((row) => row.trim());
  return rows.length >= 3 ? rows : [line];
}

function normalizeLinkHref(href?: string) {
  if (!href) return '#';
  if (/^(https?:|mailto:|tel:)/i.test(href)) return href;
  if (/^www\./i.test(href)) return `https://${href}`;
  return href;
}

function isLikelyUrl(value: string) {
  return /^(https?:\/\/|www\.)[^\s<>"']+$/i.test(value);
}

function createOrderedRange(startRange: Range, endRange: Range): Range | null {
  const startContainer = startRange.startContainer;
  const startOffset = startRange.startOffset;
  const endContainer = endRange.startContainer;
  const endOffset = endRange.startOffset;
  const isReversed = startRange.compareBoundaryPoints(Range.START_TO_START, endRange) > 0;

  const range = document.createRange();
  try {
    if (isReversed) {
      range.setStart(endContainer, endOffset);
      range.setEnd(startContainer, startOffset);
    } else {
      range.setStart(startContainer, startOffset);
      range.setEnd(endContainer, endOffset);
    }
    return range;
  } catch {
    return null;
  }
}

function textRangeFromPoint(root: HTMLElement, x: number, y: number): Range | null {
  const directRange = browserTextRangeFromPoint(root, x, y);
  const textNodes = collectSelectableTextNodes(root);
  let best: { range: Range; score: number } | null = null;

  for (const node of textNodes) {
    const match = closestCaretInTextNode(node, x, y);
    if (!match) continue;
    if (!best || match.score < best.score) best = match;
  }

  return best?.range || directRange || null;
}

function browserTextRangeFromPoint(root: HTMLElement, x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };

  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    if (range && root.contains(range.startContainer.parentElement)) return range;
  }

  if (typeof doc.caretPositionFromPoint === 'function') {
    const position = doc.caretPositionFromPoint(x, y);
    if (!position || !root.contains(position.offsetNode.parentElement)) return null;
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }

  return null;
}

function collectSelectableTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent || node.textContent.length === 0) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('button, input, textarea, select, summary, .markdown-code-actions')) {
        return NodeFilter.FILTER_REJECT;
      }
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  return nodes;
}

function closestCaretInTextNode(node: Text, x: number, y: number): { range: Range; score: number } | null {
  const text = node.nodeValue || '';
  if (text.length === 0) return null;

  const fullRange = document.createRange();
  fullRange.selectNodeContents(node);
  const fullRects = Array.from(fullRange.getClientRects());
  fullRange.detach?.();
  if (!fullRects.length) return null;

  const nodeScore = Math.min(...fullRects.map((rect) => rectDistanceScore(rect, x, y)));
  if (nodeScore > 8000) return null;

  let best: { offset: number; score: number } | null = null;
  for (let offset = 0; offset <= text.length; offset += 1) {
    const rect = caretRectForOffset(node, offset);
    if (!rect) continue;
    const score = rectDistanceScore(rect, x, y);
    if (!best || score < best.score) best = { offset, score };
  }

  if (!best) return null;
  const range = document.createRange();
  range.setStart(node, best.offset);
  range.collapse(true);
  return { range, score: best.score };
}

function caretRectForOffset(node: Text, offset: number): DOMRect | null {
  const collapsed = document.createRange();
  collapsed.setStart(node, offset);
  collapsed.collapse(true);
  const collapsedRect = firstUsefulRect(collapsed);
  collapsed.detach?.();
  if (collapsedRect) return collapsedRect;

  if (offset > 0) {
    const previous = document.createRange();
    previous.setStart(node, offset - 1);
    previous.setEnd(node, offset);
    const rect = lastUsefulRect(previous);
    previous.detach?.();
    if (rect) return new DOMRect(rect.right, rect.top, 0, rect.height);
  }

  if (offset < (node.nodeValue || '').length) {
    const next = document.createRange();
    next.setStart(node, offset);
    next.setEnd(node, offset + 1);
    const rect = firstUsefulRect(next);
    next.detach?.();
    if (rect) return new DOMRect(rect.left, rect.top, 0, rect.height);
  }

  return null;
}

function firstUsefulRect(range: Range): DOMRect | null {
  return Array.from(range.getClientRects()).find((rect) => rect.height > 0) || null;
}

function lastUsefulRect(range: Range): DOMRect | null {
  return Array.from(range.getClientRects()).reverse().find((rect) => rect.height > 0) || null;
}

function rectDistanceScore(rect: DOMRect, x: number, y: number) {
  const verticalDistance = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
  const horizontalDistance = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
  return verticalDistance * 100 + horizontalDistance;
}
