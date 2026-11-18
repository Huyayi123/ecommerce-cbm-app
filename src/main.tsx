import './utils/legacyRandomUuid';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './haichuan-handheld.css';

if (new URLSearchParams(window.location.search).get('mobile') === '1') {
  document.documentElement.classList.add('force-haichuan-handheld');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
