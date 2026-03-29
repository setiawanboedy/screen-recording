/**
 * AudioWorkletProcessor: Two-Stage Noise Reduction
 *
 * Target: system audio loopback — meredam noise background konstan
 * (kipas, hum, hiss, ambient) tanpa memotong konten audio (musik, dialog).
 *
 * Pipeline:
 *   Input → [Stage 1: STFT Spectral Subtraction] → [Stage 2: RMS Noise Gate] → Output
 *
 * Stage 1 — STFT Spectral Subtraction (frequency domain)
 *   - FFT_SIZE 512, HOP 128 (75% overlap Hann, OLA_NORM = 1.5)
 *   - Kalibrasi 3 detik: estimasi rata-rata power spectrum per frekuensi bin
 *   - Power spectral subtraction: cleanP = max(|X|² − α·N, (β·|X|)²)
 *   - α=2.0 oversubtraction, β=0.15 spectral floor (anti musical-noise artifact)
 *   - Preserves phase, hanya modifikasi magnitude per bin
 *
 * Stage 2 — Adaptive RMS Noise Gate dengan Soft Knee (time domain)
 *   - Menangkap residual broadband noise yang lolos dari Stage 1
 *   - Kalibrasi konkuren 3 detik (pass-through window yang sama dengan Stage 1)
 *   - Threshold lebih agresif (3×) karena Stage 1 sudah bersihkan sebagian besar noise
 *   - Adaptive noise floor tracking + smooth gain envelope
 */

const FFT_SIZE = 512;
const HOP_SIZE = 128;   // 75% overlap — satu AudioWorklet block (128 samples) per hop
const NUM_BINS = (FFT_SIZE >> 1) + 1;
// Normalization untuk analysis×synthesis Hann dengan 75% overlap:
// Σ hann[n + k·HOP]² untuk 4 frame = 1.5 (konstanta di semua posisi n)
const OLA_NORM = 1.5;

// Precompute Hann window (dipakai untuk analysis dan synthesis)
const _hann = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  _hann[i] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / FFT_SIZE));
}

/** In-place radix-2 Cooley-Tukey FFT (length harus power of 2). */
function fft(re, im) {
  const N = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // Butterfly stages
  for (let s = 2; s <= N; s <<= 1) {
    const half  = s >> 1;
    const theta = -Math.PI / half;
    const wRe   = Math.cos(theta);
    const wIm   = Math.sin(theta);
    for (let k = 0; k < N; k += s) {
      let tRe = 1.0, tIm = 0.0;
      for (let j = 0; j < half; j++) {
        const u = k + j, v = u + half;
        const vRe = re[v] * tRe - im[v] * tIm;
        const vIm = re[v] * tIm + im[v] * tRe;
        re[v] = re[u] - vRe;  im[v] = im[u] - vIm;
        re[u] = re[u] + vRe;  im[u] = im[u] + vIm;
        const nr = tRe * wRe - tIm * wIm;
        tIm      = tRe * wIm + tIm * wRe;
        tRe      = nr;
      }
    }
  }
}

/** IFFT via conjugation trick: IFFT(x) = conj(FFT(conj(x))) / N */
function ifft(re, im) {
  const N = re.length;
  for (let i = 0; i < N; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < N; i++) { re[i] /= N; im[i] = -im[i] / N; }
}

