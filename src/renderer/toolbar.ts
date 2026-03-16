declare global {
  interface Window {
    toolbarAPI: {
      onUpdate: (cb: (data: { timer: string; state: 'recording' | 'paused' }) => void) => void;
      pause: () => void;
      stop: () => void;
    };
  }
}

const timerEl = document.getElementById('timer') as HTMLDivElement;
const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement;
const recDot = document.getElementById('recDot') as HTMLDivElement;

window.toolbarAPI.onUpdate(({ timer, state }) => {
  timerEl.textContent = timer;
  timerEl.className = `timer${state === 'paused' ? ' paused' : ''}`;
  recDot.className = `rec-dot${state === 'paused' ? ' paused' : ''}`;
  pauseBtn.textContent = state === 'paused' ? '▶ Resume' : '⏸ Pause';
});

pauseBtn.onclick = () => window.toolbarAPI.pause();
stopBtn.onclick = () => window.toolbarAPI.stop();

export {};
