# Screen Recorder

Electron desktop app untuk screen recording dengan audio mixing dan noise reduction, dibangun di atas Bun + TypeScript.

## Fitur

- Rekam layar atau window tertentu
- Mix audio: system audio (loopback) + microphone
- Noise reduction 2-tier: browser native + AudioWorklet spectral gate
- Output format: WebM atau MP4 (via ffmpeg)
- Floating toolbar always-on-top saat recording
- Global hotkey: `Ctrl+Shift+R` (toggle recording), `Ctrl+Shift+P` (toggle pause)
- Tray icon dengan menu kontrol

---

## Prasyarat

- [Bun](https://bun.sh) v1.0+
- Node.js tidak diperlukan — semua perintah pakai `bun`

---

## Instalasi

```bash
bun install
```

---

## Development

### Jalankan aplikasi (build + launch)

```bash
bun run start
```

Perintah ini menjalankan full build terlebih dahulu, lalu membuka Electron.

### Build saja (tanpa launch)

```bash
bun run build
```

Output build ada di folder `dist/`.

### Build manual per file

Gunakan ini jika hanya satu file yang berubah:

```bash
# Main process
bun build src/main/index.ts --outfile=dist/main/index.js --target=node --external electron --external ffmpeg-static

# Preload utama (wajib CJS)
bun build src/preload/index.ts --outfile=dist/preload/index.cjs --target=node --external electron --format=cjs

# Preload toolbar (wajib CJS)
bun build src/preload/toolbar.ts --outfile=dist/preload/toolbar.cjs --target=node --external electron --format=cjs

# Renderer utama
bun build src/renderer/index.ts --outfile=dist/renderer/index.js --target=browser

# Renderer toolbar
bun build src/renderer/toolbar.ts --outfile=dist/renderer/toolbar.js --target=browser

# Copy HTML dan asset statis (tidak di-bundle oleh bun build)
cp src/renderer/index.html dist/renderer/index.html
cp src/renderer/toolbar.html dist/renderer/toolbar.html
cp src/renderer/noise-processor.js dist/renderer/noise-processor.js
```

### Ubah HTML/CSS saja (tanpa full build)

```bash
cp src/renderer/index.html dist/renderer/index.html
```

Lalu restart Electron — tidak perlu build ulang TypeScript.

---

## Build Distribusi

### Linux (.deb + AppImage)

```bash
bun run dist
```

Output ada di folder `release/`.

### Windows (NSIS installer)

```bash
bun run dist
```

Pastikan icon `assets/icon.ico` tersedia.

---

## Struktur Proyek

```
src/
  main/
    index.ts          — Electron main process: IPC, tray, ffmpeg, streaming
  preload/
    index.ts          — IPC bridge untuk window utama (build → index.cjs)
    toolbar.ts        — IPC bridge untuk floating toolbar (build → toolbar.cjs)
  renderer/
    index.ts          — UI logic window utama
    index.html        — HTML + CSS window utama
    toolbar.ts        — Floating toolbar logic
    toolbar.html      — Floating toolbar HTML
    noise-processor.js — AudioWorklet: spectral gate noise reduction
assets/
  icon.png            — Icon Linux/macOS
  icon.ico            — Icon Windows
dist/                 — Output build (jangan edit manual)
release/              — Output distribusi dari electron-builder
```

---

## Fitur Noise Reduction

Toggle **Noise Reduction** tersedia di settings panel sebelum mulai recording.

**Cara kerja (2-tier):**

| Tier | Mekanisme | Keterangan |
|------|-----------|------------|
| 1 | `noiseSuppression: true` via getUserMedia | Browser/OS native, selalu tersedia |
| 2 | AudioWorklet spectral gate (`noise-processor.js`) | Adaptive noise floor estimation, pure JS |

Tier 2 bekerja di atas tier 1:
- **Kalibrasi otomatis** selama 1.5 detik pertama untuk mengukur noise floor ruangan
- Frame di bawah 3× noise floor di-attenuate 95%
- Soft-knee transition untuk mencegah artifact
- Noise floor terus diperbarui adaptif saat suasana diam

---

## Catatan Teknis Penting

### Preload harus CJS
`"type": "module"` di `package.json` membuat `.js` jadi ESM. Electron sandbox tidak bisa load ESM preload — selalu build preload sebagai `.cjs`.

### Jangan pakai `__dirname`
Bun hardcode `__dirname` ke path source, bukan output. Gunakan `app.getAppPath()` untuk runtime paths.

### EXDEV di Linux
`/tmp` dan `/home` bisa beda filesystem. Gunakan chunked copy + `fs.unlinkSync`, bukan `fs.renameSync`.

### IPC streaming recording
`recording-chunk` wajib pakai `ipcMain.handle` (bukan `ipcMain.on`) agar renderer menunggu ACK sebelum mengirim chunk berikutnya. Renderer wajib pakai `chunkChain` (sequential promise chain).

### Urutan stop recording
Reset UI state **sebelum** memanggil `saveRecording()`. Jika dibalik → UI freeze.

---

## Hotkey

| Hotkey | Aksi |
|--------|------|
| `Ctrl+Shift+R` | Toggle start/stop recording |
| `Ctrl+Shift+P` | Toggle pause/resume |
