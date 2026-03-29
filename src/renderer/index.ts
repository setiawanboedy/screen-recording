declare global {
  interface Window {
    electronAPI: {
      getSources: () => Promise<Array<{ id: string; name: string; thumbnail: string }>>;
      setSource: (sourceId: string) => Promise<void>;
      setAudioMode: (captureSystemAudio: boolean) => Promise<void>;
      initRecording: () => Promise<void>;
      sendChunk: (buf: ArrayBuffer) => Promise<void>;
      saveRecording: (filename: string, durationSeconds: number) => Promise<{ success?: boolean; filePath?: string; canceled?: boolean; warning?: string; error?: string }>;
      cancelRecording: () => void;
      setRecordingStatus: (status: string) => void;
      onToggleRecording: (callback: () => void) => void;
      onTogglePause: (callback: () => void) => void;
      showFloatingToolbar: () => void;
      hideFloatingToolbar: () => void;
      syncToolbar: (timer: string, state: 'recording' | 'paused') => void;
      onConversionStart: (cb: (opts?: { mode?: string }) => void) => void;
      onConversionProgress: (cb: (data: { percent: number; currentSecs: number; totalSecs: number }) => void) => void;
    };
  }
}

// DOM Elements
const videoPreview = document.getElementById('videoPreview') as HTMLVideoElement;
const placeholder = document.getElementById('placeholder') as HTMLDivElement;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
const sourceSelect = document.getElementById('sourceSelect') as HTMLSelectElement;
const micSelect = document.getElementById('micSelect') as HTMLSelectElement;
const formatSelect = document.getElementById('formatSelect') as HTMLSelectElement;
const timerEl = document.getElementById('timer') as HTMLDivElement;
const statusBadge = document.getElementById('statusBadge') as HTMLSpanElement;
const noiseReductionToggle = document.getElementById('noiseReductionToggle') as HTMLInputElement;
const noiseReductionLabel = document.getElementById('noiseReductionLabel') as HTMLSpanElement;
const systemAudioToggle = document.getElementById('systemAudioToggle') as HTMLInputElement;
const systemAudioLabel = document.getElementById('systemAudioLabel') as HTMLSpanElement;
const refreshMicBtn = document.getElementById('refreshMicBtn') as HTMLButtonElement;
const micHint = document.getElementById('micHint') as HTMLDivElement;

// Mic meter elements
const micIcon = document.getElementById('micIcon') as HTMLSpanElement;
const micMeterLabel = document.getElementById('micMeterLabel') as HTMLSpanElement;
const micBarEls = Array.from({ length: 12 }, (_, i) => document.getElementById(`micBar${i}`) as HTMLDivElement);

// Conversion overlay elements
const conversionOverlay = document.getElementById('conversionOverlay') as HTMLDivElement;
const progressFill = document.getElementById('progressFill') as HTMLDivElement;
const progressPercent = document.getElementById('progressPercent') as HTMLSpanElement;
const progressTime = document.getElementById('progressTime') as HTMLSpanElement;
const convTitle = document.getElementById('convTitle') as HTMLDivElement;
const convSub = document.getElementById('convSub') as HTMLDivElement;

// State
let mediaRecorder: MediaRecorder | null = null;
let chunkChain: Promise<void> = Promise.resolve(); // sequential chain — only await the tail
let timerInterval: ReturnType<typeof setInterval> | null = null;
let elapsedSeconds = 0;
let isPaused = false;
let isRecording = false;
let activeStreams: MediaStream[] = [];
let activeAudioContext: AudioContext | null = null;

// Mic test state
let micTestStream: MediaStream | null = null;
let micTestContext: AudioContext | null = null;
let micTestAnimFrame: number | null = null;

