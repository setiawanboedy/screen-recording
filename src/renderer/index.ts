declare global {
  interface Window {
    electronAPI: {
      getSources: () => Promise<Array<{ id: string; name: string; thumbnail: string }>>;
      setSource: (sourceId: string) => Promise<void>;
      saveRecording: (buffer: ArrayBuffer, filename: string) => Promise<{ success?: boolean; filePath?: string; canceled?: boolean }>;
      setRecordingStatus: (status: string) => void;
      onToggleRecording: (callback: () => void) => void;
      onTogglePause: (callback: () => void) => void;
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
const timerEl = document.getElementById('timer') as HTMLDivElement;
const statusBadge = document.getElementById('statusBadge') as HTMLSpanElement;

// State
let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let timerInterval: ReturnType<typeof setInterval> | null = null;
let elapsedSeconds = 0;
let isPaused = false;
let isRecording = false;
let activeStreams: MediaStream[] = [];

// Timer
function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function startTimer() {
  elapsedSeconds = 0;
  timerEl.textContent = '00:00:00';
  timerInterval = setInterval(() => {
    if (!isPaused) {
      elapsedSeconds++;
      timerEl.textContent = formatTime(elapsedSeconds);
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

// Get audio input devices
async function getAudioDevices() {
  try {
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    tempStream.getTracks().forEach(t => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    console.log('[renderer] Found', audioInputs.length, 'audio inputs');

    micSelect.innerHTML = '<option value="">No microphone</option>';
    audioInputs.forEach(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.text = device.label || `Microphone ${micSelect.options.length}`;
      micSelect.appendChild(option);
    });

    if (audioInputs.length > 0 && audioInputs[0]) {
      micSelect.value = audioInputs[0].deviceId;
    }
  } catch (err) {
    console.error('[renderer] getAudioDevices error:', err);
    micSelect.innerHTML = '<option value="">Microphone not available</option>';
  }
}

// Initialize
getSources();
getAudioDevices();

// Cleanup
function cleanupStreams() {
  activeStreams.forEach(s => s.getTracks().forEach(t => t.stop()));
  activeStreams = [];
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

    // Tell main process which source to use
    await window.electronAPI.setSource(sourceId);

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
    const dest = audioContext.createMediaStreamDestination();
    let hasAudio = false;

    // System audio from screen capture
    if (screenStream.getAudioTracks().length > 0) {
      const sysAudioTrack = screenStream.getAudioTracks()[0]!;
      const sysSource = audioContext.createMediaStreamSource(new MediaStream([sysAudioTrack]));
      sysSource.connect(dest);
      hasAudio = true;
      console.log('[renderer] System audio connected');
    }

    // Microphone
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
    recordedChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      console.log('[renderer] Recording stopped, chunks:', recordedChunks.length);
      const blob = new Blob(recordedChunks, { type: mimeType });
      const buffer = await blob.arrayBuffer();

      const result = await window.electronAPI.saveRecording(buffer, `recording-${Date.now()}.webm`);
      if (result.filePath) {
        console.log('[renderer] Saved to', result.filePath);
      }

      recordedChunks = [];
      cleanupStreams();
      stopTimer();
      setStatus('idle');
      updateButtons('idle');
      isRecording = false;
      isPaused = false;
    };

    mediaRecorder.start(1000);
    isRecording = true;
    isPaused = false;
    startTimer();
    setStatus('recording');
    updateButtons('recording');
    console.log('[renderer] Recording started!');

  } catch (err) {
    console.error('[renderer] startRecording error:', err);
    alert(`Error: ${err instanceof Error ? err.message : String(err)}`);
    cleanupStreams();
  }
}

// Stop recording
function stopRecording() {
  console.log('[renderer] stopRecording called, state:', mediaRecorder?.state);
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
  } else {
    mediaRecorder.pause();
    isPaused = true;
    setStatus('paused');
    pauseBtn.textContent = '▶ Resume';
  }
}

// UI state
function updateButtons(state: 'idle' | 'recording') {
  startBtn.disabled = state === 'recording';
  pauseBtn.disabled = state === 'idle';
  stopBtn.disabled = state === 'idle';
  sourceSelect.disabled = state === 'recording';
  micSelect.disabled = state === 'recording';
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
