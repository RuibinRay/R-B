import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles.css';
import App from './App';
import { engine } from './audio/engine';
import { renderProject } from './audio/render';
import { processClip } from './audio/clipProcess';
import { trackPitch } from './lib/dsp/pitch';
import { A, addBufferAsset, initSession, useStore } from './store/store';

engine.sync(useStore.getState().project);
void initSession();

if (import.meta.env.DEV) {
  // Handy for poking at the engine from the console during development.
  (window as unknown as Record<string, unknown>).__rnb = { engine, renderProject, A, useStore, addBufferAsset, processClip, trackPitch };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
