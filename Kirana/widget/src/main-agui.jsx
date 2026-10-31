/**
 * Bootstrap do widget Kirana sobre AG-UI.
 *
 *   <script src="/widget/kirana-widget.js" defer></script>
 *
 * Configuração opcional antes do script:
 *   window.KIRANA_WIDGET_CONFIG = { aguiUrl: '/api/agui', siteId: 'demo-opportunity' };
 */
import React from 'react';
import { createRoot } from 'react-dom/client';

import { AguiPanel } from './AguiPanel.jsx';

function mount() {
  const config = { ...(window.KIRANA_WIDGET_CONFIG || {}) };
  const site = window.KiranaSite || null;
  const siteConfig = config.site || site?.config || { siteId: config.siteId || 'demo-opportunity', name: 'Kirana' };

  if (document.getElementById('kirana-widget-root')) return;

  const host = document.createElement('div');
  host.id = 'kirana-widget-root';
  document.body.appendChild(host);

  let container = host;
  if (host.attachShadow) {
    container = host.attachShadow({ mode: 'open' });
    const base = document.createElement('style');
    base.textContent = ':host{all:initial}';
    container.appendChild(base);
  }
  const root = document.createElement('div');
  container.appendChild(root);

  const bus = new EventTarget();
  window.KiranaWidget = {
    version: '0.3.0',
    siteId: siteConfig.siteId,
    transport: 'ag-ui',
    onAction(listener) {
      const handler = (event) => listener(event.detail);
      bus.addEventListener('kirana:action', handler);
      return () => bus.removeEventListener('kirana:action', handler);
    },
  };

  createRoot(root).render(
    <AguiPanel
      siteConfig={siteConfig}
      transport={{ aguiUrl: config.aguiUrl || '/api/agui' }}
    />,
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
