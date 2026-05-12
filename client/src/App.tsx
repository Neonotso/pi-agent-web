import { useState, useCallback, useEffect } from 'react';
import { PiAgentProvider } from './contexts/PiAgentContext';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import './index.css';

function AppContent() {
  const [showSidebar, setShowSidebar] = useState(false);

  const handleCloseSidebar = useCallback(() => setShowSidebar(false), []);
  const handleOpenSidebar = useCallback(() => setShowSidebar(true), []);

  return (
    <div className="flex h-screen w-screen bg-surface-950">
      {/* Sidebar */}
      <Sidebar onClose={handleCloseSidebar} />

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0 relative">
        {/* Mobile sidebar trigger */}
        <button
          onClick={handleOpenSidebar}
          className="lg:hidden fixed top-3 left-3 z-30 p-2 rounded-lg bg-surface-800/80 backdrop-blur text-slate-400 hover:text-white shadow-lg"
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
  return (
    <PiAgentProvider>
      <AppContent />
    </PiAgentProvider>
  );
}
