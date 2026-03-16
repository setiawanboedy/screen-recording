# Screen Recorder — Copilot Instructions

Proyek ini adalah Electron desktop app untuk screen recording dengan audio mixing, dibangun di atas Bun + TypeScript.

---

## Stack & Runtime

- **Runtime:** Bun (BUKAN Node.js). Selalu gunakan `bun`, bukan `npm` atau `node`
- **Language:** TypeScript strict — tidak boleh ada `any`, gunakan `unknown` + type guard
- **Framework:** Electron 41 + MediaRecorder API + ffmpeg-static
- **Module system:** `"type": "module"` di package.json → preload HARUS `.cjs` (CJS format)

---

## Struktur Proyek

```
src/
  main/index.ts       — Electron main process (IPC, tray, ffmpeg, streaming)
  preload/index.ts    — IPC bridge untuk window utama → build sebagai index.cjs
  preload/toolbar.ts  — IPC bridge untuk floating toolbar → build sebagai toolbar.cjs
  renderer/index.ts   — UI logic window utama
  renderer/index.html — HTML + CSS window utama
  renderer/toolbar.ts — Floating toolbar logic
  renderer/toolbar.html — Floating toolbar HTML
dist/                 — Output build (jangan edit manual)
assets/               — icon.png, icon.ico
```

---

## Build Commands

**Wajib gunakan persis seperti ini — jangan ubah target atau format:**

```bash
# Main process (Node target, external electron + ffmpeg-static)
bun build src/main/index.ts --outfile=dist/main/index.js --target=node --external electron --external ffmpeg-static

# Preload utama (CJS! bukan ESM)
bun build src/preload/index.ts --outfile=dist/preload/index.cjs --target=node --external electron --format=cjs

# Preload toolbar (CJS!)
bun build src/preload/toolbar.ts --outfile=dist/preload/toolbar.cjs --target=node --external electron --format=cjs

# Renderer (browser target)
bun build src/renderer/index.ts --outfile=dist/renderer/index.js --target=browser
bun build src/renderer/toolbar.ts --outfile=dist/renderer/toolbar.js --target=browser

# Copy HTML (bun build tidak copy HTML)
cp src/renderer/index.html dist/renderer/index.html
cp src/renderer/toolbar.html dist/renderer/toolbar.html
```

**Atau gunakan shortcut:** `bun run build`

**Selalu build sebelum test:** `bun run start`

---

## Arsitektur IPC — Jangan Diubah Tanpa Memahami Ini

### Streaming Recording (kritis)

Rekaman di-stream langsung ke disk, bukan di-buffer di RAM:

```
Renderer                     Main
   │── recording-init ──────► buka WriteStream ke /tmp/rec-*.webm
   │── recording-chunk ─────► tulis chunk ke stream (ACK-based)
   │── recording-save ──────► tutup stream → dialog → konversi
   │── recording-cancel ────► hapus temp file
```

- `recording-chunk` pakai `ipcMain.handle` (BUKAN `ipcMain.on`) agar renderer `await` ACK per chunk
- Renderer pakai `chunkChain` (promise chain sequential), bukan `pendingChunks[]` array
- **Jangan ubah ke `ipcMain.on` / `ipcRenderer.send`** → akan menyebabkan race condition

### Urutan Stop Recording

```
MediaRecorder.stop()
  → await chunkChain          (flush chunk terakhir)
  → reset UI, isRecording=false, cleanupStreams()
  → saveRecording(filename, duration)
    → main: tutup stream, dialog, conversion-start event, ffmpeg
  → hideConversionOverlay()
```

**Jangan pindahkan reset UI ke setelah saveRecording** — akan menyebabkan UI freeze.

### Conversion Overlay

- Overlay ditampilkan via event `conversion-start` dari main (setelah dialog tutup, sebelum ffmpeg)
- Untuk WebM: overlay "Saving Recording" dengan chunked copy progress
- Untuk MP4: overlay "Converting to MP4" dengan ffmpeg `-progress pipe:1`
- `conversion-start` membawa `{ mode: 'copy' | 'convert' }`

---

## Known Quirks — Jangan Lupa

