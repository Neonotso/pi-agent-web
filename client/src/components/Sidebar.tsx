import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { usePiAgent, type AgentProfile } from '../contexts/PiAgentContext';
import { useSettings } from '../contexts/SettingsContext';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
  const {
    sessions,
    projects,
    defaultProjectId,
    activeSessionId,
    collapsedProjectIds,
    unreadSessionIds,
    createSession,
    switchSession,
    setCollapsedProjectIds,
    deleteSession,
    renameSession,
    createProject,
    renameProject,
    deleteProject,
    moveSession,
    models,
    agentProfiles,
    agentExtensions,
    agentSkills,
    selectedAgentProfileId,
    setSelectedAgentProfileId,
    saveAgentProfile,
    deleteAgentProfile,
  } = usePiAgent();
  const { settings, updateSettings } = useSettings();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'agents'>('general');
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [profileDraft, setProfileDraft] = useState<Partial<AgentProfile> | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [projectRenameValue, setProjectRenameValue] = useState('');
  const [newProjectValue, setNewProjectValue] = useState('');
  const [refreshingApp, setRefreshingApp] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);

  const sessionsByProject = useMemo(() => {
    const grouped = new Map<string, typeof sessions>();
    for (const project of projects) grouped.set(project.id, []);
    for (const session of sessions) {
      if (session.isQuick) continue;
      const projectId = session.projectId && grouped.has(session.projectId) ? session.projectId : defaultProjectId;
      grouped.set(projectId, [...(grouped.get(projectId) || []), session]);
    }
    return grouped;
  }, [defaultProjectId, projects, sessions]);

  const quickSessions = useMemo(() => sessions.filter((session) => session.isQuick), [sessions]);
  const selectedProfile = useMemo(
    () => agentProfiles.find((profile) => profile.id === selectedProfileId) || agentProfiles[0] || null,
    [agentProfiles, selectedProfileId],
  );
  const draftExtensionIds = new Set(profileDraft?.extensionIds || []);
  const draftSkillIds = new Set(profileDraft?.skillIds || []);

  const toggleProject = useCallback((projectId: string) => {
    const next = new Set(collapsedProjectIds);
    if (next.has(projectId)) next.delete(projectId);
    else next.add(projectId);
    setCollapsedProjectIds(next);
  }, [collapsedProjectIds, setCollapsedProjectIds]);

  const startRename = useCallback((session: typeof sessions[0]) => {
    setRenamingId(session.id);
    setRenameValue(session.name);
  }, []);

  useEffect(() => {
    if (renamingId) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (renamingProjectId) {
      projectInputRef.current?.focus();
      projectInputRef.current?.select();
    }
  }, [renamingProjectId]);

  useEffect(() => {
    if (!settingsOpen || agentProfiles.length === 0) return;
    if (!selectedProfileId || !agentProfiles.some((profile) => profile.id === selectedProfileId)) {
      setSelectedProfileId(agentProfiles[0].id);
    }
  }, [agentProfiles, selectedProfileId, settingsOpen]);

  useEffect(() => {
    if (!selectedProfile) {
      setProfileDraft(null);
      return;
    }
    setProfileDraft({
      ...selectedProfile,
      extensionIds: [...selectedProfile.extensionIds],
      skillIds: [...selectedProfile.skillIds],
    });
  }, [selectedProfile]);

  const finishRename = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      renameSession(renamingId, renameValue.trim());
    }
    setRenamingId(null);
    setRenameValue('');
  }, [renamingId, renameValue, renameSession]);

  const startProjectRename = useCallback((project: typeof projects[0]) => {
    if (project.id === defaultProjectId) return;
    setRenamingProjectId(project.id);
    setProjectRenameValue(project.name);
  }, [defaultProjectId]);

  const finishProjectRename = useCallback(() => {
    if (renamingProjectId && projectRenameValue.trim()) {
      renameProject(renamingProjectId, projectRenameValue.trim());
    }
    setRenamingProjectId(null);
    setProjectRenameValue('');
  }, [projectRenameValue, renameProject, renamingProjectId]);

  const handleCreateProject = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const name = newProjectValue.trim();
    if (!name) return;
    createProject(name);
    setNewProjectValue('');
  }, [createProject, newProjectValue]);

  const handleDelete = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (confirm('Delete this chat?')) {
      deleteSession(id);
    }
  }, [deleteSession]);

  const handleDeleteProject = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (id === defaultProjectId) return;
    const count = sessions.filter((session) => session.projectId === id).length;
    const message = count > 0
      ? `Delete this project folder? Its ${count} chat${count !== 1 ? 's' : ''} will move to Inbox.`
      : 'Delete this project folder?';
    if (confirm(message)) deleteProject(id);
  }, [defaultProjectId, deleteProject, sessions]);

  const handleSessionClick = useCallback((sessionId: string) => {
    if (renamingId === sessionId) return;
    switchSession(sessionId);
    onClose();
  }, [onClose, renamingId, switchSession]);

  const hardRefreshApp = useCallback(async () => {
    if (refreshingApp) return;
    setRefreshingApp(true);

    try {
      if ('caches' in window) {
        const cacheKeys = await caches.keys();
        await Promise.all(cacheKeys.map((key) => caches.delete(key)));
      }

      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      }
    } catch (error) {
      console.warn('[Settings] Hard refresh cleanup failed:', error);
    } finally {
      const url = new URL(window.location.href);
      url.searchParams.set('fresh', Date.now().toString());
      window.location.replace(url.toString());
    }
  }, [refreshingApp]);

  const updateProfileDraft = useCallback((patch: Partial<AgentProfile>) => {
    setProfileDraft(prev => ({ ...(prev || {}), ...patch }));
  }, []);

  const toggleDraftListValue = useCallback((field: 'extensionIds' | 'skillIds', id: string) => {
    setProfileDraft(prev => {
      const current = new Set(prev?.[field] || []);
      if (current.has(id)) current.delete(id);
      else current.add(id);
      return { ...(prev || {}), [field]: Array.from(current) };
    });
  }, []);

  const createAgentProfile = useCallback(() => {
    const modelId = models.find((model) => model.id === 'qwen-35b-mtp')?.id || models[0]?.id || 'qwen-35b-mtp';
    saveAgentProfile({
      name: 'New Agent',
      modelId,
      extensionIds: [],
      skillIds: [],
      instructions: '',
    });
  }, [models, saveAgentProfile]);

  const saveCurrentProfile = useCallback(() => {
    if (!profileDraft) return;
    saveAgentProfile({
      ...profileDraft,
      name: (profileDraft.name || 'New Agent').trim(),
      modelId: profileDraft.modelId || models[0]?.id || 'qwen-35b-mtp',
      extensionIds: profileDraft.extensionIds || [],
      skillIds: profileDraft.skillIds || [],
      instructions: profileDraft.instructions || '',
    });
  }, [models, profileDraft, saveAgentProfile]);

  const deleteCurrentProfile = useCallback(() => {
    if (!selectedProfile || agentProfiles.length <= 1) return;
    if (confirm(`Delete the ${selectedProfile.name} profile?`)) {
      deleteAgentProfile(selectedProfile.id);
    }
  }, [agentProfiles.length, deleteAgentProfile, selectedProfile]);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity lg:hidden ${isOpen ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        onClick={onClose}
      />
      <aside className={`mobile-sidebar fixed lg:relative left-0 z-50 w-80 max-w-[88vw] lg:w-96 bg-surface-900 border-r border-surface-800 flex flex-col transition-transform duration-200 lg:translate-x-0 ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-surface-800">
          <div className="flex items-center gap-2">
            <span className="text-accent font-bold text-lg">π</span>
            <span className="font-semibold text-slate-200">Agent</span>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-surface-800 transition-colors lg:hidden">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* New Chat / Project */}
        <div className="p-3 space-y-2">
          {agentProfiles.length > 0 && (
            <select
              value={selectedAgentProfileId}
              onChange={(event) => setSelectedAgentProfileId(event.target.value)}
              className="w-full rounded-lg border border-surface-700 bg-surface-800/50 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-accent/50"
              title="Agent profile for new chats"
            >
              {agentProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
            </select>
          )}
          <button onClick={() => { createSession('Quick Chat', defaultProjectId, { isQuick: true }); onClose(); }} className="w-full btn btn-primary justify-center">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Quick Chat
          </button>
          <form onSubmit={handleCreateProject} className="flex items-center gap-1.5">
            <input
              value={newProjectValue}
              onChange={(e) => setNewProjectValue(e.target.value)}
              placeholder="New project folder"
              className="min-w-0 flex-1 rounded-lg border border-surface-700 bg-surface-800/50 px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 outline-none focus:border-accent/50"
            />
            <button type="submit" className="rounded-lg bg-surface-800 px-2 py-1.5 text-xs text-slate-300 hover:bg-surface-700" aria-label="Create project">
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </form>
        </div>

        {/* Projects / Sessions */}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-600 font-semibold px-3 py-2">Quick Chat</div>
          {quickSessions.length === 0 ? (
            <button
              type="button"
              onClick={() => { createSession('Quick Chat', defaultProjectId, { isQuick: true }); onClose(); }}
              className="mx-2 mb-3 flex w-[calc(100%-1rem)] items-center gap-2 rounded-lg border border-dashed border-surface-700 px-3 py-2 text-left text-xs text-slate-500 hover:border-surface-600 hover:bg-surface-800/40 hover:text-slate-300"
            >
              <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Start a one-off chat
            </button>
          ) : (
            <div className="mb-3">
              {quickSessions.map((session) => (
                <div
                  key={session.id}
                  className={`sidebar-item ${session.id === activeSessionId ? 'active' : ''}`}
                  onClick={() => handleSessionClick(session.id)}
                >
                  <div className="flex items-start gap-2 flex-1 min-w-0">
                    <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                    </svg>
                    {unreadSessionIds.has(session.id) && (
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent shadow-[0_0_10px_rgba(99,102,241,0.85)]" aria-label="Unread messages" />
                    )}

                    {renamingId === session.id ? (
                      <input
                        ref={inputRef}
                        value={renameValue}
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={finishRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') finishRename();
                          if (e.key === 'Escape') { setRenamingId(null); setRenameValue(''); }
                        }}
                        className="flex-1 bg-surface-800 border border-accent/50 rounded px-1.5 py-0.5 text-sm text-white outline-none min-w-0"
                      />
                    ) : (
                      <span className="session-title">{session.name}</span>
                    )}
                  </div>

                  <div className="sidebar-delete flex items-center gap-0.5 opacity-100 lg:opacity-0 transition-opacity shrink-0">
                    <button onClick={(e) => { e.stopPropagation(); moveSession(session.id, defaultProjectId); }} className="p-1 rounded hover:bg-surface-700 text-slate-400 hover:text-white" aria-label="Save quick chat to Inbox" title="Save to Inbox">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                      </svg>
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); startRename(session); }} className="p-1 rounded hover:bg-surface-700 text-slate-400 hover:text-white" aria-label="Rename chat">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                      </svg>
                    </button>
                    <button onClick={(e) => handleDelete(e, session.id)} className="p-1 rounded hover:bg-red-900/30 text-slate-400 hover:text-red-400" aria-label="Delete chat">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="text-[10px] uppercase tracking-wider text-slate-600 font-semibold px-3 py-2">Projects</div>
          {sessions.length === 0 && (
            <div className="text-center py-6 text-sm text-slate-500">No chats yet</div>
          )}
          {projects.map((project) => {
            const projectSessions = sessionsByProject.get(project.id) || [];
            const isCollapsed = collapsedProjectIds.has(project.id);
            const unreadCount = projectSessions.filter((session) => unreadSessionIds.has(session.id)).length;
            return (
              <div key={project.id} className="mb-2">
                <div className="group flex items-center gap-2 px-2 py-1.5 text-xs font-semibold text-slate-500">
                  <button
                    type="button"
                    onClick={() => toggleProject(project.id)}
                    className="rounded p-1 text-slate-500 hover:bg-surface-800 hover:text-slate-300"
                    aria-label={isCollapsed ? `Expand ${project.name}` : `Collapse ${project.name}`}
                  >
                    <svg className={`h-3 w-3 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  <svg className="h-4 w-4 shrink-0 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                  </svg>
                  {renamingProjectId === project.id ? (
                    <input
                      ref={projectInputRef}
                      value={projectRenameValue}
                      onChange={(e) => setProjectRenameValue(e.target.value)}
                      onBlur={finishProjectRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') finishProjectRename();
                        if (e.key === 'Escape') { setRenamingProjectId(null); setProjectRenameValue(''); }
                      }}
                      className="min-w-0 flex-1 rounded border border-accent/50 bg-surface-800 px-1.5 py-0.5 text-xs text-white outline-none"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  )}
                  {unreadCount > 0 && (
                    <span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent-light">{unreadCount}</span>
                  )}
                  <span className="text-[10px] text-slate-700">{projectSessions.length}</span>
                  <button onClick={() => { createSession(undefined, project.id); onClose(); }} className="rounded p-1 text-slate-500 hover:bg-surface-800 hover:text-slate-300" aria-label={`New chat in ${project.name}`}>
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                  </button>
                  {project.id !== defaultProjectId && (
                    <>
                      <button onClick={() => startProjectRename(project)} className="rounded p-1 text-slate-500 hover:bg-surface-800 hover:text-slate-300" aria-label="Rename project">
                        <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536M4 20h4l10.5-10.5a2.5 2.5 0 10-3.536-3.536L4 16.5V20z" />
                        </svg>
                      </button>
                      <button onClick={(e) => handleDeleteProject(e, project.id)} className="rounded p-1 text-slate-500 hover:bg-red-900/30 hover:text-red-400" aria-label="Delete project">
                        <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 7h12m-9 0V5a1 1 0 011-1h4a1 1 0 011 1v2m-7 4v6m4-6v6m-8-10l1 14h10l1-14" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>

                {isCollapsed ? null : projectSessions.length === 0 ? (
                  <div className="px-8 py-1 text-xs text-slate-700">No chats</div>
                ) : (
                  projectSessions.map((session) => (
                    <div
                      key={session.id}
                      className={`sidebar-item ml-2 ${session.id === activeSessionId ? 'active' : ''}`}
                      onClick={() => handleSessionClick(session.id)}
                    >
                      <div className="flex items-start gap-2 flex-1 min-w-0">
                        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                        </svg>
                        {unreadSessionIds.has(session.id) && (
                          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent shadow-[0_0_10px_rgba(99,102,241,0.85)]" aria-label="Unread messages" />
                        )}

                        {renamingId === session.id ? (
                          <input
                            ref={inputRef}
                            value={renameValue}
                            onClick={(e) => e.stopPropagation()}
                            onPointerDown={(e) => e.stopPropagation()}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={finishRename}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') finishRename();
                              if (e.key === 'Escape') { setRenamingId(null); setRenameValue(''); }
                            }}
                            className="flex-1 bg-surface-800 border border-accent/50 rounded px-1.5 py-0.5 text-sm text-white outline-none min-w-0"
                          />
                        ) : (
                          <span className="session-title">{session.name}</span>
                        )}
                      </div>

                      <div className="sidebar-delete flex items-center gap-0.5 opacity-100 lg:opacity-0 transition-opacity shrink-0">
                        <button onClick={(e) => { e.stopPropagation(); startRename(session); }} className="p-1 rounded hover:bg-surface-700 text-slate-400 hover:text-white" aria-label="Rename chat">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                          </svg>
                        </button>
                        <button onClick={(e) => handleDelete(e, session.id)} className="p-1 rounded hover:bg-red-900/30 text-slate-400 hover:text-red-400" aria-label="Delete chat">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                        <select
                          value={session.projectId || defaultProjectId}
                          onClick={(e) => e.stopPropagation()}
                          onPointerDown={(e) => e.stopPropagation()}
                          onChange={(e) => moveSession(session.id, e.target.value)}
                          className="rounded border border-surface-700 bg-surface-900 px-1 py-0.5 text-[10px] text-slate-400 outline-none"
                          aria-label="Move chat"
                          title="Move chat"
                        >
                          {projects.map((project) => (
                            <option key={project.id} value={project.id}>{project.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-surface-800">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="mb-2 flex w-full items-center justify-center gap-2 rounded-lg border border-surface-800 bg-surface-900 px-3 py-2 text-xs text-slate-300 hover:border-surface-700 hover:bg-surface-800"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.757.426 1.757 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.757-2.924 1.757-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.757-.426-1.757-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.607 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Settings
          </button>
          <div className="text-center text-[10px] text-slate-600">
            π Agent v0.3.5-delete-sync · {sessions.length} session{sessions.length !== 1 ? 's' : ''}
          </div>
        </div>
      </aside>
      {settingsOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 px-4" onClick={() => setSettingsOpen(false)}>
          <div className="max-h-[88vh] w-full max-w-4xl overflow-hidden rounded-xl border border-surface-700 bg-surface-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="px-4 pt-4 text-sm font-semibold text-slate-100">Settings</h2>
              <button type="button" onClick={() => setSettingsOpen(false)} className="rounded-lg p-1 text-slate-400 hover:bg-surface-800 hover:text-white" aria-label="Close settings">
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="border-b border-surface-800 px-4">
              <div className="flex gap-1">
                <button type="button" onClick={() => setSettingsTab('general')} className={`settings-tab ${settingsTab === 'general' ? 'active' : ''}`}>
                  General
                </button>
                <button type="button" onClick={() => setSettingsTab('agents')} className={`settings-tab ${settingsTab === 'agents' ? 'active' : ''}`}>
                  Agent Profiles
                </button>
              </div>
            </div>
            <div className="max-h-[72vh] overflow-y-auto p-4">
              {settingsTab === 'general' ? (
                <>
                  <label className="settings-row">
                    <span>
                      <span className="settings-title">Show thinking by default</span>
                      <span className="settings-description">Assistant reasoning panels start expanded.</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={settings.showThinkingByDefault}
                      onChange={(e) => updateSettings({ showThinkingByDefault: e.target.checked })}
                    />
                  </label>
                  <label className="settings-row">
                    <span>
                      <span className="settings-title">Show tool details by default</span>
                      <span className="settings-description">Tool commands and output start expanded.</span>
                    </span>
                    <input
                      type="checkbox"
                      checked={settings.showToolDetailsByDefault}
                      onChange={(e) => updateSettings({ showToolDetailsByDefault: e.target.checked })}
                    />
                  </label>
                  <div className="settings-row">
                    <span>
                      <span className="settings-title">Refresh app from server</span>
                      <span className="settings-description">Clears browser app caches and reloads the newest UI.</span>
                    </span>
                    <button
                      type="button"
                      onClick={hardRefreshApp}
                      disabled={refreshingApp}
                      className="settings-action-button"
                    >
                      {refreshingApp ? 'Refreshing...' : 'Refresh'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
                  <div className="space-y-2">
                    <button type="button" onClick={createAgentProfile} className="settings-action-button w-full">
                      New Profile
                    </button>
                    <div className="space-y-1">
                      {agentProfiles.map((profile) => {
                        const model = models.find((item) => item.id === profile.modelId);
                        return (
                          <button
                            key={profile.id}
                            type="button"
                            onClick={() => setSelectedProfileId(profile.id)}
                            className={`agent-profile-list-item ${profile.id === selectedProfileId ? 'active' : ''}`}
                          >
                            <span className="block truncate text-sm font-medium">{profile.name}</span>
                            <span className="block truncate text-[11px] text-slate-500">{model?.label || profile.modelId}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {profileDraft ? (
                    <div className="space-y-4">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="settings-field">
                          <span className="settings-title">Name</span>
                          <input
                            value={profileDraft.name || ''}
                            onChange={(e) => updateProfileDraft({ name: e.target.value })}
                            className="settings-input"
                          />
                        </label>
                        <label className="settings-field">
                          <span className="settings-title">Model</span>
                          <select
                            value={profileDraft.modelId || models[0]?.id || ''}
                            onChange={(e) => updateProfileDraft({ modelId: e.target.value })}
                            className="settings-input"
                          >
                            {models.map((model) => (
                              <option key={model.id} value={model.id}>{model.label}</option>
                            ))}
                          </select>
                        </label>
                      </div>

                      <label className="settings-field">
                        <span className="settings-title">Instructions</span>
                        <textarea
                          value={profileDraft.instructions || ''}
                          onChange={(e) => updateProfileDraft({ instructions: e.target.value })}
                          className="settings-textarea"
                          rows={4}
                        />
                      </label>

                      <div className="grid gap-3 lg:grid-cols-2">
                        <div className="settings-field">
                          <span className="settings-title">Tools</span>
                          <div className="settings-checklist">
                            {agentExtensions.map((extension) => (
                              <label key={extension.id} className="settings-check">
                                <input
                                  type="checkbox"
                                  checked={draftExtensionIds.has(extension.id)}
                                  onChange={() => toggleDraftListValue('extensionIds', extension.id)}
                                />
                                <span className="min-w-0 truncate">{extension.label}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                        <div className="settings-field">
                          <span className="settings-title">Skills</span>
                          <div className="settings-checklist">
                            {agentSkills.map((skill) => (
                              <label key={skill.id} className="settings-check">
                                <input
                                  type="checkbox"
                                  checked={draftSkillIds.has(skill.id)}
                                  onChange={() => toggleDraftListValue('skillIds', skill.id)}
                                />
                                <span className="min-w-0 truncate">{skill.label}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="flex justify-between gap-2 border-t border-surface-800 pt-3">
                        <button
                          type="button"
                          onClick={deleteCurrentProfile}
                          disabled={agentProfiles.length <= 1}
                          className="settings-danger-button"
                        >
                          Delete
                        </button>
                        <button type="button" onClick={saveCurrentProfile} className="settings-action-button">
                          Save Profile
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="settings-row">
                      <span>
                        <span className="settings-title">No profiles loaded</span>
                        <span className="settings-description">Create a profile to start customizing agents.</span>
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