// Timer
function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatShort(secs: number): string {
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// Conversion overlay
function showConversionOverlay() {
  convTitle.textContent = 'Converting to MP4';
  convSub.textContent = 'Please wait…';
  progressFill.style.width = '0%';
  progressFill.classList.add('indeterminate');
  progressPercent.textContent = '…';
  progressTime.textContent = '';
  conversionOverlay.classList.add('visible');
}

function updateConversionProgress(percent: number, currentSecs: number, totalSecs: number) {
  if (percent < 0) {
    progressFill.classList.add('indeterminate');
    progressPercent.textContent = '…';
    progressTime.textContent = formatShort(currentSecs);
  } else {
    progressFill.classList.remove('indeterminate');
    progressFill.style.width = `${percent}%`;
    progressPercent.textContent = `${percent}%`;
    convSub.textContent = `Processing…`;
    progressTime.textContent = totalSecs > 0
      ? `${formatShort(currentSecs)} / ${formatShort(totalSecs)}`
      : formatShort(currentSecs);
  }
}

async function hideConversionOverlay() {
  progressFill.classList.remove('indeterminate');
  progressFill.style.width = '100%';
  progressPercent.textContent = '100%';
  convSub.textContent = '✓ Done!';
  await new Promise(r => setTimeout(r, 700));
  conversionOverlay.classList.remove('visible');
}

// Listen to conversion events from main process
window.electronAPI.onConversionStart((opts?: { mode?: string }) => {
  const mode = opts?.mode ?? 'convert';
  if (mode === 'copy') {
    convTitle.textContent = 'Saving Recording';
    convSub.textContent = 'Copying file…';
  } else {
    convTitle.textContent = 'Converting to MP4';
    convSub.textContent = 'Please wait…';
  }
  progressFill.style.width = '0%';
  progressFill.classList.add('indeterminate');
  progressPercent.textContent = '…';
  progressTime.textContent = '';
  conversionOverlay.classList.add('visible');
});
window.electronAPI.onConversionProgress(({ percent, currentSecs, totalSecs }) => {
  updateConversionProgress(percent, currentSecs, totalSecs);
});

function startTimer() {
  elapsedSeconds = 0;
  timerEl.textContent = '00:00:00';
  timerInterval = setInterval(() => {
    if (!isPaused) {
      elapsedSeconds++;
      const t = formatTime(elapsedSeconds);
      timerEl.textContent = t;
      window.electronAPI.syncToolbar(t, 'recording');
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  elapsedSeconds = 0;
  timerEl.textContent = '00:00:00';
}

// Status
function setStatus(status: 'idle' | 'recording' | 'paused') {
  statusBadge.className = `status-badge status-${status}`;
  statusBadge.textContent = status.toUpperCase();
  timerEl.className = `timer ${status === 'recording' ? 'recording' : status === 'paused' ? 'paused' : ''}`;
  window.electronAPI.setRecordingStatus(status);
}

// Get screen sources
async function getSources() {
  try {
    console.log('[renderer] Loading sources...');
    const sources = await window.electronAPI.getSources();
    console.log('[renderer] Got', sources.length, 'sources');
    sourceSelect.innerHTML = '<option value="">Select screen or window...</option>';
    sources.forEach(source => {
      const option = document.createElement('option');
      option.value = source.id;
      option.text = source.name;
      sourceSelect.appendChild(option);
    });
  } catch (err) {
    console.error('[renderer] getSources error:', err);
  }
}

// Get audio input devices — enumerate dengan permission eksplisit
async function getAudioDevices(forceRefresh = false) {
  const prevValue = micSelect.value;

  if (forceRefresh) {
    refreshMicBtn.disabled = true;
    refreshMicBtn.classList.add('spinning');
    micHint.textContent = '';
    micHint.className = 'device-hint';
  }

  try {
    // Minta izin audio tanpa constraint deviceId agar browser expose semua device
    // Gunakan echoCancellation:false untuk hindari browser memilih "default" saja
    const tempStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    tempStream.getTracks().forEach(t => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    console.log('[renderer] Found', audioInputs.length, 'audio inputs:', audioInputs.map(d => d.label));

    micSelect.innerHTML = '<option value="">No microphone</option>';
    audioInputs.forEach(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.text = device.label || `Microphone ${micSelect.options.length}`;
      micSelect.appendChild(option);
    });

    // Pertahankan pilihan sebelumnya jika masih ada
    if (prevValue && micSelect.querySelector(`option[value="${prevValue}"]`)) {
      micSelect.value = prevValue;
    } else if (audioInputs.length > 0 && audioInputs[0]) {
      micSelect.value = audioInputs[0].deviceId;
    }

    // Hint: jika hanya ada 1 device (default), kemungkinan besar device USB tidak terdeteksi
    const hasOnlyDefault = audioInputs.length === 1 && audioInputs[0]?.deviceId === 'default';
    const hasNoLabel = audioInputs.some(d => !d.label);
    if (hasOnlyDefault || hasNoLabel) {
      micHint.textContent = 'Device tidak tampil? Set headset sebagai default input di System Settings → Sound, lalu klik ↺';
      micHint.className = 'device-hint warn';
    } else if (audioInputs.length > 1) {
      micHint.textContent = `${audioInputs.length} device ditemukan`;
      micHint.className = 'device-hint';
    } else {
      micHint.textContent = '';
    }

    // Auto-start mic test dengan device yang dipilih
    if (micSelect.value) startMicTest(micSelect.value);

  } catch (err) {
    console.error('[renderer] getAudioDevices error:', err);
    micSelect.innerHTML = '<option value="">Microphone not available</option>';
    micHint.textContent = 'Gagal akses mikrofon — cek izin di system settings';
    micHint.className = 'device-hint warn';
  } finally {
    if (forceRefresh) {
      refreshMicBtn.classList.remove('spinning');
      refreshMicBtn.disabled = false;
    }
  }
}

// ── Mic Level Meter ───────────────────────────────────────────────────────

const BAR_COUNT = 12;

function renderMicBars(level: number) {
  // level: 0.0 – 1.0 (normalised RMS)
  const filled = Math.round(level * BAR_COUNT);
  micBarEls.forEach((bar, i) => {
    const active = i < filled;
    // height: idle 3px → active up to 22px with slight randomness for liveliness
    const h = active ? Math.max(4, Math.round((i / BAR_COUNT) * 20 + Math.random() * 4)) : 3;
    bar.style.height = `${h}px`;
    if (!active) {
      bar.style.background = '#2d3748';
    } else if (i < BAR_COUNT * 0.6) {
      bar.style.background = '#53d769'; // green — normal
    } else if (i < BAR_COUNT * 0.85) {
      bar.style.background = '#f5a623'; // orange — loud
    } else {
      bar.style.background = '#e94560'; // red — clip
    }
  });
}

function stopMicTest() {
  if (micTestAnimFrame !== null) {
    cancelAnimationFrame(micTestAnimFrame);
    micTestAnimFrame = null;
  }
  micTestStream?.getTracks().forEach(t => t.stop());
  micTestStream = null;
  micTestContext?.close().catch(() => undefined);
  micTestContext = null;

  renderMicBars(0);
  micIcon.className = 'mic-icon';
  micMeterLabel.textContent = 'No mic';
  micMeterLabel.className = 'mic-meter-label';
}

async function startMicTest(deviceId: string) {
  stopMicTest();

  try {
    micTestStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } },
      video: false,
    });

    micTestContext = new AudioContext();
    const source = micTestContext.createMediaStreamSource(micTestStream);
    const analyser = micTestContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);

    const dataArray = new Float32Array(analyser.fftSize);

    micMeterLabel.textContent = 'Testing…';
    micMeterLabel.className = 'mic-meter-label testing';

    const tick = () => {
      analyser.getFloatTimeDomainData(dataArray);

      // RMS
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i]! * dataArray[i]!;
      }
      const rms = Math.sqrt(sum / dataArray.length);

      // Normalise: -40dB floor → 0, 0dB → 1
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      const level = Math.min(1, Math.max(0, (db + 40) / 40));

      renderMicBars(level);

      if (level > 0.85) {
        micIcon.className = 'mic-icon loud';
        micMeterLabel.textContent = 'Too loud!';
        micMeterLabel.className = 'mic-meter-label clip';
      } else if (level > 0.01) {
        micIcon.className = 'mic-icon active';
        micMeterLabel.textContent = 'Good';
        micMeterLabel.className = 'mic-meter-label testing';
      } else {
        micIcon.className = 'mic-icon';
        micMeterLabel.textContent = 'Quiet…';
        micMeterLabel.className = 'mic-meter-label';
      }

      micTestAnimFrame = requestAnimationFrame(tick);
    };

    micTestAnimFrame = requestAnimationFrame(tick);
    console.log('[renderer] Mic test started:', deviceId);
  } catch (err) {
    console.warn('[renderer] Mic test failed:', err);
    micMeterLabel.textContent = 'Error';
    micMeterLabel.className = 'mic-meter-label';
  }
}

