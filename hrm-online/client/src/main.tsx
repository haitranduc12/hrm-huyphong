import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Đăng ký service worker để app cài được lên màn hình chính và mở nhanh khi
// offline. Chỉ chạy ở bản build thật (dev có HMR, service worker gây phiền).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* Không cài được service worker cũng không sao — app vẫn chạy như web thường. */
    });
  });
}
