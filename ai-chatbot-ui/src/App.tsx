import { useEffect, useRef, useState } from 'react'
import './App.css'
import 'bootstrap/dist/css/bootstrap.min.css'
import 'bootstrap-icons/font/bootstrap-icons.css'
import { v4 as uuidv4 } from 'uuid'
import EmojiPicker from 'emoji-picker-react'
import type { EmojiClickData, Theme as EmojiTheme } from 'emoji-picker-react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Tooltip,
  Legend,
  Title,
  Filler,
} from 'chart.js'
import { Bar, Line, Pie } from 'react-chartjs-2'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Tooltip,
  Legend,
  Title,
  Filler,
)

// Message types per spec
export type Message = {
  id: string
  sender: 'user' | 'bot'
  type: 'text' | 'chart'
  content: string
  timestamp: number
  // Optional file metadata for extra feature
  fileUrl?: string
  fileName?: string
  fileType?: string
}

export type ChartPayload = {
  chartType: 'bar' | 'line' | 'pie'
  data: any
  options?: any
}

function formatTime(epochMs: number) {
  const d = new Date(epochMs)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function useDarkMode() {
  const [isDark, setIsDark] = useState<boolean>(() => {
    const persisted = localStorage.getItem('theme')
    if (persisted) return persisted === 'dark'
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  useEffect(() => {
    const theme = isDark ? 'dark' : 'light'
    document.documentElement.setAttribute('data-bs-theme', theme)
    localStorage.setItem('theme', theme)
  }, [isDark])
  return { isDark, setIsDark }
}

export default function App() {
  const { isDark, setIsDark } = useDarkMode()
  const [messages, setMessages] = useState<Message[]>([{
    id: uuidv4(), sender: 'bot', type: 'text', content: 'Hello! I\'m your AI assistant. Ask me anything, or say "chart bar" to see a chart example.', timestamp: Date.now()
  }])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const emojiContainerRef = useRef<HTMLDivElement | null>(null)
  const recognitionRef = useRef<any>(null)
  const lastTranscriptRef = useRef<string>('')

  // Scroll to bottom on new messages
  useEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages, isTyping])

  // Setup SpeechRecognition
  useEffect(() => {
    const w = window as unknown as any
    const SpeechRecognitionCtor = w.SpeechRecognition || w.webkitSpeechRecognition
    if (SpeechRecognitionCtor) {
      recognitionRef.current = new SpeechRecognitionCtor()
      recognitionRef.current.lang = 'en-US'
      recognitionRef.current.continuous = false
      recognitionRef.current.interimResults = false
      recognitionRef.current.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          .map((r: any) => r[0])
          .map((r: any) => r.transcript)
          .join(' ')
        const cleaned = (transcript || '').trim()
        if (cleaned) {
          lastTranscriptRef.current = cleaned
          setInput(cleaned)
        }
      }
      recognitionRef.current.onend = () => {
        setIsListening(false)
        const finalText = lastTranscriptRef.current.trim()
        if (finalText) {
          handleSend(finalText)
          lastTranscriptRef.current = ''
        }
      }
      recognitionRef.current.onerror = () => {
        setIsListening(false)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const canUseVoice = !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)

  function toggleListening() {
    if (!recognitionRef.current) return
    if (isListening) {
      recognitionRef.current.stop()
      setIsListening(false)
    } else {
      lastTranscriptRef.current = ''
      setIsListening(true)
      try {
        recognitionRef.current.start()
      } catch (e) {
        // some browsers throw if start called twice
      }
    }
  }

  function addMessage(msg: Message) {
    setMessages(prev => [...prev, msg])
  }

  // Dummy AI response simulation
  function simulateBotResponse(userText: string): Promise<Message> {
    return new Promise((resolve) => {
      setTimeout(() => {
        // Chart triggers
        const lower = userText.toLowerCase()
        if (lower.includes('chart')) {
          let chartType: ChartPayload['chartType'] = 'bar'
          if (lower.includes('pie')) chartType = 'pie'
          else if (lower.includes('line')) chartType = 'line'

          const labels = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']
          const data = labels.map(() => Math.floor(Math.random() * 100))

          const payload: ChartPayload = {
            chartType,
            data: {
              labels,
              datasets: [
                {
                  label: 'Sample Data',
                  data,
                  backgroundColor: chartType === 'pie'
                    ? ['#0d6efd', '#6f42c1', '#20c997', '#fd7e14', '#dc3545']
                    : 'rgba(13, 110, 253, 0.6)',
                  borderColor: chartType === 'pie' ? undefined : '#0d6efd',
                  fill: chartType === 'line',
                  tension: 0.35,
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: true }, title: { display: false } },
              scales: chartType === 'pie' ? undefined : { x: { grid: { display: false } }, y: { beginAtZero: true } },
            },
          }

          resolve({
            id: uuidv4(),
            sender: 'bot',
            type: 'chart',
            content: JSON.stringify(payload),
            timestamp: Date.now(),
          })
          return
        }

        // If JSON payload provided, try parse for a chart
        try {
          const maybe = JSON.parse(userText)
          if (maybe && (maybe.chartType === 'bar' || maybe.chartType === 'line' || maybe.chartType === 'pie')) {
            resolve({ id: uuidv4(), sender: 'bot', type: 'chart', content: JSON.stringify(maybe), timestamp: Date.now() })
            return
          }
        } catch {}

        // Otherwise basic echo/text
        const canned = [
          'Here\'s what I found!',
          'Absolutely. Let me help with that.',
          'Done. Anything else I can do?',
          'Interesting question. I\'ve added some context above.',
        ]
        const text = canned[Math.floor(Math.random() * canned.length)]
        resolve({ id: uuidv4(), sender: 'bot', type: 'text', content: text, timestamp: Date.now() })
      }, 1100 + Math.random() * 900)
    })
  }

  async function handleSend(overrideText?: string) {
    const trimmed = (overrideText ?? input).trim()
    if (!trimmed) return

    const userMsg: Message = { id: uuidv4(), sender: 'user', type: 'text', content: trimmed, timestamp: Date.now() }
    addMessage(userMsg)
    setInput('')
    setShowEmoji(false)

    setIsTyping(true)
    const botMsg = await simulateBotResponse(trimmed)
    setIsTyping(false)
    addMessage(botMsg)
  }

  function onEmojiClick(emojiData: EmojiClickData) {
    setInput(prev => prev + (emojiData.emoji || ''))
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSend()
    }
  }

  function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || !files.length) return

    Array.from(files).forEach(file => {
      const url = URL.createObjectURL(file)
      const isImage = file.type.startsWith('image/')
      const content = isImage ? `Sent an image: ${file.name}` : `Sent a file: ${file.name}`
      const msg: Message = {
        id: uuidv4(), sender: 'user', type: 'text', content, timestamp: Date.now(), fileUrl: url, fileName: file.name, fileType: file.type
      }
      addMessage(msg)
    })

    // Clear input value so the same file can be selected again
    e.target.value = ''

    // Optional: bot acknowledgement
    setIsTyping(true)
    setTimeout(() => {
      setIsTyping(false)
      addMessage({ id: uuidv4(), sender: 'bot', type: 'text', content: 'Thanks! I\'ve received the file(s).', timestamp: Date.now() })
    }, 900)
  }

  function renderChartFromContent(content: string) {
    let payload: ChartPayload | null = null
    try {
      payload = JSON.parse(content)
    } catch {}

    if (!payload) return null
    const commonProps = { data: payload.data, options: payload.options }
    switch (payload.chartType) {
      case 'bar':
        return <div className="chart-bubble"><Bar {...commonProps} /></div>
      case 'line':
        return <div className="chart-bubble"><Line {...commonProps} /></div>
      case 'pie':
        return <div className="chart-bubble"><Pie {...commonProps} /></div>
      default:
        return null
    }
  }

  return (
    <div className="min-vh-100 w-100">
      {/* Top Navbar */}
      <nav className="navbar navbar-expand fixed-top border-bottom navbar-blur px-3">
        <div className="container-fluid">
          <div className="d-flex align-items-center gap-2">
            <div className="avatar avatar-bot">
              <i className="bi bi-robot"></i>
            </div>
            <div className="d-flex flex-column lh-1">
              <span className="fw-semibold">Nebula AI</span>
              <small className="text-success">● online</small>
            </div>
          </div>

          <div className="d-flex align-items-center gap-2">
            <button className="btn btn-sm btn-outline-secondary" onClick={() => setIsDark(d => !d)} aria-label="Toggle dark mode">
              <i className={isDark ? 'bi bi-moon-stars' : 'bi bi-brightness-high'}></i>
            </button>
            <a className="btn btn-sm btn-outline-primary" href="#" onClick={(e) => e.preventDefault()}>
              <i className="bi bi-gear"></i>
            </a>
          </div>
        </div>
      </nav>

      {/* Chat Area */}
      <main className="chat-wrapper container-fluid">
        <div ref={chatScrollRef} className="chat-area chat-scroll container glass border-0 rounded-4 p-3 mt-2">
          {/* Messages */}
          <div className="d-flex flex-column gap-3">
            {messages.map(msg => (
              <div key={msg.id} className={`d-flex ${msg.sender === 'user' ? 'justify-content-end' : 'justify-content-start'} fade-in`}>
                {msg.sender === 'bot' && (
                  <div className="me-2 mt-auto avatar avatar-bot"><i className="bi bi-robot"></i></div>
                )}

                <div className={`message-bubble bubble ${msg.sender === 'user' ? 'bubble-user' : 'bubble-bot'}`}>
                  {/* File preview if present */}
                  {msg.fileUrl && msg.fileType?.startsWith('image/') && (
                    <img src={msg.fileUrl} alt={msg.fileName} className="file-preview mb-2" />
                  )}
                  {msg.fileUrl && !msg.fileType?.startsWith('image/') && (
                    <div className="d-flex align-items-center gap-2 mb-2">
                      <i className="bi bi-file-earmark-text fs-4"></i>
                      <a href={msg.fileUrl} download={msg.fileName} className="link-underline-opacity-0">
                        {msg.fileName}
                      </a>
                    </div>
                  )}

                  {/* Content */}
                  {msg.type === 'chart' ? (
                    renderChartFromContent(msg.content)
                  ) : (
                    <div>{msg.content}</div>
                  )}

                  <div className="text-end bubble-timestamp mt-1">
                    {formatTime(msg.timestamp)}
                  </div>
                </div>

                {msg.sender === 'user' && (
                  <div className="ms-2 mt-auto avatar avatar-user"><i className="bi bi-person"></i></div>
                )}
              </div>
            ))}

            {/* Typing indicator */}
            {isTyping && (
              <div className="d-flex justify-content-start fade-in">
                <div className="me-2 mt-auto avatar avatar-bot"><i className="bi bi-robot"></i></div>
                <div className="bubble bubble-bot">
                  <span className="me-2">Bot is typing</span>
                  <span className="typing-dots"><span></span><span></span><span></span></span>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Input Bar */}
      <div className="position-fixed bottom-0 start-0 end-0 p-2 pb-3">
        <div className="container">
          <div className={`rounded-4 p-2 ${isDark ? 'glass' : 'glass-light'}`} style={{ backdropFilter: 'blur(10px)' }}>
            <div className="input-group align-items-center">
              <button
                className="btn btn-outline-secondary input-actions position-relative"
                type="button"
                onClick={() => setShowEmoji(s => !s)}
                aria-label="Open emoji picker"
              >
                <i className="bi bi-emoji-smile"></i>
              </button>

              <input
                type="text"
                className="form-control border-0 bg-transparent"
                placeholder="Type your message..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                aria-label="Message input"
              />

              <button
                className="btn btn-outline-secondary input-actions"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Upload file"
              >
                <i className="bi bi-paperclip"></i>
              </button>

              <input ref={fileInputRef} type="file" className="d-none" multiple onChange={handleFilePick} />

              <button
                className="btn btn-outline-secondary input-actions"
                type="button"
                onClick={toggleListening}
                disabled={!canUseVoice}
                aria-label="Voice input"
              >
                <i className={`bi ${isListening ? 'bi-mic-mute-fill text-danger' : 'bi-mic-fill'}`}></i>
              </button>

              <button className="btn btn-primary input-actions" type="button" onClick={() => handleSend()} aria-label="Send message">
                <i className="bi bi-send-fill"></i>
              </button>
            </div>

            {/* Emoji Picker popover */}
            {showEmoji && (
              <div ref={emojiContainerRef} className="emoji-popover">
                <EmojiPicker
                  onEmojiClick={onEmojiClick}
                  theme={isDark ? ('dark' as EmojiTheme) : ('light' as EmojiTheme)}
                  searchDisabled
                  previewConfig={{ showPreview: false }}
                  skinTonesDisabled
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
