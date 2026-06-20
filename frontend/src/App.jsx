import { useState, useRef, useCallback } from 'react'

const WS_URL = 'ws://localhost:8000/ws/listen'

const SIMULATE_PRESETS = [
  'Are you hungry?',
  'Did you like the food?',
  'How are you feeling today?',
  'What do you want to do later?',
]

export default function App() {
  const [status, setStatus] = useState('idle') // idle | connecting | ready | error
  const [micAvailable, setMicAvailable] = useState(null) // null | true | false
  const [interim, setInterim] = useState('')
  const [turns, setTurns] = useState([])
  const [errorMsg, setErrorMsg] = useState('')
  const [simulateText, setSimulateText] = useState(SIMULATE_PRESETS[0])

  // Refs so audio callbacks always have current values without re-renders
  const wsRef = useRef(null)
  const audioCtxRef = useRef(null)
  const streamRef = useRef(null)
  const workletRef = useRef(null)
  const deepgramReadyRef = useRef(false) // only stream audio once Deepgram is live

  const pushTurn = (text, simulated = false) => {
    setTurns(prev => [...prev.slice(-9), { text, simulated, id: Date.now() }])
  }

  const handleMessage = useCallback((event) => {
    let data
    try { data = JSON.parse(event.data) } catch { return }

    if (data.type === 'connected') {
      // WS open but Deepgram not yet confirmed — wait for 'ready'
    } else if (data.type === 'ready') {
      deepgramReadyRef.current = true
      setStatus('ready')
    } else if (data.type === 'transcript') {
      if (data.is_final) {
        pushTurn(data.text, data.simulated || false)
        setInterim('')
      } else {
        setInterim(data.text)
      }
    } else if (data.type === 'error') {
      setErrorMsg(data.message)
      // Don't kill the connection — simulate still works
    }
  }, [])

  const connect = useCallback(async () => {
    setStatus('connecting')
    setErrorMsg('')
    deepgramReadyRef.current = false

    // 1. Open WebSocket
    const ws = new WebSocket(WS_URL)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onmessage = handleMessage
    ws.onerror = () => {
      setErrorMsg('WebSocket error — is the backend running on port 8000?')
      setStatus('error')
    }
    ws.onclose = () => {
      deepgramReadyRef.current = false
      setStatus('idle')
      setInterim('')
    }

    try {
      await new Promise((resolve, reject) => {
        ws.onopen = resolve
        setTimeout(() => reject(new Error('WS open timed out after 5s')), 5000)
      })
    } catch (e) {
      setErrorMsg(e.message)
      setStatus('error')
      return
    }

    // 2. Try to get mic (non-fatal if denied)
    let sampleRate = 16000
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      streamRef.current = stream

      const ctx = new AudioContext()
      audioCtxRef.current = ctx
      sampleRate = ctx.sampleRate

      setMicAvailable(true)
    } catch (e) {
      setMicAvailable(false)
      setErrorMsg(`Mic not available (${e.message}). Simulate-input still works.`)
    }

    // 3. Always send init — tells backend the sample rate before Deepgram connects
    ws.send(JSON.stringify({ type: 'init', sample_rate: sampleRate }))

    // 4. Wire up AudioWorklet only if we got mic access
    if (micAvailable !== false && streamRef.current && audioCtxRef.current) {
      try {
        const ctx = audioCtxRef.current
        await ctx.audioWorklet.addModule('/audio-processor.js')
        const source = ctx.createMediaStreamSource(streamRef.current)
        const worklet = new AudioWorkletNode(ctx, 'audio-processor')
        workletRef.current = worklet

        worklet.port.onmessage = (e) => {
          // Only send once Deepgram has confirmed it's ready
          if (deepgramReadyRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(e.data)
          }
        }

        source.connect(worklet)
        // Connect to destination — some browsers require this for the worklet to keep processing
        worklet.connect(ctx.destination)
      } catch (e) {
        setErrorMsg(`AudioWorklet setup failed: ${e.message}`)
      }
    }
  }, [handleMessage, micAvailable])

  const disconnect = useCallback(() => {
    workletRef.current?.disconnect()
    streamRef.current?.getTracks().forEach(t => t.stop())
    audioCtxRef.current?.close()
    wsRef.current?.close()

    workletRef.current = null
    streamRef.current = null
    audioCtxRef.current = null
    wsRef.current = null
    deepgramReadyRef.current = false

    setStatus('idle')
    setInterim('')
    setMicAvailable(null)
  }, [])

  const sendSimulate = useCallback(() => {
    if (!simulateText.trim()) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setErrorMsg('Not connected. Click Connect first.')
      return
    }
    ws.send(JSON.stringify({ type: 'simulate_input', text: simulateText.trim() }))
  }, [simulateText])

  const isConnected = status === 'ready' || status === 'connecting'
  const wsOpen = wsRef.current?.readyState === WebSocket.OPEN

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6 font-sans max-w-2xl mx-auto">

      {/* Header */}
      <header className="mb-8">
        <h1 className="text-4xl font-bold tracking-tight text-white">Cadence</h1>
        <p className="text-gray-500 text-sm mt-1">Step 1 — Live Listening Proof</p>
      </header>

      {/* Connection bar */}
      <div className="flex items-center gap-3 mb-6">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${
          status === 'ready' ? 'bg-green-400 animate-pulse' :
          status === 'connecting' ? 'bg-yellow-400 animate-pulse' :
          status === 'error' ? 'bg-red-500' :
          'bg-gray-600'
        }`} />
        <span className="text-sm text-gray-400">
          {status === 'ready' ? `Listening${micAvailable ? '' : ' (simulate only)'}` :
           status === 'connecting' ? 'Connecting…' :
           status === 'error' ? 'Error' :
           'Disconnected'}
        </span>
        <button
          onClick={isConnected ? disconnect : connect}
          className={`ml-auto px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
            isConnected
              ? 'bg-gray-700 hover:bg-gray-600 text-gray-200'
              : 'bg-indigo-600 hover:bg-indigo-500 text-white'
          }`}
        >
          {isConnected ? 'Disconnect' : 'Connect'}
        </button>
      </div>

      {/* Error banner */}
      {errorMsg && (
        <div className="mb-5 px-4 py-3 rounded-lg bg-red-950 border border-red-800 text-red-300 text-sm">
          {errorMsg}
        </div>
      )}

      {/* HEARD BAR — live rolling transcript */}
      <section className="mb-6">
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-2">
          Heard — live
        </div>
        <div className="min-h-[4rem] bg-gray-900 border border-gray-800 rounded-xl px-5 py-4 flex items-center">
          {interim ? (
            <span className="text-yellow-300 text-xl leading-snug">{interim}</span>
          ) : (
            <span className="text-gray-600 text-sm">
              {status === 'ready' ? 'Listening for speech…' : 'Connect to start listening'}
            </span>
          )}
        </div>
      </section>

      {/* Finalized turns */}
      <section className="mb-8">
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-2">
          Partner said ({turns.length} turn{turns.length !== 1 ? 's' : ''})
        </div>
        <div className="space-y-2">
          {turns.length === 0 ? (
            <p className="text-gray-600 text-sm py-2">No finalized turns yet.</p>
          ) : (
            turns.map(turn => (
              <div
                key={turn.id}
                className={`rounded-lg px-4 py-3 text-sm flex items-start gap-2 ${
                  turn.simulated
                    ? 'bg-blue-950/60 border border-blue-800/50'
                    : 'bg-gray-800/70 border border-gray-700/50'
                }`}
              >
                {turn.simulated && (
                  <span className="text-blue-500 text-xs font-mono shrink-0 pt-0.5">[sim]</span>
                )}
                <span className="text-gray-100">{turn.text}</span>
              </div>
            ))
          )}
        </div>
      </section>

      {/* SIMULATE INPUT — Standing Rule #5 */}
      <section className="border-t border-gray-800 pt-6">
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-3">
          Simulate input (test without mic)
        </div>

        {/* Preset chips */}
        <div className="flex flex-wrap gap-2 mb-3">
          {SIMULATE_PRESETS.map(p => (
            <button
              key={p}
              onClick={() => setSimulateText(p)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                simulateText === p
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        {/* Custom text + send */}
        <div className="flex gap-2">
          <input
            type="text"
            value={simulateText}
            onChange={e => setSimulateText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendSimulate()}
            placeholder="Type a custom phrase to simulate…"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm
              text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
          />
          <button
            onClick={sendSimulate}
            disabled={!wsOpen}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40
              disabled:cursor-not-allowed rounded-lg text-sm font-semibold transition-colors shrink-0"
          >
            Simulate
          </button>
        </div>
        {!wsOpen && (
          <p className="text-gray-600 text-xs mt-2">Connect first to use simulate.</p>
        )}
      </section>

    </div>
  )
}
