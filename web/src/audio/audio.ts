const SAMPLE_RATE = 16000

export type AudioLinkOptions = {
	/** 采集到的 20ms 音频帧（Int16LE） */
	onFrame: (buf: ArrayBuffer) => void
	/** 本地麦克风电平 0..1 */
	onLocalLevel?: (level: number) => void
	/** 远端播放电平 0..1 */
	onRemoteLevel?: (level: number) => void
	/** 播放端是否发生过欠载（缓冲耗尽） */
	onUnderrun?: () => void
}

/**
 * 浏览器端音频管线。
 *
 * 采集：getUserMedia(AEC/NS/AGC) → GainNode → capture worklet → Int16 20ms 帧
 * 播放：服务端帧 → playback worklet 环形缓冲 → GainNode → 扬声器
 *
 * AudioContext 用 { sampleRate: 16000 } 创建，整个音频图原生跑 16kHz，
 * 省掉手写重采样；若浏览器忽略该选项，worklet 内部会自动兜底。
 */
export class AudioLink {
	private ctx: AudioContext
	private playNode: AudioWorkletNode | null = null
	private playGain: GainNode | null = null
	private captureNode: AudioWorkletNode | null = null
	private captureGain: GainNode | null = null
	private stream: MediaStream | null = null
	private ready = false
	private opts: AudioLinkOptions
	private lastRemoteLevel = 0
	private underrunFlagged = false

	constructor(opts: AudioLinkOptions) {
		this.opts = opts
		this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
	}

	get contextState(): AudioContextState {
		return this.ctx.state
	}

	/** 必须在用户手势里调用（iOS 硬性要求） */
	async unlock(): Promise<void> {
		if (this.ctx.state === 'suspended') {
			await this.ctx.resume().catch(() => {})
		}
		await this.init()
	}

	async init(): Promise<void> {
		if (this.ready) return
		if (!this.ctx.audioWorklet) {
			throw new Error('当前浏览器不支持 AudioWorklet')
		}
		await this.ctx.audioWorklet.addModule('/worklets/playback.js')
		this.playNode = new AudioWorkletNode(this.ctx, 'playback')
		this.playGain = this.ctx.createGain()
		this.playNode.connect(this.playGain).connect(this.ctx.destination)
		this.playNode.port.onmessage = (e) => {
			const d = e.data as { type?: string; level?: number; buffered?: number }
			if (d?.type === 'level') {
				this.lastRemoteLevel = d.level ?? 0
				this.opts.onRemoteLevel?.(this.lastRemoteLevel)
				if ((d.buffered ?? 0) === 0 && this.lastRemoteLevel === 0) {
					if (!this.underrunFlagged) {
						this.underrunFlagged = true
						this.opts.onUnderrun?.()
					}
				} else {
					this.underrunFlagged = false
				}
			}
		}
		this.ready = true
	}

	/** 首次调用会弹出麦克风授权（必须在用户手势里） */
	async startCapture(): Promise<void> {
		await this.init()
		if (this.captureNode) return
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error('当前浏览器不支持麦克风采集')
		}

		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
				channelCount: 1,
			},
			video: false,
		})

		await this.ctx.audioWorklet.addModule('/worklets/capture.js')
		const source = this.ctx.createMediaStreamSource(this.stream)
		this.captureGain = this.ctx.createGain()
		this.captureGain.gain.value = 1
		this.captureNode = new AudioWorkletNode(this.ctx, 'capture')

		// capture worklet 不往输出写数据（输出恒为静音），但必须连到 destination 才会被调度
		const mute = this.ctx.createGain()
		mute.gain.value = 0
		source.connect(this.captureGain).connect(this.captureNode).connect(mute).connect(this.ctx.destination)

		this.captureNode.port.onmessage = (e) => {
			const d = e.data
			if (d instanceof ArrayBuffer) {
				this.opts.onFrame(d)
			} else if (d && typeof d === 'object' && d.type === 'level') {
				this.opts.onLocalLevel?.(d.level ?? 0)
			}
		}
	}

	stopCapture(): void {
		if (this.captureNode) {
			this.captureNode.port.onmessage = null
			this.captureNode.disconnect()
			this.captureNode = null
		}
		if (this.captureGain) {
			this.captureGain.disconnect()
			this.captureGain = null
		}
		if (this.stream) {
			for (const track of this.stream.getTracks()) track.stop()
			this.stream = null
		}
	}

	/** 收到服务端转发的音频 */
	pushFrame(data: ArrayBuffer): void {
		this.playNode?.port.postMessage(data)
	}

	setPlaybackVolume(v: number): void {
		if (this.playGain) this.playGain.gain.value = Math.max(0, Math.min(1, v))
	}

	setCaptureGain(v: number): void {
		if (this.captureGain) this.captureGain.gain.value = Math.max(0.2, Math.min(3, v))
	}

	async resume(): Promise<void> {
		if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {})
	}

	async close(): Promise<void> {
		this.stopCapture()
		try {
			await this.ctx.close()
		} catch {
			/* ignore */
		}
	}
}
