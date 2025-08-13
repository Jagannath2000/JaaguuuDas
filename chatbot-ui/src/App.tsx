import { useEffect, useRef, useState } from 'react'
import './App.css'
import { Chart, registerables } from 'chart.js'
import { Bar, Pie, Line } from 'react-chartjs-2'
import EmojiPicker, { EmojiStyle, Theme } from 'emoji-picker-react'
import type { EmojiClickData } from 'emoji-picker-react'

Chart.register(...registerables)

type Sender = 'user' | 'bot'

type MessageType = 'text' | 'chart' | 'file'

type ChartPayload = {
  chartType: 'bar' | 'pie' | 'line'
  data: any
  options?: any
}

type Message = {
  id: string
  sender: Sender
  type: MessageType
  content: string | ChartPayload
  timestamp: number
  fileName?: string
  fileUrl?: string
}

const BOT_NAME = 'Nova AI'

const BotAvatar = () => (
  <img src="https://avatars.githubusercontent.com/u/131713724?s=200&v=4" className="rounded-circle" alt="bot" width={36} height={36} />
)

const UserAvatar = () => (
  <i className="bi bi-person-circle fs-3 text-secondary" aria-label="User" />
)

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const [darkMode, setDarkMode] = useState(true)

  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Speech recognition setup
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const speechBufferRef = useRef<string>('')
  type WindowWithSR = Window & {
    webkitSpeechRecognition?: any
    SpeechRecognition?: any
  }

  useEffect(() => {
    const w = window as unknown as WindowWithSR
    const SpeechRecognitionCtor = w.SpeechRecognition || w.webkitSpeechRecognition
    if (SpeechRecognitionCtor) {
      const recognition: SpeechRecognition = new SpeechRecognitionCtor()
      recognition.lang = 'en-US'
      recognition.interimResults = false
      recognition.maxAlternatives = 1

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        const transcript = event.results[0][0].transcript
        speechBufferRef.current = transcript
        setInputValue(transcript)
      }

      recognition.onend = () => {
        setIsListening(false)
        const text = speechBufferRef.current.trim()
        if (text.length > 0) {
          // Send immediately after speech ends
          addMessage({ sender: 'user', type: 'text', content: text })
          setInputValue('')
          speechBufferRef.current = ''
          simulateBotResponse(text)
        }
      }

      recognition.onerror = () => {
        setIsListening(false)
      }

      recognitionRef.current = recognition
    }
  }, [])

  // Scroll to bottom when messages change
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isTyping])

  // Toggle dark mode class on body
  useEffect(() => {
    const body = document.body
    if (darkMode) body.classList.add('bg-dark', 'text-light')
    else body.classList.remove('bg-dark', 'text-light')
  }, [darkMode])

  const handleEmojiClick = (emojiData: EmojiClickData) => {
    setInputValue((prev) => prev + emojiData.emoji)
    setShowEmoji(false)
  }

  const addMessage = (msg: Omit<Message, 'id' | 'timestamp'>) => {
    const newMsg: Message = {
      id: Math.random().toString(36).slice(2),
      timestamp: Date.now(),
      ...msg,
    }
    setMessages((prev) => [...prev, newMsg])
  }

  const simulateBotResponse = (userText: string) => {
    setIsTyping(true)

    // Simple rule-based bot responder for demo
    const lower = userText.toLowerCase()

    setTimeout(() => {
      let response: Omit<Message, 'id' | 'timestamp'>

      if (lower.includes('json')) {
        const payload: ChartPayload = {
          chartType: 'bar',
          data: {
            labels: ['Q1', 'Q2', 'Q3', 'Q4'],
            datasets: [{ label: 'Revenue', data: [120, 90, 150, 110], backgroundColor: 'rgba(13,110,253,0.6)' }]
          },
          options: { responsive: true }
        }
        response = { sender: 'bot', type: 'text', content: JSON.stringify(payload) }
      } else if (lower.includes('chart') || lower.includes('sales') || lower.includes('data')) {
        // Return a chart payload randomly among bar, pie, line
        const types: ChartPayload['chartType'][] = ['bar', 'pie', 'line']
        const chartType = types[Math.floor(Math.random() * types.length)]
        const chartPayload: ChartPayload = {
          chartType,
          data: {
            labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
            datasets: [
              {
                label: 'Sales',
                data: Array.from({ length: 6 }, () => Math.floor(Math.random() * 100) + 10),
                backgroundColor: [
                  'rgba(13,110,253,0.6)',
                  'rgba(25,135,84,0.6)',
                  'rgba(220,53,69,0.6)',
                  'rgba(255,193,7,0.6)',
                  'rgba(13,202,240,0.6)',
                  'rgba(111,66,193,0.6)'
                ],
                borderColor: 'rgba(255,255,255,0.9)',
              }
            ]
          },
          options: {
            responsive: true,
            plugins: {
              legend: { labels: { color: darkMode ? '#e9ecef' : '#212529' } },
              title: { display: true, text: 'Monthly Sales', color: darkMode ? '#e9ecef' : '#212529' }
            },
            scales: chartType !== 'pie' ? {
              x: { ticks: { color: darkMode ? '#ced4da' : '#495057' } },
              y: { ticks: { color: darkMode ? '#ced4da' : '#495057' } }
            } : undefined
          }
        }

        response = {
          sender: 'bot',
          type: 'chart',
          content: chartPayload,
        }
      } else if (lower.includes('hello') || lower.includes('hi')) {
        response = { sender: 'bot', type: 'text', content: 'Hello! Ask me for a chart or say something interesting 😄' }
      } else if (lower.includes('help')) {
        response = { sender: 'bot', type: 'text', content: 'Try: "Show sales chart", "Upload a file", or use the mic to speak your query.' }
      } else {
        response = { sender: 'bot', type: 'text', content: `You said: "${userText}"` }
      }

      addMessage(response)
      setIsTyping(false)
    }, 900 + Math.random() * 1000)
  }

  const handleSend = () => {
    const text = inputValue.trim()
    if (!text) return
    addMessage({ sender: 'user', type: 'text', content: text })
    setInputValue('')
    simulateBotResponse(text)
  }

  const handleKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const toggleListening = () => {
    const recognition = recognitionRef.current
    if (!recognition) return

    if (!isListening) {
      setIsListening(true)
      setShowEmoji(false)
      try {
        recognition.start()
      } catch (e) {
        // ignore start errors if already started
      }
    } else {
      recognition.stop()
      setIsListening(false)
    }
  }

  const handleFileSelect: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)

    addMessage({
      sender: 'user',
      type: 'file',
      content: `Uploaded ${file.name}`,
      fileName: file.name,
      fileUrl: url,
    })

    // Bot acknowledges
    setIsTyping(true)
    setTimeout(() => {
      addMessage({ sender: 'bot', type: 'text', content: `Received your file: ${file.name}` })
      setIsTyping(false)
    }, 800)

    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const themeClasses = darkMode
    ? 'bg-dark text-light'
    : 'bg-light text-dark'

  const bubbleClasses = (sender: Sender) =>
    sender === 'user'
      ? 'bg-primary text-white'
      : darkMode ? 'bg-secondary text-light' : 'bg-white text-dark border'

  const glassCardClass = 'bg-opacity-25 shadow-lg rounded-4'

  const emojiTheme: Theme = darkMode ? Theme.DARK : Theme.LIGHT

  const renderChart = (payload: ChartPayload) => {
    const commonProps = { data: payload.data, options: payload.options }
    if (payload.chartType === 'bar') return <Bar {...commonProps} />
    if (payload.chartType === 'pie') return <Pie {...commonProps} />
    return <Line {...commonProps} />
  }

  const tryParseChartJSON = (text: string): ChartPayload | null => {
    try {
      const obj = JSON.parse(text)
      if (obj && (obj.chartType === 'bar' || obj.chartType === 'pie' || obj.chartType === 'line') && obj.data) {
        return obj as ChartPayload
      }
    } catch {}
    return null
  }

  return (
    <div className={`min-vh-100 d-flex flex-column ${themeClasses}`} style={{ background: darkMode ? 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' : 'linear-gradient(135deg, #eef2f3 0%, #8e9eab 100%)' }}>
      {/* Navbar */}
      <nav className={`navbar navbar-expand-lg sticky-top ${darkMode ? 'navbar-dark bg-dark bg-opacity-75' : 'navbar-light bg-light bg-opacity-75'} backdrop-blur`} style={{ backdropFilter: 'saturate(180%) blur(12px)' }}>
        <div className="container-fluid">
          <a className="navbar-brand d-flex align-items-center gap-2" href="#">
            <BotAvatar />
            <span className="fw-semibold">{BOT_NAME}</span>
            <span className="badge bg-success ms-1">Online</span>
          </a>

          <div className="d-flex align-items-center gap-2 ms-auto">
            <button
              className={`btn btn-sm ${darkMode ? 'btn-outline-light' : 'btn-outline-dark'} d-flex align-items-center gap-2`}
              onClick={() => setDarkMode((v) => !v)}
            >
              <i className={`bi ${darkMode ? 'bi-moon-stars' : 'bi-sun'} me-1`}></i>
              {darkMode ? 'Dark' : 'Light'}
            </button>
            <a className="btn btn-sm btn-outline-secondary" href="https://react.dev" target="_blank" rel="noreferrer">
              <i className="bi bi-info-circle" />
            </a>
          </div>
        </div>
      </nav>

      {/* Main chat area */}
      <div className="container-fluid flex-grow-1 d-flex" style={{ overflow: 'hidden' }}>
        <div className="row flex-grow-1 w-100">
          <div className="col-12 col-md-10 col-lg-8 mx-auto d-flex flex-column py-3">
            <div
              className={`flex-grow-1 overflow-auto p-3 rounded-4 ${glassCardClass}`}
              style={{
                background: darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.5)',
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                border: darkMode ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(0,0,0,0.08)'
              }}
            >
              {messages.map((msg) => {
                const chartFromText = msg.type === 'text' && typeof msg.content === 'string' ? tryParseChartJSON(msg.content) : null
                return (
                  <div key={msg.id} className={`d-flex mb-3 ${msg.sender === 'user' ? 'justify-content-end' : 'justify-content-start'}`}>
                    {msg.sender === 'bot' && (
                      <div className="me-2 d-flex align-items-end" style={{ width: 40 }}>
                        <BotAvatar />
                      </div>
                    )}
                    <div className={`p-3 rounded-4 ${bubbleClasses(msg.sender)} fade-in`} style={{ maxWidth: '80%' }}>
                      {chartFromText ? (
                        <div className="bg-body rounded-3 p-2" style={{ minWidth: 240 }}>
                          {renderChart(chartFromText)}
                        </div>
                      ) : msg.type === 'text' ? (
                        <div className="small">
                          {String(msg.content)}
                        </div>
                      ) : null}
                      {msg.type === 'chart' && !chartFromText && (
                        <div className="bg-body rounded-3 p-2" style={{ minWidth: 240 }}>
                          {renderChart(msg.content as ChartPayload)}
                        </div>
                      )}
                      {msg.type === 'file' && (
                        <div className="d-flex align-items-center gap-2 small">
                          <i className="bi bi-paperclip" />
                          <a href={msg.fileUrl} target="_blank" rel="noreferrer" className="link-light text-decoration-underline">
                            {msg.fileName}
                          </a>
                        </div>
                      )}
                      <div className="text-end opacity-75 mt-1" style={{ fontSize: '0.7rem' }}>
                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    {msg.sender === 'user' && (
                      <div className="ms-2 d-flex align-items-end" style={{ width: 40 }}>
                        <UserAvatar />
                      </div>
                    )}
                  </div>
                )
              })}

              {isTyping && (
                <div className="d-flex mb-3 justify-content-start">
                  <div className={`p-3 rounded-4 ${bubbleClasses('bot')} fade-in d-inline-flex align-items-center gap-2`}>
                    <div className="typing">
                      <span></span><span></span><span></span>
                    </div>
                    <span className="small opacity-75">Bot is typing…</span>
                  </div>
                </div>
              )}

              <div ref={chatEndRef} />
            </div>

            {/* Input section */}
            <div className="mt-3 position-relative">
              <div className="input-group shadow-sm">
                <button
                  className={`btn ${darkMode ? 'btn-outline-light' : 'btn-outline-secondary'}`}
                  type="button"
                  onClick={() => setShowEmoji((v) => !v)}
                  title="Emoji"
                >
                  <i className="bi bi-emoji-smile"></i>
                </button>

                <input
                  type="text"
                  className={`form-control ${darkMode ? 'bg-dark text-light' : ''}`}
                  placeholder="Type your message..."
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                />

                <button
                  className={`btn ${isListening ? 'btn-danger' : (darkMode ? 'btn-outline-light' : 'btn-outline-secondary')}`}
                  type="button"
                  onClick={toggleListening}
                  title={isListening ? 'Stop' : 'Voice input'}
                >
                  <i className={`bi ${isListening ? 'bi-mic-mute-fill' : 'bi-mic-fill'}`}></i>
                </button>

                <label className={`btn ${darkMode ? 'btn-outline-light' : 'btn-outline-secondary'} mb-0`} title="Attach file">
                  <i className="bi bi-paperclip"></i>
                  <input ref={fileInputRef} type="file" className="d-none" onChange={handleFileSelect} />
                </label>

                <button className="btn btn-primary" type="button" onClick={handleSend}>
                  <i className="bi bi-send-fill me-1"></i> Send
                </button>
              </div>

              {showEmoji && (
                <div className="position-absolute" style={{ bottom: '60px', left: 0, zIndex: 1000 }}>
                  <div className={`p-1 rounded-3 ${darkMode ? 'bg-dark border border-secondary' : 'bg-white border'}`}>
                    <EmojiPicker
                      onEmojiClick={handleEmojiClick}
                      emojiStyle={EmojiStyle.NATIVE}
                      theme={emojiTheme}
                      searchDisabled
                      skinTonesDisabled
                      lazyLoadEmojis
                      width={320}
                    />
                  </div>
                </div>
              )}
            </div>

          </div>
        </div>
      </div>

    </div>
  )
}

export default App
