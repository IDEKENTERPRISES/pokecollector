import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readReleaseId, releaseChannel, releasesPlugin } from './scripts/releases-build.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

function readAppVersion() {
  try {
    return readFileSync(resolve(__dirname, '..', 'VERSION'), 'utf-8').trim()
  } catch {
    return packageJson.version
  }
}

export default defineConfig(({ command }) => ({
  plugins: [releasesPlugin({ channel: releaseChannel(), command }), tailwindcss(), react()],
  define: {
    __APP_VERSION__: JSON.stringify(readAppVersion()),
    __RELEASE_ID__: JSON.stringify(readReleaseId(__dirname)),
    __RELEASE_CHANNEL__: JSON.stringify(releaseChannel()),
    __PWA_DEFAULT__: JSON.stringify(process.env.VITE_PWA_DEFAULT === 'on' ? 'sw=1;queue=1' : 'sw=0;queue=0'),
  },
  // The phone matcher's worker loads onnxruntime-web with dynamic imports, which need ES module workers (not the default IIFE).
  worker: { format: 'es' },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
}))
