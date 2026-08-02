import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves project sites under a repo-named subpath; every asset
// URL and the installed app's identity must carry it (DESIGN.md sections 6-7).
const APP_BASE = '/solitaire-app/'

// https://vite.dev/config/
export default defineConfig({
  base: APP_BASE,
  plugins: [
    react(),
    VitePWA({
      // 'prompt' surfaces an update toast instead of silently reloading a
      // game in progress (DESIGN.md section 6).
      registerType: 'prompt',
      // The png/svg glob below is the single owner of precaching the
      // icons; without this the plugin injects the manifest icons a
      // second time.
      includeManifestIcons: false,
      manifest: {
        name: 'Solitaire',
        short_name: 'Solitaire',
        description: 'Klondike solitaire — works offline.',
        // Pinned to the subpath so an installed app cannot launch at the
        // domain root and 404. id has no plugin default; the CI smoke
        // check asserts start_url in the built manifest.
        id: APP_BASE,
        start_url: APP_BASE,
        scope: APP_BASE,
        display: 'standalone',
        background_color: '#23343f',
        theme_color: '#1b2830',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // A superset of workbox's default {js,wasm,css,html}: the default
        // misses the card faces (hashed .svg assets) and the icons, and the
        // whole app must precache for offline play.
        globPatterns: ['**/*.{js,wasm,css,html,svg,png}'],
        navigateFallback: `${APP_BASE}index.html`,
      },
    }),
  ],
})