class TwoStageNoiseReducer extends AudioWorkletProcessor {
  constructor() {
    super();

    // ── Stage 1: STFT Spectral Subtraction ─────────────────────────────────
    // Per-channel analysis input buffer (menyimpan FFT_SIZE sample terakhir)
    this._inBuf  = [new Float32Array(FFT_SIZE), new Float32Array(FFT_SIZE)];
    // Per-channel OLA synthesis accumulator
    this._outBuf = [new Float32Array(FFT_SIZE), new Float32Array(FFT_SIZE)];
    // Pre-allocated Stage 1 output (hindari alokasi di hot path)
    this._s1Out  = [new Float32Array(HOP_SIZE), new Float32Array(HOP_SIZE)];
    // Shared FFT work arrays (channel diproses sekuensial)
    this._fftRe  = new Float32Array(FFT_SIZE);
    this._fftIm  = new Float32Array(FFT_SIZE);

    // Noise power spectrum (rata-rata per bin, diakumulasi saat kalibrasi)
    this._noisePow    = new Float32Array(NUM_BINS);
    this._calibFrames = 0;
    // 3 detik × (sampleRate / HOP_SIZE) frame; sampleRate adalah global AudioWorklet
    this._calibTarget = Math.round(3 * sampleRate / HOP_SIZE);
    this._calibrated  = false;

    // Hyperparameter spectral subtraction
    this._alpha = 2.0;   // oversubtraction factor — seberapa agresif noise dikurangi
    this._beta  = 0.15;  // spectral floor — mencegah zeroing penuh (anti musical-noise)

    // ── Stage 2: RMS Noise Gate dengan Soft Knee ────────────────────────────
    this._smoothedEnergy  = 0;
    this._noiseFloor      = 0.001;
    this._gain            = 1.0;

    // Kalibrasi Stage 2 berjalan konkuren dengan Stage 1 (3 detik pertama)
    this._gateCalibSum    = 0;
    this._gateCalibFrames = 0;
    this._gateCalibTarget = Math.round(3 * sampleRate / 128);
    this._gateCalibrated  = false;

    // ── IPC ─────────────────────────────────────────────────────────────────
    this.port.onmessage = (e) => {
      if (e.data.type === 'recalibrate') {
        this._noisePow.fill(0);
        this._calibFrames     = 0;
        this._calibrated      = false;
        this._gateCalibSum    = 0;
        this._gateCalibFrames = 0;
        this._gateCalibrated  = false;
        this._smoothedEnergy  = 0;
        this._noiseFloor      = 0.001;
        this._gain            = 1.0;
        this._inBuf[0].fill(0);  this._inBuf[1].fill(0);
        this._outBuf[0].fill(0); this._outBuf[1].fill(0);
      }
    };
  }

  /**
   * Proses satu STFT frame untuk satu channel.
   * - Saat kalibrasi: akumulasi power spectrum per bin, pass-through ke OLA.
   * - Setelah kalibrasi: power spectral subtraction, preserve phase, overlap-add.
   */
  _stftFrame(c) {
    const re    = this._fftRe;
    const im    = this._fftIm;
    const inBuf = this._inBuf[c];

    // Analysis: Hann window
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = inBuf[i] * _hann[i];
      im[i] = 0.0;
    }

    fft(re, im);

    if (!this._calibrated) {
      // Akumulasi power per bin untuk estimasi noise spectrum
      for (let k = 0; k < NUM_BINS; k++) {
        this._noisePow[k] += re[k] * re[k] + im[k] * im[k];
      }
      // Tidak ada modifikasi spektral — fall through ke IFFT untuk pass-through
    } else {
      // Power spectral subtraction — modifikasi magnitude, preservasi phase
      for (let k = 0; k < NUM_BINS; k++) {
        const mag2   = re[k] * re[k] + im[k] * im[k];
        const mag    = Math.sqrt(mag2);
        // cleanP = max(input power − α·noise power, (β·mag)²)
        const cleanP = Math.max(
          mag2 - this._alpha * this._noisePow[k],
          this._beta * this._beta * mag2
        );
        const scale = mag > 1e-10 ? Math.sqrt(cleanP) / mag : 0.0;
        re[k] *= scale;
        im[k] *= scale;
        // Mirror ke conjugate-symmetric bin agar IFFT output tetap real-valued
        if (k > 0 && k < (FFT_SIZE >> 1)) {
          re[FFT_SIZE - k] *= scale;
          im[FFT_SIZE - k] *= scale;
        }
      }
    }

    ifft(re, im);

