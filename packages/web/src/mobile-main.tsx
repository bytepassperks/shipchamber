import { createConfiguredWebAPIs } from './runtimeConfig';
import type { RuntimeAPIs } from '@shipchamber/ui/lib/api/types';
import '@shipchamber/ui/index.css';
import '@shipchamber/ui/styles/fonts';

declare global {
  interface Window {
    __SHIPCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

window.__SHIPCHAMBER_RUNTIME_APIS__ = createConfiguredWebAPIs();

void import('@shipchamber/ui/apps/renderMobileApp')
  .then(({ renderMobileApp }) => {
    renderMobileApp(window.__SHIPCHAMBER_RUNTIME_APIS__ ?? createConfiguredWebAPIs());
  });
