/** Widget Kirana (build leve): fala o protocolo do runtime CopilotKit. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AguiPanel } from './AguiPanel.jsx';

function mount() {
  const config = window.KIRANA_WIDGET_CONFIG || {};
  const site = window.KiranaSite;
  if (!site) return console.warn('[kirana] window.KiranaSite ausente: widget não montado.');
  window.KiranaWidget = { version: '0.3.0', transport: 'copilotkit-runtime', siteId: site.config.siteId };
  if (document.getElementById('kirana-widget-root')) return;
  const host = document.createElement('div');
  host.id = 'kirana-widget-root';
  document.body.appendChild(host);
  createRoot(host).render(
    <AguiPanel
      siteConfig={site.config}
      transport={{ url: config.runtimeUrl || '/api/copilot', envelope: { agentId: config.agent || 'kirana' } }}
    />,
  );
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
