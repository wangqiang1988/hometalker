export interface WakeLockSentinelLike {
	released: boolean
	release(): Promise<void>
	addEventListener(type: 'release', listener: () => void): void
}

declare global {
	interface Navigator {
		wakeLock?: {
			request(type: 'screen'): Promise<WakeLockSentinelLike>
		}
	}
}

export {}