// Initialize
getSources();
getAudioDevices();

// Refresh mic list
refreshMicBtn.addEventListener('click', () => {
  if (!isRecording) getAudioDevices(true);
});

// System audio toggle label sync
systemAudioToggle.addEventListener('change', () => {
  if (systemAudioToggle.checked) {
    systemAudioLabel.textContent = 'ON — Record desktop audio';
    systemAudioLabel.classList.add('active');
    noiseReductionToggle.disabled = false;
  } else {
    systemAudioLabel.textContent = 'OFF — Desktop audio muted';
    systemAudioLabel.classList.remove('active');
    // Noise reduction tidak relevan jika system audio mati
    noiseReductionToggle.disabled = true;
    noiseReductionLabel.classList.remove('active');
  }
});

// Auto-start mic test saat mic dipilih / diganti
micSelect.addEventListener('change', () => {
  const deviceId = micSelect.value;
  if (deviceId && !isRecording) {
    startMicTest(deviceId);
  } else {
    stopMicTest();
  }
});

// Toggle label sync
noiseReductionToggle.addEventListener('change', () => {
  if (noiseReductionToggle.checked) {
    noiseReductionLabel.textContent = 'ON — Background noise reduction active';
    noiseReductionLabel.classList.add('active');
  } else {
    noiseReductionLabel.textContent = 'OFF';
    noiseReductionLabel.classList.remove('active');
  }
});

