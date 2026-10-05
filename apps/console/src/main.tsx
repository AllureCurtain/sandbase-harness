import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ConsoleMotion } from './components/motion';
import './i18n';
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConsoleMotion>
      <App />
    </ConsoleMotion>
  </React.StrictMode>,
);
