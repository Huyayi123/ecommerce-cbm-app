import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { PwaUpdateNotice } from './components/PwaUpdateNotice';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <PwaUpdateNotice />
  </StrictMode>,
);