/**
 * Connect audio source ke graph dengan optional background noise gate.
 * Dipakai untuk system audio (loopback) — meredam suara background/ambient.
 *
 * Tier 1: AudioWorklet spectral gate (noise-processor.js)
 * Tier 2: Fallback — direct connect
 */
async function connectWithNoiseGate(
  audioContext: AudioContext,
  source: AudioNode,
  dest: MediaStreamAudioDestinationNode,
  useNoiseReduction: boolean
): Promise<void> {
  if (!useNoiseReduction) {
    source.connect(dest);
    return;
  }

  try {
    const processorUrl = new URL('./noise-processor.js', window.location.href).href;
    await audioContext.audioWorklet.addModule(processorUrl);
    const noiseGate = new AudioWorkletNode(audioContext, 'noise-gate-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    noiseGate.port.onmessage = (e: MessageEvent<{ type: string; noiseFloor: number; avgRms: number }>) => {
      if (e.data.type === 'calibrated') {
        console.log(
          `[noise-gate] Kalibrasi selesai | avgRms=${e.data.avgRms.toFixed(6)} | noiseFloor=${e.data.noiseFloor.toFixed(6)} | threshold=${(e.data.noiseFloor * 3).toFixed(6)}`
        );
      }
    };

    source.connect(noiseGate);
    noiseGate.connect(dest);
    console.log('[renderer] Background noise reduction: AudioWorklet spectral gate active on system audio');
  } catch (workletErr) {
    console.warn('[renderer] AudioWorklet failed, falling back to direct connect:', workletErr);
    source.connect(dest);
  }
}

// Cleanup
function cleanupStreams() {
  activeStreams.forEach(s => s.getTracks().forEach(t => t.stop()));
  activeStreams = [];
  if (activeAudioContext) {
    activeAudioContext.close().catch(() => undefined);
    activeAudioContext = null;
  }
  videoPreview.srcObject = null;
  videoPreview.style.display = 'none';
  placeholder.style.display = 'flex';
}

