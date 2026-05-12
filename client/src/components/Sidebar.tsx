import { useState, useCallback, useRef, useEffect } from 'react';
import { usePiAgent } from '../contexts/PiAgentContext';

interface SidebarProps {
  onClose: () => void;
}

export default function Sidebar({ onClose }: SidebarProps) {
  const { sessions, currentSessionId, createSession, switchSession, deleteSession } = usePiAgent();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renamingId]);

  const handleNewSession = useCallback(() => {
    createSession('New Chat');
    onClose();
  }, [createSession, onClose]);

  const handleSelect = useCallback(
    (session: { id: string; name: string }) => {
      switchSession(session.id);
      onClose();
    },
    [switchSession, onClose]
  );

  const handleRename = useCallback(
    (id: string) => {
      if (renameValue.trim()) {
        // Session rename would need an API endpoint
        console.log('Rename not yet implemented for', id);
      }
      setRenamingId(null);
      setRenameValue('');
    },
    [renameValue]
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent, session: { id: string }) => {
      e.stopPropagation();
      if (sessions.length > 1 || confirm('Delete this chat?')) {
        deleteSession(session.id);
      }
    },
    [deleteSession, sessions.length]
  );

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={onClose} />

      <aside className="fixed lg:relative inset-y-0 left-0 z-50 w-72 bg-surface-900 border-r border-surface-800 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-surface-800">
          <div className="flex items-center gap-2">
            <span className="text-accent font-bold text-lg">π</span>
            <span className="font-semibold text-slate-200">Agent</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-surface-800 transition-colors lg:hidden"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* New Chat */}
        <div className="p-3">
          <button
            onClick={handleNewSession}
            className="w-full btn btn-primary justify-center"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Chat
          </button>
        </div>

        {/* Sessions */}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-600 font-semibold px-3 py-2">
            Chats
          </div>

          {sessions.length === 0 && (
            <div className="text-center py-6 text-sm text-slate-500">
              No chats yet
            </div>
          )}

          {sessions.map((session) => (
            <div
              key={session.id}
              className={`sidebar-item ${session.id === currentSessionId ? 'active' : ''}`}
              onClick={() => handleSelect(session)}
            >
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>

              {renamingId === session.id ? (
                <input
                  ref={inputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => handleRename(session.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename(session.id);
                    if (e.key === 'Escape') {
                      setRenamingId(null);
                      setRenameValue('');
                    }
                  }}
                  className="flex-1 bg-surface-800 border border-accent/50 rounded px-1.5 py-0.5 text-sm text-white outline-none min-w-0"
                />
              ) : (
                <span className="flex-1 truncate">{session.name}</span>
              )}

              {/* Hover actions */}
              <div className="sidebar-delete absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 transition-opacity">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingId(session.id);
                    setRenameValue(session.name);
                  }}
                  className="p-0.5 rounded hover:bg-surface-700 text-slate-400 hover:text-white"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
                <button
                  onClick={(e) => handleDelete(e, session)}
                  className="p-0.5 rounded hover:bg-red-900/30 text-slate-400 hover:text-red-400"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-surface-800 text-[10px] text-slate-600 text-center">
          π Agent v0.1.0
        </div>
      </aside>
    </>
  );
}
