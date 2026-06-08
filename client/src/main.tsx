console.log('%c>>> PI-AGENT-APP v0.3.0 LOADED <<<', 'background: green; color: white; font-size: 16px; padding: 4px 8px; border-radius: 4px; font-weight: bold');
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';

function clearLegacyBrowserCache() {
  try {
    localStorage.removeItem('pi-web-messages');
    localStorage.removeItem('pi-web-sessions');
    localStorage.removeItem('pi-web-projects');
  } catch (error) {
    console.warn('[Pi Agent UI] Browser storage unavailable:', error);
  }
}

function updateViewportHeight() {
  const viewport = window.visualViewport;
  const height = viewport?.height || window.innerHeight;
  const top = viewport?.offsetTop || 0;
  document.documentElement.style.setProperty('--app-height', `${height}px`);
  document.documentElement.style.setProperty('--app-top', `${top}px`);
}

clearLegacyBrowserCache();
updateViewportHeight();
window.addEventListener('resize', updateViewportHeight);
window.addEventListener('orientationchange', updateViewportHeight);
window.visualViewport?.addEventListener('resize', updateViewportHeight);
window.visualViewport?.addEventListener('scroll', updateViewportHeight);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
