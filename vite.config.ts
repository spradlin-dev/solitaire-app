import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves project sites under a repo-named subpath, so every
  // asset URL must carry it (DESIGN.md sections 6-7).
  base: '/solitaire-app/',
  plugins: [react()],
})
