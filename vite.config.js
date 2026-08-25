import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // Mikrofon braucht einen sicheren Kontext. localhost gilt als sicher,
    // ein Zugriff per LAN-IP nicht — dann `--host` plus HTTPS-Tunnel nutzen.
    host: '127.0.0.1',
    port: 5173,
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
})
