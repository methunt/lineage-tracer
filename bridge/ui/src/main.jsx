import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '@xyflow/react/dist/style.css';
import './styles.css';

// Stamp the default theme before the first paint. Without this the page falls
// through to the OS preference until something calls toggleTheme, so a reader
// on a dark-mode machine opens a dark report and the toggle's first press does
// nothing they can see.
document.documentElement.setAttribute('data-theme', 'light');

// The bundle is a classic inline script (see vite.config.js), so it executes
// while the document is still parsing — #root does not exist yet.
function mount() {
    createRoot(document.getElementById('root')).render(<App />);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
    mount();
}
