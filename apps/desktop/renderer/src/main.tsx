import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// './types/global.d.ts' is picked up automatically by tsconfig's `include`
// glob — it's ambient-only (declares `window.driller`) and must not be
// imported at runtime.

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
