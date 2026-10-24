/**
 * 采集 worklet —— 纯 classic script（AudioWorklet 用 addModule 加载，不走打包链）
 *
 * 职责：把麦克风 Float32 采样转成 16kHz / 单声道 / Int16LE 的 20ms 定长帧。
 *
 * 正常情况下 AudioContext 就是用 { sampleRate: 16000 } 创建的，
 * 此时 globalThis.sampleRate === 16000，ratio === 1，走零成本的直通路径。
 * 个别浏览器会忽略 sampleRate 选项（比如部分 Safari 版本），此时 ratio > 1，
 * 走滑动平均降采样（box filter，兼作抗混叠低通）。
 */
const TARGET_RATE = 16000
const FRAME_SAMPLES = 320 // 20ms @ 16kHz

class CaptureProcessor extends AudioWorkletProcessor {
	constructor() {
		super()
		this.ratio = sampleRate / TARGET_RATE
		this.frame = new Float32Array(FRAME_SAMPLES)
		this.filled = 0
		this.sum = 0
		this.count = 0
		this.level = 0
		this.lastLevelReport = 0
	}

	process(inputs, outputs) {
		const input = inputs[0]
		if (!input || input.length === 0) return true
		const ch = input[0]
		if (!ch || ch.length === 0) return true

		if (this.ratio <= 1) {
			// 原速或需要上采样：最近邻复制
			const copies = this.ratio < 1 ? Math.max(1, Math.round(1 / this.ratio)) : 1
			for (let i = 0; i < ch.length; i++) {
				const s = ch[i] ?? 0
				this.push(s)
				for (let k = 1; k < copies; k++) this.push(s)
			}
		} else {
			// 降采样：滑动平均
			for (let i = 0; i < ch.length; i++) {
				this.sum += ch[i] ?? 0
				this.count++
				if (this.count >= this.ratio) {
					this.push(this.sum / this.count)
					this.sum = 0
					this.count = 0
				}
			}
		}

		// 顺便上报本地电平，用于 UI 上的音量指示
		const now = currentTime
		if (now - this.lastLevelReport > 0.1) {
			this.lastLevelReport = now
			this.port.postMessage({ type: 'level', level: this.level })
			this.level = 0
		}
		return true
	}

	push(sample) {
		const a = sample < 0 ? -sample : sample
		if (a > this.level) this.level = a

		this.frame[this.filled++] = sample
		if (this.filled < FRAME_SAMPLES) return

		const out = new Int16Array(FRAME_SAMPLES)
		for (let i = 0; i < FRAME_SAMPLES; i++) {
			let s = this.frame[i] ?? 0
			if (s > 1) s = 1
			else if (s < -1) s = -1
			out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
		}
		this.port.postMessage(out.buffer, [out.buffer])
		this.filled = 0
	}
}

registerProcessor('capture', CaptureProcessor)