// Start recording
async function startRecording() {
  const sourceId = sourceSelect.value;
  if (!sourceId) {
    alert('Select a screen source first!');
    return;
  }

  try {
    console.log('[renderer] Starting recording, source:', sourceId);

    // Tell main process which source to use + audio mode
    await window.electronAPI.setSource(sourceId);
    await window.electronAPI.setAudioMode(systemAudioToggle.checked);

    // Use getDisplayMedia — main process handles source selection via setDisplayMediaRequestHandler
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true, // system audio (loopback)
    });
    activeStreams.push(screenStream);
    console.log('[renderer] Got screen stream, video tracks:', screenStream.getVideoTracks().length, 'audio tracks:', screenStream.getAudioTracks().length);

    const tracks: MediaStreamTrack[] = [];
    const videoTrack = screenStream.getVideoTracks()[0];
    if (videoTrack) tracks.push(videoTrack);

    // Mix audio: system audio + microphone
    const audioContext = new AudioContext();
    activeAudioContext = audioContext;
    const dest = audioContext.createMediaStreamDestination();
    let hasAudio = false;

    const useNoiseReduction = noiseReductionToggle.checked;

    // System audio from screen capture — pasang noise gate di sini jika aktif
    if (screenStream.getAudioTracks().length > 0) {
      const sysAudioTrack = screenStream.getAudioTracks()[0]!;
      const sysSource = audioContext.createMediaStreamSource(new MediaStream([sysAudioTrack]));
      await connectWithNoiseGate(audioContext, sysSource, dest, useNoiseReduction);
      hasAudio = true;
      console.log('[renderer] System audio connected, background NR:', useNoiseReduction);
    }

    // Microphone — direct connect, tidak difilter (mic sudah bersih dari hardware)
    const micDeviceId = micSelect.value;
    if (micDeviceId) {
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: micDeviceId } },
          video: false,
        });
        activeStreams.push(micStream);
        const micSource = audioContext.createMediaStreamSource(micStream);
        micSource.connect(dest);
        hasAudio = true;
        console.log('[renderer] Microphone connected');
      } catch (micErr) {
        console.warn('[renderer] Mic error (continuing without mic):', micErr);
      }
    }

    if (hasAudio) {
      const mixedTrack = dest.stream.getAudioTracks()[0];
      if (mixedTrack) tracks.push(mixedTrack);
    }

    const combinedStream = new MediaStream(tracks);

    // Preview
    placeholder.style.display = 'none';
    videoPreview.style.display = 'block';
    videoPreview.srcObject = combinedStream;
    videoPreview.play();

    // MediaRecorder
    const mimeType = MediaRecorder.isTypeSupported('video/webm; codecs=vp9')
      ? 'video/webm; codecs=vp9'
      : 'video/webm';

    mediaRecorder = new MediaRecorder(combinedStream, { mimeType });
    chunkChain = Promise.resolve();

    // Stream each chunk directly to main process — sequential chain, no array growth
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunkChain = chunkChain.then(() =>
          e.data.arrayBuffer().then(buf => window.electronAPI.sendChunk(buf))
        );
      }
    };

    mediaRecorder.onstop = async () => {
      console.log('[renderer] MediaRecorder stopped, flushing last chunk...');

      // Wait only for the tail of the chain — all prior links already resolved
      await chunkChain;
      chunkChain = Promise.resolve();

      const fmt = formatSelect.value as 'mp4' | 'webm';
      const duration = elapsedSeconds;

      // ── Reset UI immediately ──
      isRecording = false;
      isPaused = false;
      cleanupStreams();
      stopTimer();
      setStatus('idle');
      updateButtons('idle');


      // ── Save (dialog + optional conversion) ──
      const result = await window.electronAPI.saveRecording(
        `recording-${Date.now()}.${fmt}`, duration
      );

      if (result.filePath) {
        await hideConversionOverlay();
        console.log('[renderer] Saved to', result.filePath);
        if (result.warning) {
          alert(`Saved (as WebM fallback):\n${result.filePath}\n\n⚠️ ${result.warning}`);
        }
      }
    };

    // Init streaming session in main process, then start recorder
    await window.electronAPI.initRecording();
    mediaRecorder.start(1000);
    isRecording = true;
    isPaused = false;
    startTimer();
    setStatus('recording');
    updateButtons('recording');
    window.electronAPI.showFloatingToolbar();
    window.electronAPI.syncToolbar('00:00:00', 'recording');
    console.log('[renderer] Recording started (streaming to disk)!');

  } catch (err) {
    console.error('[renderer] startRecording error:', err);
    window.electronAPI.cancelRecording();
    alert(`Error: ${err instanceof Error ? err.message : String(err)}`);
    cleanupStreams();
  }
}

// Stop recording
function stopRecording() {
  console.log('[renderer] stopRecording called, state:', mediaRecorder?.state);
  window.electronAPI.hideFloatingToolbar();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

// Pause / Resume
function togglePause() {
  if (!mediaRecorder || !isRecording) return;
  console.log('[renderer] togglePause, current state:', mediaRecorder.state);

  if (isPaused) {
    mediaRecorder.resume();
    isPaused = false;
    setStatus('recording');
    pauseBtn.textContent = '⏸ Pause';
    window.electronAPI.syncToolbar(formatTime(elapsedSeconds), 'recording');
  } else {
    mediaRecorder.pause();
    isPaused = true;
    setStatus('paused');
    pauseBtn.textContent = '▶ Resume';
    window.electronAPI.syncToolbar(formatTime(elapsedSeconds), 'paused');
  }
}

// UI state
function updateButtons(state: 'idle' | 'recording') {
  startBtn.disabled = state === 'recording';
  pauseBtn.disabled = state === 'idle';
  stopBtn.disabled = state === 'idle';
  sourceSelect.disabled = state === 'recording';
  micSelect.disabled = state === 'recording';
  formatSelect.disabled = state === 'recording';
  noiseReductionToggle.disabled = state === 'recording' || !systemAudioToggle.checked;
  systemAudioToggle.disabled = state === 'recording';
  refreshMicBtn.disabled = state === 'recording';
  console.log('[renderer] Buttons updated:', state, '| pause disabled:', pauseBtn.disabled, '| stop disabled:', stopBtn.disabled);
}

// Events
startBtn.onclick = startRecording;
stopBtn.onclick = stopRecording;
pauseBtn.onclick = togglePause;

// Global hotkeys from main process
window.electronAPI.onToggleRecording(() => {
  if (isRecording) stopRecording();
  else startRecording();
});

window.electronAPI.onTogglePause(() => {
  togglePause();
});
