import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/noto-serif-sc';
import { App } from './App';
import './styles/globals.css';

const root = document.getElementById('root');
if (!root) {
    throw new Error('缺少 Web 应用挂载节点');
}

createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
