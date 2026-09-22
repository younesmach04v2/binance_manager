import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'vite'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }

/** Web bundle for the Capacitor (Android) app: the same React UI with the remote transport instead of Electron IPC. */
export default defineConfig({
  root: resolve(__dirname, 'src/mobile'),
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src/renderer/src'), '@shared': resolve(__dirname, 'src/shared') }
  },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { fs: { allow: [resolve(__dirname)] } },
  build: {
    outDir: resolve(__dirname, 'out/mobile'),
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: { input: resolve(__dirname, 'src/mobile/index.html') }
  }
})
