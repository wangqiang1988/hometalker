/**
 * 播放 worklet —— 纯 classic script
 *
 * 职责：接收服务端转发来的 Int16LE 16kHz 帧，用环形缓冲重建成连续音频输出。
 *
 * 环形缓冲约 1 秒（16384 样本），实际使用量由客户端控制；
 * 正常情况下 AudioContext 就是 16kHz，step === 1，逐样本直通。
 * 若浏览器忽略了 sampleRate:16000，step < 1，会自动做线性插值升采样，避免变调。
 */
const SRC_RATE = 16000
const CAPACITY = 16384 // 约 1 秒 @16kHz

class PlaybackProcessor extends AudioWorkletProcessor {
	constructor() {
		super()
		this.ring = new Int16Array(CAPACITY)
		this.w = 0
		this.n = 0
		this.r = 0
		this.phase = 0
		this.step = SRC_RATE / sampleRate
		this.level = 0
		this.lastReport = 0

		// 收到服务端转发的音频帧，写入环形缓冲
		this.port.onmessage = (e) => {
			const data = e.data
			if (!(data instanceof ArrayBuffer)) return
			const samples = new Int16Array(data)
			for (let i = 0; i < samples.length; i++) {
				this.ring[this.w] = samples[i]
				this.w = (this.w + 1) % CAPACITY
				if (this.n < CAPACITY) this.n++
			}
		}
	}

	process(inputs, outputs) {
		const out = outputs[0]
		if (!out || out.length === 0) return true
		const ch = out[0]

		for (let i = 0; i < ch.length; i++) {
			if (this.n <= 0) {
				ch[i] = 0
				continue
			}
			const s0 = this.ring[this.r]
			const s1 = this.n > 1 ? this.ring[(this.r + 1) % CAPACITY] : s0
			const v = (s0 + (s1 - s0) * this.phase) / 32768
			ch[i] = v

			const a = v < 0 ? -v : v
			if (a > this.level) this.level = a

			this.phase += this.step
			while (this.phase >= 1) {
				this.phase -= 1
				this.r = (this.r + 1) % CAPACITY
				this.n--
				if (this.n <= 0) {
					this.phase = 0
					break
				}
			}
		}

		const now = currentTime
		if (now - this.lastReport > 0.1) {
			this.lastReport = now
			this.port.postMessage({ type: 'level', level: this.level, buffered: this.n })
			this.level = 0
		}
		return true
	}
}

registerProcessor('playback', PlaybackProcessor)
