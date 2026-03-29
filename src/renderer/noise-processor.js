/**
 * AudioWorkletProcessor: Background Noise Reduction
 *
 * Target: system audio loopback — meredam noise background yang konstan
 * (kipas, hum, hiss, ambient) tanpa memotong suara konten (musik, dialog).
 *
 * Algoritma:
 * - Kalibrasi 3 detik pertama untuk estimasi noise floor baseline
 * - Spectral gate dengan soft-knee: sinyal di bawah threshold di-attenuate
 * - Threshold konservatif (4× noise floor) agar konten audio tidak terpotong
 * - Adaptive: noise floor terus diperbarui saat sinyal diam
 */
class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._smoothedEnergy = 0;
    this._noiseFloor = 0.001;
    this._calibrationFrames = 0;
    this._calibrationSum = 0;
    // Kalibrasi 3 detik (48000 / 128 ≈ 375 frames/detik × 3)
    this._calibrationTarget = 1125;
    this._calibrated = false;
    this._gain = 1.0;

    this.port.onmessage = (e) => {
      if (e.data.type === 'recalibrate') {
        this._calibrated = false;
        this._calibrationFrames = 0;
        this._calibrationSum = 0;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0) return true;

    // Handle mono atau stereo — proses semua channel
    const channelCount = Math.min(input.length, output.length);

    // Hitung RMS dari semua channel (mix-down untuk deteksi energy)
    let sumSq = 0;
    let sampleCount = 0;
    for (let c = 0; c < channelCount; c++) {
      const ch = input[c];
      if (!ch) continue;
      for (let i = 0; i < ch.length; i++) {
        sumSq += ch[i] * ch[i];
        sampleCount++;
      }
    }
    const rms = sampleCount > 0 ? Math.sqrt(sumSq / sampleCount) : 0;

    // Envelope follower — attack cepat, release lambat
    // Background noise sifatnya steady, release lambat agar tidak pumping
    const attack = 0.15;
    const release = 0.008;
    const alpha = rms > this._smoothedEnergy ? attack : release;
    this._smoothedEnergy = alpha * rms + (1 - alpha) * this._smoothedEnergy;

    // Fase kalibrasi: pass-through sambil ukur noise floor
    if (!this._calibrated) {
      this._calibrationSum += rms;
      this._calibrationFrames++;
      if (this._calibrationFrames >= this._calibrationTarget) {
        const avgRms = this._calibrationSum / this._calibrationFrames;
        // Margin 2× dari rata-rata untuk noise floor yang stabil
        this._noiseFloor = Math.max(avgRms * 2.0, 0.0003);
        this._calibrated = true;
        this.port.postMessage({ type: 'calibrated', noiseFloor: this._noiseFloor, avgRms });
      }
      // Pass-through selama kalibrasi
      for (let c = 0; c < channelCount; c++) {
        const ich = input[c];
        const och = output[c];
        if (ich && och) {
          for (let i = 0; i < ich.length; i++) och[i] = ich[i];
        }
      }
      return true;
    }

    // Adaptive tracking: noise floor turun perlahan saat sinyal diam
    if (this._smoothedEnergy < this._noiseFloor * 1.5) {
      this._noiseFloor = 0.9995 * this._noiseFloor + 0.0005 * this._smoothedEnergy;
    }

    // Threshold konservatif: 4× noise floor
    // Lebih tinggi dari versi mic agar konten audio (musik, dialog) tidak terpotong
    const threshold = this._noiseFloor * 4.0;
    const kneeTop = threshold * 3.0;

    let targetGain;
    if (this._smoothedEnergy < threshold) {
      // Pure background noise → attenuate tapi tidak mute penuh (hindari dead silence artifisial)
      targetGain = 0.08;
    } else if (this._smoothedEnergy < kneeTop) {
      // Soft knee — interpolasi smooth antara attenuated dan full pass
      const t = (this._smoothedEnergy - threshold) / (kneeTop - threshold);
      targetGain = 0.08 + 0.92 * t;
    } else {
      // Konten audio yang jelas → pass-through penuh
      targetGain = 1.0;
    }

    // Gain smoothing — lambat untuk background noise agar tidak ada pumping artifact
    const gainAttack = 0.25;
    const gainRelease = 0.02;
    const gainAlpha = targetGain > this._gain ? gainAttack : gainRelease;
    this._gain = gainAlpha * targetGain + (1 - gainAlpha) * this._gain;

    // Apply gain ke semua channel
    for (let c = 0; c < channelCount; c++) {
      const ich = input[c];
      const och = output[c];
      if (ich && och) {
        for (let i = 0; i < ich.length; i++) {
          och[i] = ich[i] * this._gain;
        }
      }
    }

    return true;
  }
}

registerProcessor('noise-gate-processor', NoiseGateProcessor);
