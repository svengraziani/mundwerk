import { defineConfig } from 'vite'

export default defineConfig({
  // Relative Asset-Pfade, damit der Build in einem Unterpfad liegen darf
  // (graziani.dev/transformer/) und nicht auf /assets/ zeigt. Bedingung:
  // die Seite wird mit Schrägstrich am Ende aufgerufen. Für einen festen
  // Unterpfad ohne diese Bedingung: BASE=/transformer/ npm run build
  base: process.env.BASE || './',
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
