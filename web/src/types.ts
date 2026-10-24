export type MemberView = {
	id: string
	name: string
	muted: boolean
	speaking: boolean
}

export type RoomConfigView = {
	sampleRate: number
	frameMs: number
	maxSpeakMs: number
	halfDuplex: boolean
	speakMode: 'preempt' | 'exclusive'
}

export type ServerEvent =
	| {
			t: 'welcome'
			you: { id: string; name: string }
			room: { name: string }
			members: MemberView[]
			speaker: { id: string; name: string } | null
			cfg: RoomConfigView
	  }
	| { t: 'members'; members: MemberView[] }
	| { t: 'speaker'; id: string | null; name: string | null }
	| { t: 'error'; code: string; message: string }

export type ClientEvent =
	| { t: 'join'; name: string; code: string }
	| { t: 'speak'; on: boolean }
	| { t: 'mute'; on: boolean }
	| { t: 'ping' }

export type ConnStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'closed'

export type Creds = { name: string; code: string }
