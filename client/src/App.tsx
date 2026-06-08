import { useEffect, useState, useCallback } from 'react';
import { PiAgentProvider } from './contexts/PiAgentContext';
import { SettingsProvider } from './contexts/SettingsContext';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import './index.css';

const QUIET_HOURS_START = 0;
const QUIET_HOURS_END = 6;
const QUIET_HOURS_UNLOCK_UNTIL_KEY = 'pi-agent-quiet-hours-unlock-until';
const QUIET_HOURS_UNLOCK_OPTIONS = [15, 30, 60, 120];

function isQuietHours(now = new Date()) {
  const hour = now.getHours();
  return hour >= QUIET_HOURS_START && hour < QUIET_HOURS_END;
}

function quietHoursUnlockIsActive(now = new Date()) {
  try {
    const stored = window.localStorage.getItem(QUIET_HOURS_UNLOCK_UNTIL_KEY);
    if (!stored) return false;
    const unlockUntil = Number(stored);
    if (!Number.isFinite(unlockUntil) || unlockUntil <= now.getTime()) {
      window.localStorage.removeItem(QUIET_HOURS_UNLOCK_UNTIL_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function useQuietHoursLock() {
  const [locked, setLocked] = useState(() => isQuietHours() && !quietHoursUnlockIsActive());

  const refresh = useCallback(() => {
    setLocked(isQuietHours() && !quietHoursUnlockIsActive());
  }, []);

  const unlockForMinutes = useCallback((minutes: number) => {
    const safeMinutes = QUIET_HOURS_UNLOCK_OPTIONS.includes(minutes) ? minutes : QUIET_HOURS_UNLOCK_OPTIONS[0];
    try {
      window.localStorage.setItem(QUIET_HOURS_UNLOCK_UNTIL_KEY, String(Date.now() + safeMinutes * 60_000));
    } catch {
      // If storage is unavailable, still unlock for this loaded page.
    }
    setLocked(false);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  return { locked, unlockForMinutes };
}

function QuietHoursScreen({ onUnlock }: { onUnlock: (minutes: number) => void }) {
  const [unlockMinutes, setUnlockMinutes] = useState(QUIET_HOURS_UNLOCK_OPTIONS[1]);

  return (
    <div className="quiet-hours-screen">
      <div className="quiet-hours-panel">
        <div className="quiet-hours-mark">π</div>
        <h1>Spend some time with the Lord, and get some rest.</h1>
        <p>Pi chats unlock again at 6:00 AM.</p>
        <div className="quiet-hours-unlock-row">
          <label htmlFor="quiet-hours-unlock-minutes">Unlock for</label>
          <select
            id="quiet-hours-unlock-minutes"
            value={unlockMinutes}
            onChange={(event) => setUnlockMinutes(Number(event.target.value))}
          >
            {QUIET_HOURS_UNLOCK_OPTIONS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} min
              </option>
            ))}
          </select>
          <button type="button" className="quiet-hours-unlock" onClick={() => onUnlock(unlockMinutes)}>
            Unlock
          </button>
        </div>
        <p className="quiet-hours-note">This only unlocks this browser for the selected time.</p>
      </div>
    </div>
  );
}

function AppContent() {
  const [showSidebar, setShowSidebar] = useState(false);

  return (
    <div className="app-shell flex w-full max-w-full overflow-x-hidden bg-surface-950">
      <Sidebar isOpen={showSidebar} onClose={() => setShowSidebar(false)} />
      <main className="flex-1 flex flex-col min-w-0 overflow-x-hidden relative">
        <button
          onClick={() => setShowSidebar(true)}
          className="mobile-menu-button lg:hidden fixed left-3 z-30 p-2 rounded-lg bg-surface-800/80 backdrop-blur text-slate-400 hover:text-white shadow-lg"
          aria-label="Open sidebar"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <ChatArea />
      </main>
    </div>
  );
}

export default function App() {
  const { locked, unlockForMinutes } = useQuietHoursLock();

  if (locked) {
    return <QuietHoursScreen onUnlock={unlockForMinutes} />;
  }

  return (
    <SettingsProvider>
      <PiAgentProvider>
        <AppContent />
      </PiAgentProvider>
    </SettingsProvider>
  );
}
