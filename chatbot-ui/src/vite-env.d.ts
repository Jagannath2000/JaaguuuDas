/// <reference types="vite/client" />

interface Window {
  webkitSpeechRecognition?: {
    new (): SpeechRecognition
  }
  SpeechRecognition?: {
    new (): SpeechRecognition
  }
}

interface SpeechRecognition extends EventTarget {
  lang: string
  maxAlternatives: number
  interimResults: boolean
  start: () => void
  stop: () => void
  onresult: (event: SpeechRecognitionEvent) => void
  onend: () => void
  onerror: (event: any) => void
}

interface SpeechRecognitionEvent extends Event {
  results: ArrayLike<{
    0: {
      transcript: string
      confidence: number
    }
  }>
}