    // Synthesis: Hann window + overlap-add ke accumulator
    const outBuf = this._outBuf[c];
    for (let i = 0; i < FFT_SIZE; i++) {
      outBuf[i] += re[i] * _hann[i];
    }
  }

  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0) return true;

    const chCount   = Math.min(input.length, output.length);
    const blockSize = input[0] ? input[0].length : 128;

    // ── Update analysis buffers (FIFO: shift kiri + append block baru) ──────
    for (let c = 0; c < chCount; c++) {
      const inBuf = this._inBuf[c];
      inBuf.copyWithin(0, blockSize);
      inBuf.set(input[c], FFT_SIZE - blockSize);
    }

    // ── Stage 1: STFT frame per channel ─────────────────────────────────────
    for (let c = 0; c < chCount; c++) {
      this._stftFrame(c);
    }

    // Finalisasi kalibrasi Stage 1 setelah calibTarget frame
    if (!this._calibrated) {
      this._calibFrames++;
      if (this._calibFrames >= this._calibTarget) {
        // Rata-rata power spectrum: total accumulation / (frames × channels)
        const divisor = this._calibTarget * chCount;
        for (let k = 0; k < NUM_BINS; k++) this._noisePow[k] /= divisor;
        this._calibrated = true;
        let meanPow = 0;
        for (let k = 0; k < NUM_BINS; k++) meanPow += this._noisePow[k];
        this.port.postMessage({ type: 'stage1-calibrated', meanNoisePow: meanPow / NUM_BINS });
      }
    }

    // ── Baca output Stage 1 dari OLA accumulator ─────────────────────────────
    for (let c = 0; c < chCount; c++) {
      const outBuf = this._outBuf[c];
      const dst    = this._s1Out[c];
      for (let i = 0; i < blockSize; i++) {
        dst[i] = outBuf[i] / OLA_NORM;
      }
      // Geser OLA buffer kiri, zeroing tail yang kosong
      outBuf.copyWithin(0, blockSize);
      outBuf.fill(0, FFT_SIZE - blockSize);
    }

    // ── Stage 2: RMS Noise Gate (beroperasi pada output Stage 1) ─────────────
    // Hitung RMS energy dari semua channel
    let sumSq = 0, n = 0;
    for (let c = 0; c < chCount; c++) {
      const ch = this._s1Out[c];
      for (let i = 0; i < blockSize; i++) { sumSq += ch[i] * ch[i]; n++; }
    }
    const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;

    // Envelope follower — attack cepat, release lambat (noise steady = release lambat)
    const envAlpha       = rms > this._smoothedEnergy ? 0.15 : 0.008;
    this._smoothedEnergy = envAlpha * rms + (1 - envAlpha) * this._smoothedEnergy;

    // Kalibrasi Stage 2 (konkuren dengan Stage 1 — window 3 detik yang sama)
    if (!this._gateCalibrated) {
      this._gateCalibSum += rms;
      this._gateCalibFrames++;
      if (this._gateCalibFrames >= this._gateCalibTarget) {
        const avgRms         = this._gateCalibSum / this._gateCalibFrames;
        this._noiseFloor     = Math.max(avgRms * 2.0, 0.0003);
        this._gateCalibrated = true;
        this.port.postMessage({ type: 'stage2-calibrated', noiseFloor: this._noiseFloor, avgRms });
      }
    }

    // Adaptive noise floor tracking (hanya saat sinyal diam)
    if (this._gateCalibrated && this._smoothedEnergy < this._noiseFloor * 1.5) {
      this._noiseFloor = 0.9995 * this._noiseFloor + 0.0005 * this._smoothedEnergy;
    }

    // Soft-knee gate — lebih agresif dari standalone karena Stage 1 sudah bersihkan gross noise
    const threshold = this._noiseFloor * 3.0; // 4× di versi lama
    const kneeTop   = threshold * 2.5;         // knee lebih sempit untuk cutoff lebih bersih

    let targetGain;
    if (this._smoothedEnergy < threshold) {
      targetGain = 0.05;  // attenuate residual, hindari hard mute
    } else if (this._smoothedEnergy < kneeTop) {
      const t    = (this._smoothedEnergy - threshold) / (kneeTop - threshold);
      targetGain = 0.05 + 0.95 * t;
    } else {
      targetGain = 1.0;
    }

    // Gain smoothing — mencegah pumping artifact
    const gAlpha = targetGain > this._gain ? 0.25 : 0.02;
    this._gain   = gAlpha * targetGain + (1 - gAlpha) * this._gain;

    // ── Output final ─────────────────────────────────────────────────────────
    for (let c = 0; c < chCount; c++) {
      const och = output[c];
      if (!och) continue;
      const s1 = this._s1Out[c];
      for (let i = 0; i < blockSize; i++) {
        och[i] = s1[i] * this._gain;
      }
    }

    return true;
  }
}

registerProcessor('noise-gate-processor', TwoStageNoiseReducer);