| Issue | Penjelasan |
|-------|-----------|
| `__dirname` di Bun | Bun hardcode `__dirname` ke path source, bukan output. Gunakan `app.getAppPath()` untuk runtime paths |
| Preload harus CJS | `"type": "module"` membuat `.js` jadi ESM. Electron sandbox tidak bisa load ESM preload. Build sebagai `.cjs` |
| EXDEV di Linux | `/tmp` dan `/home` bisa beda filesystem. Jangan pakai `fs.renameSync` cross-device — gunakan chunked read/write atau `fs.copyFileSync` + `fs.unlinkSync` |
| NativeImage via IPC | Tidak bisa serialize. Gunakan `.toDataURL()` sebelum kirim via IPC |
| getDisplayMedia | Gunakan `navigator.mediaDevices.getDisplayMedia()` + `setDisplayMediaRequestHandler` di main. Jangan pakai `getUserMedia` dengan `chromeMediaSource` (deprecated) |
| ffmpeg streaming WebM | MediaRecorder output WebM tanpa seekable index. Wajib `-fflags +genpts+discardcorrupt` |

---

## ffmpeg Configuration

```typescript
spawn(ffmpegBin, [
  '-fflags', '+genpts+discardcorrupt',  // WAJIB untuk streaming WebM
  '-i', tempPath,
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',  // ultrafast untuk kecepatan
  '-c:a', 'aac', '-b:a', '128k',
  '-movflags', '+faststart',
  '-threads', '0',              // gunakan semua CPU core
  '-progress', 'pipe:1',        // untuk progress tracking
  '-nostats',
  '-y', filePath,
])
```

**Jangan ganti `ultrafast` ke `fast`/`medium`** — akan memperlambat konversi secara signifikan.

---

## UI Layout Rules

- `body` adalah flex column, `height: 100vh`, `overflow: hidden`
- `.preview-container` pakai `flex: 1; min-height: 0` — biarkan shrink
- `.settings-panel` dan `.controls` pakai `flex-shrink: 0` — jangan pernah terpotong
- Settings row: Source (flex:2) + Mic (flex:2) + Format (flex:1) dalam satu baris
- Preview video: `object-fit: contain` — jangan `cover` (akan crop)

---

## IPC Channels — Daftar Lengkap

| Channel | Arah | Type | Keterangan |
|---------|------|------|-----------|
| `get-sources` | R→M | handle | Ambil list screen/window sources |
| `set-source` | R→M | handle | Set source yang dipilih |
| `recording-init` | R→M | handle | Buka WriteStream |
| `recording-chunk` | R→M | handle | Kirim chunk data (ACK) |
| `recording-save` | R→M | handle | Simpan + konversi |
| `recording-cancel` | R→M | on | Batalkan + hapus temp |
| `recording-status` | R→M | on | Update tray state |
| `show-floating-toolbar` | R→M | on | Tampilkan toolbar |
| `hide-floating-toolbar` | R→M | on | Sembunyikan toolbar |
| `toolbar-sync` | R→M | on | Sync timer ke toolbar |
| `toolbar-action` | T→M | on | Aksi dari toolbar (pause/stop) |
| `toggle-recording` | M→R | send | Hotkey/tray trigger |
| `toggle-pause` | M→R | send | Hotkey/tray trigger |
| `toolbar-update` | M→T | send | Update state toolbar |
| `conversion-start` | M→R | send | Mulai overlay (`{mode}`) |
| `conversion-progress` | M→R | send | Update progress bar |

---

## Checklist Sebelum Commit

- [ ] `bun run build` sukses tanpa error
- [ ] `bun run start` bisa launch
- [ ] Test rekam → stop → save → file tersimpan
- [ ] Tidak ada perubahan pada IPC channel names
- [ ] Tidak ada `any` type baru
- [ ] Tidak ada hardcoded path (gunakan `app.getAppPath()` atau `app.getPath()`)
- [ ] Preload tetap di-build sebagai `.cjs`

---

## Commit Message Format

Gunakan Conventional Commits:
```
feat: deskripsi fitur baru
fix: deskripsi bug yang diperbaiki
refactor: perubahan tanpa fitur/fix
perf: perbaikan performa
docs: perubahan dokumentasi
```
