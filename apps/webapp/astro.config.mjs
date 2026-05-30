// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import AstroPWA from '@vite-pwa/astro';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  integrations: [
    react(),
    AstroPWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      pwaAssets: {
        image: 'public/pwa-icon.svg',
        includeHtmlHeadLinks: false,
      },
      manifest: {
        name: 'Expenser',
        short_name: 'Expenser',
        description: 'Weekly expense tracker for managing your budget in ARS',
        theme_color: '#4f46e5',
        background_color: '#f9fafb',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
      },
      workbox: {
        navigateFallback: '/',
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],

  vite: {
    plugins: [tailwindcss()]
  }
});
