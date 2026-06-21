import { useState, useRef, useCallback, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import Landing, { PROFILES } from './Landing.jsx'
import { symbolFor } from './symbols.js'
import VoiceRecorder from './VoiceRecorder.jsx'
import Demo from './Demo.jsx'

const WS_URL = 'ws://localhost:8000/ws/listen'
const API = 'http://localhost:8000'

const SIMULATE_PRESETS = [
  'Are you hungry?',
  'Did you like the food?',
  'How are you feeling today?',
  'What do you want to do later?',
]

// Sensible defaults shown before the AI has any context to read from
const STARTER_TILES = [
  'yes', 'no', 'maybe', 'thank you',
  'please', 'help', 'tired', 'happy',
  "I don't know", 'later', 'okay', 'more',
]

const MAX_TAPS = 4

const SESSION_ID = (() => {
  const k = 'cadence_session_id'
  let v = localStorage.getItem(k)
  if (!v) {
    v = 'sess_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now()
    localStorage.setItem(k, v)
  }
  return v
})()

const DEFAULT_SETTINGS = { stability: 0.5, similarity_boost: 0.8, style: 0.3, speed: 0.92 }

const asCandidate = (c) =>
  typeof c === 'string'
    ? { text: c, emotion: 'neutral', settings: { ...DEFAULT_SETTINGS } }
    : { text: c.text || '', emotion: c.emotion || 'neutral', settings: { ...DEFAULT_SETTINGS, ...(c.settings || {}) } }

const ttsUrl = (cand) => {
  const p = new URLSearchParams({
    text: cand.text,
    emotion: cand.emotion || '',
    stability: String(cand.settings.stability),
    similarity_boost: String(cand.settings.similarity_boost),
    style: String(cand.settings.style),
    speed: String(cand.settings.speed ?? 0.92),
    session_id: SESSION_ID,   // backend uses session's cloned voice if set
  })
  return `${API}/tts?${p.toString()}`
}

// Soft, low-saturation emotion accent colors for the pastel palette
const EMOTION_DOT = {
  warm: '#e8b486', excited: '#e89bbd', happy: '#f1cf66', playful: '#c89bdc',
  neutral: '#a8b8c4', thoughtful: '#9bb8dc', tender: '#dca6c0', tired: '#9aabaf',
  sad: '#7fa2c8', anxious: '#dfa884', frustrated: '#c98e8e', firm: '#8a9dbd',
  apologetic: '#b6a3cf',
}

const PROFILE_KEY = 'cadence_profile'
const SETTINGS_KEY = (profKey) => `cadence_settings_${profKey}`

// Tunable keys exposed in the Settings panel. The profile picks reasonable
// starting values; the user (or their caregiver/SLP) can override any of them.
// Range/step/label live here so the panel renders generically.
const SETTING_SPECS = [
  { key: 'tileMinHeight', label: 'Tile size',           min: 60,  max: 160, step: 4,  unit: 'px',
    help: 'Bigger tiles are easier to hit but you see fewer at once.' },
  { key: 'tileFontPx',    label: 'Tile text size',      min: 14,  max: 28,  step: 1,  unit: 'px',
    help: 'Make the words larger if reading is harder.' },
  { key: 'longPressMs',   label: 'Hold time to pin',    min: 250, max: 1500, step: 50, unit: 'ms',
    help: 'How long you hold a tile before it pins. Higher = more forgiving.' },
  { key: 'pulseSpeedSec', label: 'Animation speed',     min: 1.5, max: 4.0, step: 0.1, unit: 's',
    help: 'How slow the gentle pulse animation breathes.' },
  { key: 'speedOffset',   label: 'Speech speed',        min: -0.15, max: 0.15, step: 0.01, unit: '',
    help: 'Make the cloned voice slower (-) or faster (+).' },
  { key: 'dwellMs',       label: 'Hover-to-tap delay',  min: 600,  max: 2500, step: 100, unit: 'ms',
    help: 'Only used when hover-to-tap is on. How long you must hover before it activates.',
    showWhen: (eff) => !!eff.dwellEnabled },
]

const TOGGLE_SPECS = [
  { key: 'symbolMode',    label: 'Show pictures on tiles',
    help: 'Pictures + words make tiles easier to recognize quickly.' },
  { key: 'dwellEnabled',  label: 'Hover-to-tap (no click)',
    help: 'Hold the pointer over a tile to activate it. Good if tapping is hard.' },
  { key: 'showVoiceBanking', label: 'Show voice-banking card',
    help: 'Display the reminder to record your voice while you still can.' },
]

const DEFAULT_OVERRIDES = { speedOffset: 0 } // applied on top of every profile

export default function App() {
  // --- Profile (chosen on the landing page) ---
  const [profile, setProfile] = useState(() => {
    try {
      const stored = localStorage.getItem(PROFILE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        // Re-look-up so feature defaults always reflect latest code, not stale localStorage
        return PROFILES[parsed.key] || parsed
      }
    } catch {}
    return null
  })

  const pickProfile = (p) => {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ key: p.key }))
    setProfile(p)
  }

  const resetProfile = () => {
    localStorage.removeItem(PROFILE_KEY)
    setProfile(null)
  }

  // --- Per-profile setting overrides ---
  const [overrides, setOverrides] = useState({})
  useEffect(() => {
    if (!profile) return
    try {
      const stored = localStorage.getItem(SETTINGS_KEY(profile.key))
      setOverrides(stored ? JSON.parse(stored) : {})
    } catch { setOverrides({}) }
  }, [profile])

  const updateOverride = (key, value) => {
    setOverrides(prev => {
      const next = { ...prev, [key]: value }
      if (profile) localStorage.setItem(SETTINGS_KEY(profile.key), JSON.stringify(next))
      return next
    })
  }

  const resetOverrides = () => {
    setOverrides({})
    if (profile) localStorage.removeItem(SETTINGS_KEY(profile.key))
  }

  const [showSettings, setShowSettings] = useState(false)
  const [showRecorder, setShowRecorder] = useState(false)
  const [view, setView] = useState('app') // 'app' | 'demo'
  const [hasCustomVoice, setHasCustomVoice] = useState(false)

  // Check on mount whether this session already has a cloned voice
  useEffect(() => {
    fetch(`${API}/voice/${SESSION_ID}`)
      .then(r => r.json())
      .then(d => setHasCustomVoice(!!d.has_custom))
      .catch(() => {})
  }, [])

  // --- Connection / mic ---
  const [status, setStatus] = useState('idle')
  const [micAvailable, setMicAvailable] = useState(null)
  const [errorMsg, setErrorMsg] = useState('')

  // --- Turn state machine ---
  const [turnMode, setTurnMode] = useState('their_turn')
  const listeningRef = useRef(true)
  const turnModeRef = useRef('their_turn')
  const autoFlipTimerRef = useRef(null)

  // --- Conversation ---
  const [interim, setInterim] = useState('')
  const [lastHeard, setLastHeard] = useState('')
  const [chatLog, setChatLog] = useState([])
  const [suggestions, setSuggestions] = useState([])

  // --- Tiles + vocab ---
  const [tiles, setTiles] = useState(STARTER_TILES)
  const [pinned, setPinned] = useState([])
  const [recents, setRecents] = useState([])
  const [selectedTaps, setSelectedTaps] = useState([])
  const [showAdd, setShowAdd] = useState(false)
  const [customWord, setCustomWord] = useState('')

  // --- Candidates / TTS ---
  const [candidates, setCandidates] = useState([])
  const [generating, setGenerating] = useState(false)
  const [moreLoading, setMoreLoading] = useState(false)
  const [speakingIdx, setSpeakingIdx] = useState(-1)

  // --- Simulator panel ---
  const [showSim, setShowSim] = useState(false)
  const [simulateText, setSimulateText] = useState(SIMULATE_PRESETS[0])

  // --- Refs ---
  const wsRef = useRef(null)
  const audioCtxRef = useRef(null)
  const streamRef = useRef(null)
  const workletRef = useRef(null)
  const deepgramReadyRef = useRef(false)
  const audioElRef = useRef(null)
  const audioCacheRef = useRef({})
  const bufferContextRef = useRef('')

  // -------------------------------------------------------------------------
  // Turn-state helpers
  // -------------------------------------------------------------------------
  const cancelAutoFlip = () => {
    if (autoFlipTimerRef.current) {
      clearTimeout(autoFlipTimerRef.current)
      autoFlipTimerRef.current = null
    }
  }

  const setTurn = useCallback((mode) => {
    cancelAutoFlip()
    turnModeRef.current = mode
    listeningRef.current = mode === 'their_turn'
    setTurnMode(mode)
  }, [])

  // -------------------------------------------------------------------------
  // Memory & vocab fetches
  // -------------------------------------------------------------------------
  const fetchHistory = useCallback(async () => {
    try {
      const r = await fetch(`${API}/history/${SESSION_ID}`)
      const d = await r.json()
      setChatLog(d.turns || [])
    } catch {}
  }, [])

  const fetchVocab = useCallback(async () => {
    try {
      const r = await fetch(`${API}/vocab/${SESSION_ID}`)
      const d = await r.json()
      setPinned(d.pinned || [])
      setRecents(d.recents || [])
    } catch {}
  }, [])

  const fetchContextualTiles = useCallback(async (ctx) => {
    if (!ctx) return
    try {
      const r = await fetch(`${API}/tiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: ctx, session_id: SESSION_ID, n: 12 }),
      })
      const d = await r.json()
      if (Array.isArray(d.tiles) && d.tiles.length) setTiles(d.tiles)
    } catch {}
  }, [])

  const fetchSuggestions = useCallback(async (ctx) => {
    if (!ctx) return
    try {
      const r = await fetch(`${API}/suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: ctx, session_id: SESSION_ID }),
      })
      const d = await r.json()
      setSuggestions((d.suggestions || []).map(asCandidate))
    } catch {}
  }, [])

  // -------------------------------------------------------------------------
  // WS message handling
  // -------------------------------------------------------------------------
  const handleMessage = useCallback((event) => {
    let data
    try { data = JSON.parse(event.data) } catch { return }

    if (data.type === 'connected') {
      setStatus('connected')
    } else if (data.type === 'ready') {
      deepgramReadyRef.current = true
      setStatus('listening')
    } else if (data.type === 'transcript') {
      // Drop anything arriving during my_turn (except manual simulate)
      if (turnModeRef.current !== 'their_turn' && !data.simulated) return
      if (data.buffer?.context !== undefined) {
        bufferContextRef.current = data.buffer.context
      }
      if (data.is_final) {
        setLastHeard(data.text)
        setInterim('')
        fetchHistory()
        fetchSuggestions(data.text)
        fetchContextualTiles(data.text)
        // Auto-flip to my_turn after 3.5s of silence — conversations need
        // breathing room; the old 1.2s cut partners off mid-thought.
        // Any new interim audio in this window cancels the flip.
        cancelAutoFlip()
        autoFlipTimerRef.current = setTimeout(() => {
          if (turnModeRef.current === 'their_turn') setTurn('my_turn')
        }, 3500)
      } else {
        setInterim(data.text)
        cancelAutoFlip()
      }
    } else if (data.type === 'candidates') {
      const cands = (data.candidates || []).map(asCandidate)
      setCandidates(cands)
      setGenerating(false)
      prewarmTTS(cands, 0, true)
    } else if (data.type === 'generate_error') {
      setErrorMsg(`Generator: ${data.message}`)
      setGenerating(false)
    } else if (data.type === 'ping') {
      // Backend heartbeat — keeps intermediate proxies from idle-timing out.
      // Reply with pong so the round-trip is verifiable.
      try { wsRef.current?.send(JSON.stringify({ type: 'pong' })) } catch {}
    } else if (data.type === 'error') {
      setErrorMsg(data.message)
    }
  }, [fetchHistory, fetchSuggestions, fetchContextualTiles, setTurn])

  // -------------------------------------------------------------------------
  // Connect / disconnect
  // -------------------------------------------------------------------------
  const connect = useCallback(async () => {
    setStatus('connecting')
    setErrorMsg('')
    deepgramReadyRef.current = false
    setTurn('their_turn')

    const ws = new WebSocket(WS_URL)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    ws.onmessage = handleMessage
    ws.onerror = () => { setErrorMsg('Cannot reach backend on port 8000.'); setStatus('error') }
    ws.onclose = () => {
      deepgramReadyRef.current = false
      setStatus('idle')
      setInterim('')
    }

    try {
      await new Promise((resolve, reject) => {
        ws.onopen = resolve
        setTimeout(() => reject(new Error('Connection timed out')), 5000)
      })
    } catch (e) {
      setErrorMsg(e.message); setStatus('error'); return
    }

    let sampleRate = 16000
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const ctx = new AudioContext()
      audioCtxRef.current = ctx
      sampleRate = ctx.sampleRate
      setMicAvailable(true)
    } catch (e) {
      setMicAvailable(false)
      setErrorMsg(`No mic (${e.message}). Use the practice panel below to simulate.`)
    }

    ws.send(JSON.stringify({ type: 'init', sample_rate: sampleRate, session_id: SESSION_ID }))

    if (micAvailable !== false && streamRef.current && audioCtxRef.current) {
      try {
        const ctx = audioCtxRef.current
        await ctx.audioWorklet.addModule('/audio-processor.js')
        const source = ctx.createMediaStreamSource(streamRef.current)
        const worklet = new AudioWorkletNode(ctx, 'audio-processor')
        workletRef.current = worklet
        worklet.port.onmessage = (e) => {
          if (listeningRef.current && deepgramReadyRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(e.data)
          }
        }
        source.connect(worklet)
        worklet.connect(ctx.destination)
      } catch (e) {
        setErrorMsg(`Audio setup failed: ${e.message}`)
      }
    }
  }, [handleMessage, micAvailable, setTurn])

  const disconnect = useCallback(() => {
    cancelAutoFlip()
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

  // -------------------------------------------------------------------------
  // Tile interaction
  // -------------------------------------------------------------------------
  const toggleTap = (concept) => {
    setSelectedTaps(prev => {
      if (prev.includes(concept)) return prev.filter(c => c !== concept)
      if (prev.length >= MAX_TAPS) return prev
      return [...prev, concept]
    })
    setCandidates([])
  }

  const togglePin = async (word) => {
    try {
      const r = await fetch(`${API}/vocab/${SESSION_ID}/pin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word }),
      })
      const d = await r.json()
      setPinned(d.pinned || [])
    } catch {}
  }

  const addCustom = async () => {
    const w = customWord.trim().toLowerCase()
    if (!w) return
    setCustomWord('')
    setShowAdd(false)
    setSelectedTaps(prev => prev.includes(w) || prev.length >= MAX_TAPS ? prev : [...prev, w])
    try {
      const r = await fetch(`${API}/vocab/${SESSION_ID}/recent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: w }),
      })
      const d = await r.json()
      setRecents(d.recents || [])
    } catch {}
  }

  const useRecent = (word) => {
    setSelectedTaps(prev => prev.includes(word) || prev.length >= MAX_TAPS ? prev : [...prev, word])
    setShowAdd(false)
  }

  // -------------------------------------------------------------------------
  // TTS
  // -------------------------------------------------------------------------
  // Apply the user's speech-speed override on top of the candidate's per-emotion speed
  const adjustForSpeed = useCallback((cand) => {
    const off = overrides.speedOffset ?? 0
    if (!off) return cand
    const base = cand.settings?.speed ?? 0.92
    const adj = Math.min(1.2, Math.max(0.7, base + off))
    return { ...cand, settings: { ...cand.settings, speed: adj } }
  }, [overrides.speedOffset])

  const prewarmTTS = useCallback((cands, baseIdx = 0, freeOld = false) => {
    if (freeOld) {
      Object.values(audioCacheRef.current).forEach(u => URL.revokeObjectURL(u))
      audioCacheRef.current = {}
    }
    cands.forEach((cand, i) => {
      fetch(ttsUrl(adjustForSpeed(cand)))
        .then(r => r.ok ? r.blob() : null)
        .then(blob => { if (blob) audioCacheRef.current[baseIdx + i] = URL.createObjectURL(blob) })
        .catch(() => {})
    })
  }, [adjustForSpeed])

  const speak = useCallback((cand, idx) => {
    if (!cand?.text) return
    if (audioElRef.current) {
      audioElRef.current.pause()
      audioElRef.current.src = ''
      audioElRef.current = null
    }
    setSpeakingIdx(idx)
    fetch(`${API}/pick`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: SESSION_ID, text: cand.text }),
    }).then(() => fetchHistory()).catch(() => {})

    const src = audioCacheRef.current[idx] || ttsUrl(adjustForSpeed(cand))
    const audio = new Audio(src)
    audioElRef.current = audio
    audio.onended = () => {
      if (audioElRef.current !== audio) return
      setSpeakingIdx(-1)
      // 500ms buffer, then auto-flip back to listening
      setTimeout(() => {
        if (turnModeRef.current === 'my_turn') setTurn('their_turn')
      }, 500)
    }
    audio.onerror = () => { if (audioElRef.current === audio) { setSpeakingIdx(-1); setErrorMsg('Playback failed') } }
    audio.play().catch(() => setSpeakingIdx(-1))
  }, [fetchHistory, setTurn, adjustForSpeed])

  // -------------------------------------------------------------------------
  // Generate
  // -------------------------------------------------------------------------
  const generate = useCallback(async () => {
    if (!selectedTaps.length) return
    setGenerating(true)
    setCandidates([])
    setErrorMsg('')
    try {
      const r = await fetch(`${API}/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taps: selectedTaps, context: bufferContextRef.current, session_id: SESSION_ID }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        setErrorMsg(`Generator: ${err.detail || r.statusText}`)
        setGenerating(false); return
      }
      const d = await r.json()
      const cands = (d.candidates || []).map(asCandidate)
      setCandidates(cands)
      setGenerating(false)
      prewarmTTS(cands, 0, true)
    } catch (e) {
      setErrorMsg(`Generate failed: ${e.message}`); setGenerating(false)
    }
  }, [selectedTaps, prewarmTTS])

  const generateMore = useCallback(async () => {
    if (!selectedTaps.length) return
    setMoreLoading(true)
    try {
      const r = await fetch(`${API}/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taps: selectedTaps, context: bufferContextRef.current, session_id: SESSION_ID,
          n: 3, variety: 'Avoid repeating any phrasing already shown. Different word choice and tone.',
        }),
      })
      const d = await r.json()
      const more = (d.candidates || []).map(asCandidate)
      const base = candidates.length
      setCandidates(prev => [...prev, ...more])
      prewarmTTS(more, base, false)
    } catch (e) {
      setErrorMsg(`More failed: ${e.message}`)
    } finally { setMoreLoading(false) }
  }, [selectedTaps, candidates.length, prewarmTTS])

  const clearTaps = () => { setSelectedTaps([]); setCandidates([]) }

  const sendSimulate = useCallback(() => {
    if (!simulateText.trim()) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setErrorMsg('Connect first.'); return
    }
    ws.send(JSON.stringify({ type: 'simulate_input', text: simulateText.trim() }))
  }, [simulateText])

  const clearChat = useCallback(async () => {
    await fetch(`${API}/clear/${SESSION_ID}`, { method: 'POST' }).catch(() => {})
    setChatLog([])
    setSuggestions([])
  }, [])

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------
  useEffect(() => { fetchHistory(); fetchVocab() }, [fetchHistory, fetchVocab])

  // Idle return — if the user enters my_turn but doesn't start composing
  // (no taps, no speaking), open the mic back up after 2 minutes so a long
  // natural pause doesn't end the conversation. Resets whenever taps change.
  useEffect(() => {
    if (turnMode !== 'my_turn') return
    if (selectedTaps.length > 0) return  // actively composing — let them be
    const t = setTimeout(() => {
      if (turnModeRef.current === 'my_turn' && !selectedTaps.length) {
        setTurn('their_turn')
      }
    }, 120_000)
    return () => clearTimeout(t)
  }, [turnMode, selectedTaps.length, setTurn])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const isConnected = ['listening', 'connected', 'connecting'].includes(status)
  const wsOpen = wsRef.current?.readyState === WebSocket.OPEN

  // Build the visible tile grid: pinned (top) → contextual → recents → +Add slot
  const contextual = tiles.filter(t => !pinned.includes(t)).slice(0, Math.max(0, 12 - pinned.length - 3))
  const visibleRecents = recents.filter(r => !pinned.includes(r) && !contextual.includes(r)).slice(0, 2)

  // Top-level pages get framer fades for smooth transitions.
  // The Demo and Landing cases return their own wrapped motion divs so the
  // outer AnimatePresence sequences fade-out → fade-in cleanly between views.
  const pageTransition = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit:    { opacity: 0 },
    transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] },
  }

  if (view === 'demo') {
    return (
      <AnimatePresence mode="wait">
        <motion.div key="demo" {...pageTransition}>
          <Demo onTryIt={() => setView('app')} onBack={() => setView('app')} />
        </motion.div>
      </AnimatePresence>
    )
  }

  if (!profile) {
    return (
      <AnimatePresence mode="wait">
        <motion.div key="landing" {...pageTransition}>
          <Landing onPick={pickProfile} onSeeDemo={() => setView('demo')} />
        </motion.div>
      </AnimatePresence>
    )
  }

  // Effective settings = profile defaults overlaid with the user's overrides
  const profDef = profile.defaults || {}
  const eff = { ...DEFAULT_OVERRIDES, ...profDef, ...overrides }
  const longPressMs = eff.longPressMs ?? 550
  const tileStyle = {
    fontSize: `${eff.tileFontPx ?? 18}px`,
    minHeight: eff.tileMinHeight ?? 84,
  }
  const pulseStyle = { animationDuration: `${eff.pulseSpeedSec ?? 2.4}s` }

  return (
    <AnimatePresence mode="wait">
    <motion.div key="main-app"
      className="min-h-screen px-5 py-8 max-w-6xl mx-auto"
      style={{ color: 'var(--text)' }}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}>

      {/* Header */}
      <header className="mb-5">
        <div className="flex items-end justify-between mb-3">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight">Cadence</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--text-faint)' }}>
              {profDef.welcomeLine || 'Speak naturally, in your own voice.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setView('demo')}
              className="hidden sm:inline-flex px-4 py-2.5 rounded-full text-sm font-medium"
              style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', color: 'var(--text-soft)' }}>
              How it works
            </button>
            <button
              onClick={() => setShowSettings(true)}
              aria-label="Settings"
              className="w-11 h-11 rounded-full flex items-center justify-center text-xl"
              style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', color: 'var(--text-soft)' }}>
              ⚙
            </button>
          <button
            onClick={isConnected ? disconnect : connect}
            className="px-5 py-2.5 rounded-full text-sm font-semibold transition-colors"
            style={{
              background: isConnected ? 'var(--bg-elev)' : 'var(--tile-selected)',
              color: isConnected ? 'var(--text-soft)' : 'white',
              border: `1px solid ${isConnected ? 'var(--border)' : 'var(--tile-selected)'}`,
            }}
          >
            {status === 'connecting' ? 'Connecting…' : isConnected ? 'Disconnect' : 'Connect'}
          </button>
          </div>
        </div>

        {/* Profile row — visible, tappable; goes back to landing */}
        <button
          onClick={resetProfile}
          className="w-full flex items-center justify-between rounded-2xl px-4 py-2.5 text-sm transition-colors"
          style={{ background: 'var(--bg-soft)', border: '1px solid var(--border)', color: 'var(--text-soft)' }}>
          <span className="flex items-center gap-2">
            <span aria-hidden>←</span>
            <span style={{ color: 'var(--text)' }}>{profile.title}</span>
            <span style={{ color: 'var(--text-faint)' }}>profile</span>
          </span>
          <span style={{ color: 'var(--text-soft)' }}>Change</span>
        </button>
      </header>

      {errorMsg && (
        <div className="mb-5 px-4 py-3 rounded-2xl text-sm"
             style={{ background: '#fce8e8', color: '#7d3838', border: '1px solid #f0c8c8' }}>
          {errorMsg}
        </div>
      )}

      {/* Two-column cockpit layout on wide screens; stacks vertically on small screens */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* LEFT COLUMN — conversation status + memory */}
        <div className="lg:col-span-5">

      {/* Big turn toggle — primary control */}
      {isConnected && (
        <button
          onClick={() => setTurn(turnMode === 'their_turn' ? 'my_turn' : 'their_turn')}
          className="w-full py-5 mb-6 rounded-3xl text-lg font-semibold transition-colors flex items-center justify-center gap-3"
          style={{
            background: turnMode === 'their_turn' ? 'var(--partner)' : 'var(--accent-soft)',
            color: 'var(--text)',
            border: `1px solid ${turnMode === 'their_turn' ? '#b6cfde' : '#e6cf8c'}`,
          }}
        >
          <span className="w-3 h-3 rounded-full calm-pulse"
                style={{ background: turnMode === 'their_turn' ? '#6f9cbf' : '#c9a847', ...pulseStyle }} />
          {turnMode === 'their_turn' ? 'Their turn — listening' : 'My turn — composing'}
        </button>
      )}

      {/* ALS voice-banking nudge — only shown when profile says so */}
      {eff.showVoiceBanking && !hasCustomVoice && (
        <section className="mb-5 rounded-3xl p-5"
                 style={{ background: 'var(--accent-soft)', border: '1px solid #e6cf8c' }}>
          <div className="flex items-start gap-4">
            <div className="text-3xl shrink-0">🎙️</div>
            <div className="flex-1">
              <div className="text-base font-semibold mb-1" style={{ color: 'var(--text)' }}>
                Record your voice while you can
              </div>
              <p className="text-sm mb-3" style={{ color: 'var(--text-soft)' }}>
                Cadence can speak in <em>your</em> voice — but only if we record it now,
                while speaking is still possible. About 60 seconds of clear audio is enough.
              </p>
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => setShowRecorder(true)}
                  className="px-4 py-2.5 rounded-full text-sm font-semibold"
                  style={{ background: 'var(--tile-selected)', color: 'white' }}>
                  Start recording
                </button>
                <button
                  onClick={() => updateOverride('showVoiceBanking', false)}
                  className="px-4 py-2.5 rounded-full text-sm"
                  style={{ background: 'var(--bg-elev)', color: 'var(--text-soft)', border: '1px solid var(--border)' }}>
                  Maybe later
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Confirmation when user already has a cloned voice */}
      {eff.showVoiceBanking && hasCustomVoice && (
        <section className="mb-5 rounded-2xl px-4 py-3 flex items-center justify-between"
                 style={{ background: 'var(--user)', border: '1px solid #a8c5b0' }}>
          <span className="text-sm" style={{ color: 'var(--text)' }}>
            ✓ Speaking in your cloned voice
          </span>
          <button
            onClick={() => setShowRecorder(true)}
            className="text-xs underline-offset-2 hover:underline"
            style={{ color: 'var(--text-soft)' }}>
            Re-record
          </button>
        </section>
      )}

      {/* Heard box */}
      <section className="mb-5">
        <div className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--text-faint)' }}>
          Heard
        </div>
        <div className="rounded-2xl px-5 py-4 min-h-[3.5rem] flex items-center"
             style={{ background: 'var(--bg-soft)', border: '1px solid var(--border)' }}>
          {interim ? (
            <span className="text-lg italic" style={{ color: 'var(--text-soft)' }}>{interim}</span>
          ) : lastHeard ? (
            <span className="text-lg" style={{ color: 'var(--text)' }}>{lastHeard}</span>
          ) : (
            <span className="text-sm" style={{ color: 'var(--text-faint)' }}>
              {status === 'listening' ? 'Listening…' : 'Connect to begin.'}
            </span>
          )}
        </div>
      </section>

      {/* Quick suggestions (proactive replies, no taps needed) */}
      {suggestions.length > 0 && (
        <section className="mb-6">
          <div className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--text-faint)' }}>
            Quick reply
          </div>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => speak(s, 100 + i)}
                className="px-5 py-3 rounded-full text-base font-medium transition-colors flex items-center gap-2"
                style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', color: 'var(--text)' }}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: EMOTION_DOT[s.emotion] || '#a8b8c4' }} />
                {s.text}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Memory / chat log moved into left column on wide screens */}
      {chatLog.length > 0 && (
        <details className="mb-6 rounded-2xl overflow-hidden"
                 style={{ background: 'var(--bg-soft)', border: '1px solid var(--border)' }}>
          <summary className="px-4 py-3 cursor-pointer text-xs uppercase tracking-widest flex items-center justify-between"
                   style={{ color: 'var(--text-faint)' }}>
            Conversation memory ({chatLog.length})
            <span onClick={(e) => { e.preventDefault(); clearChat() }}
                  className="text-xs lowercase tracking-normal"
                  style={{ color: 'var(--text-soft)' }}>
              clear
            </span>
          </summary>
          <div className="px-3 pb-3 space-y-1.5 max-h-72 overflow-y-auto">
            {chatLog.map((t, i) => (
              <div key={i} className={`rounded-xl px-3 py-2 text-sm ${t.role === 'user' ? 'ml-10' : 'mr-10'}`}
                   style={{ background: t.role === 'user' ? 'var(--user)' : 'var(--partner)', color: 'var(--text)' }}>
                {t.text}
              </div>
            ))}
          </div>
        </details>
      )}

        </div>
        {/* END LEFT COLUMN */}

        {/* RIGHT COLUMN — composition workspace (tiles + candidates) */}
        <div className="lg:col-span-7">

      {/* Tiles */}
      <section className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase tracking-widest" style={{ color: 'var(--text-faint)' }}>
            Tap words ({selectedTaps.length} of {MAX_TAPS})
          </div>
          {selectedTaps.length > 0 && (
            <button onClick={clearTaps} className="text-xs" style={{ color: 'var(--text-soft)' }}>
              Clear
            </button>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2.5">
          {/* Pinned first (always visible) */}
          {pinned.map(t => (
            <Tile key={`p-${t}`} text={t} pinned selected={selectedTaps.includes(t)}
                  onTap={() => toggleTap(t)} onLongPress={() => togglePin(t)}
                  style={tileStyle} longPressMs={longPressMs}
                  symbolMode={eff.symbolMode} dwellEnabled={eff.dwellEnabled} dwellMs={eff.dwellMs ?? 1100} />
          ))}
          {contextual.map(t => (
            <Tile key={`c-${t}`} text={t} selected={selectedTaps.includes(t)}
                  onTap={() => toggleTap(t)} onLongPress={() => togglePin(t)}
                  style={tileStyle} longPressMs={longPressMs}
                  symbolMode={eff.symbolMode} dwellEnabled={eff.dwellEnabled} dwellMs={eff.dwellMs ?? 1100} />
          ))}
          {visibleRecents.map(t => (
            <Tile key={`r-${t}`} text={t} selected={selectedTaps.includes(t)}
                  onTap={() => toggleTap(t)} onLongPress={() => togglePin(t)}
                  style={tileStyle} longPressMs={longPressMs}
                  symbolMode={eff.symbolMode} dwellEnabled={eff.dwellEnabled} dwellMs={eff.dwellMs ?? 1100} />
          ))}
          {/* Add tile */}
          <button className="tile add" style={tileStyle}
                  onClick={() => setShowAdd(true)} aria-label="Add a word">
            <span className="text-3xl leading-none">+</span>
          </button>
        </div>

        <p className="text-xs mt-3" style={{ color: 'var(--text-faint)' }}>
          Tap a word to use it. Hold a word to {pinned.length ? 'unpin' : 'pin it always'}.
        </p>

        {selectedTaps.length > 0 && (
          <div className="mt-3 text-base" style={{ color: 'var(--text-soft)' }}>
            <span style={{ color: 'var(--text-faint)' }}>Using: </span>
            <span className="font-medium">{selectedTaps.join(' · ')}</span>
          </div>
        )}

        <button
          onClick={generate}
          disabled={!selectedTaps.length || generating}
          className="w-full mt-4 py-4 rounded-2xl text-base font-semibold transition-colors disabled:opacity-40"
          style={{ background: 'var(--tile-selected)', color: 'white' }}
        >
          {generating ? 'Thinking…' : 'Make sentences'}
        </button>
      </section>

      {/* Candidates */}
      {(candidates.length > 0 || generating) && (
        <section className="mb-6">
          <div className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--text-faint)' }}>
            Choose one to say
          </div>
          {generating ? (
            <div className="py-8 text-center text-sm calm-pulse" style={{ color: 'var(--text-faint)' }}>
              Thinking of the right words…
            </div>
          ) : (
            <div className="space-y-2.5">
              {candidates.map((c, i) => (
                <button
                  key={i}
                  onClick={() => speak(c, i)}
                  className="w-full text-left px-5 py-4 rounded-2xl text-lg transition-colors flex items-start justify-between gap-3"
                  style={{
                    background: speakingIdx === i ? 'var(--user)' : 'var(--bg-elev)',
                    border: `1px solid ${speakingIdx === i ? 'var(--tile-selected)' : 'var(--border)'}`,
                    color: 'var(--text)',
                  }}
                >
                  <span>{speakingIdx === i ? '🔊 ' : ''}{c.text}</span>
                  <span className="flex items-center gap-1.5 text-xs mt-1.5 shrink-0" style={{ color: 'var(--text-faint)' }}>
                    <span className="w-2 h-2 rounded-full" style={{ background: EMOTION_DOT[c.emotion] || '#a8b8c4' }} />
                    {c.emotion}
                  </span>
                </button>
              ))}
              <button
                onClick={generateMore}
                disabled={moreLoading || !selectedTaps.length}
                className="w-full py-3 rounded-2xl text-sm font-medium transition-colors disabled:opacity-40"
                style={{ background: 'var(--bg-soft)', color: 'var(--text-soft)', border: '1px solid var(--border)' }}
              >
                {moreLoading ? 'More…' : 'Show more options'}
              </button>
            </div>
          )}
        </section>
      )}

        </div>
        {/* END RIGHT COLUMN */}
      </div>
      {/* END GRID */}

      {/* Practice mode — collapsed, full-width below */}
      <details className="mt-8 rounded-2xl overflow-hidden"
               style={{ background: 'var(--bg-soft)', border: '1px solid var(--border)' }}>
        <summary className="px-4 py-3 cursor-pointer text-xs uppercase tracking-widest"
                 style={{ color: 'var(--text-faint)' }}>
          Practice (without a real conversation)
        </summary>
        <div className="px-4 pb-4">
          <div className="flex flex-wrap gap-2 mb-3">
            {SIMULATE_PRESETS.map(p => (
              <button key={p} onClick={() => setSimulateText(p)}
                      className="px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
                      style={{
                        background: simulateText === p ? 'var(--accent)' : 'var(--bg-elev)',
                        color: 'var(--text)',
                        border: '1px solid var(--border)',
                      }}>
                {p}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text" value={simulateText}
              onChange={e => setSimulateText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendSimulate()}
              placeholder="Type what the partner says…"
              className="flex-1 rounded-xl px-4 py-3 text-sm"
              style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', color: 'var(--text)' }}
            />
            <button onClick={sendSimulate} disabled={!wsOpen}
                    className="px-5 py-3 rounded-xl text-sm font-semibold disabled:opacity-40"
                    style={{ background: 'var(--tile-selected)', color: 'white' }}>
              Send
            </button>
          </div>
        </div>
      </details>

      {/* Add-word modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 py-6"
             style={{ background: 'rgba(44, 62, 80, 0.35)' }}
             onClick={() => setShowAdd(false)}>
          <div className="w-full max-w-md rounded-3xl p-6"
               style={{ background: 'var(--bg-elev)' }}
               onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-semibold mb-4">Add a word</h2>
            <input
              autoFocus type="text" value={customWord}
              onChange={e => setCustomWord(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addCustom()}
              placeholder="type here…"
              className="w-full rounded-2xl px-5 py-4 text-lg mb-3"
              style={{ background: 'var(--bg-soft)', border: '1px solid var(--border)', color: 'var(--text)' }}
            />
            <button
              onClick={addCustom}
              disabled={!customWord.trim()}
              className="w-full py-4 rounded-2xl text-base font-semibold mb-5 disabled:opacity-40"
              style={{ background: 'var(--tile-selected)', color: 'white' }}>
              Use this word
            </button>

            {recents.length > 0 && (
              <>
                <div className="text-xs uppercase tracking-widest mb-2" style={{ color: 'var(--text-faint)' }}>
                  Words you've used before
                </div>
                <div className="flex flex-wrap gap-2 mb-4">
                  {recents.map(w => (
                    <button key={w} onClick={() => useRecent(w)}
                            className="px-4 py-2 rounded-full text-sm transition-colors"
                            style={{ background: 'var(--tile)', color: 'var(--tile-text)' }}>
                      {w}
                    </button>
                  ))}
                </div>
              </>
            )}

            <button onClick={() => setShowAdd(false)}
                    className="w-full py-3 rounded-2xl text-sm"
                    style={{ color: 'var(--text-soft)' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Voice recorder */}
      {showRecorder && (
        <VoiceRecorder
          sessionId={SESSION_ID}
          onClose={() => setShowRecorder(false)}
          onCloned={() => {
            setHasCustomVoice(true)
            // Wipe TTS cache so the next playback fetches with the new voice
            Object.values(audioCacheRef.current).forEach(u => URL.revokeObjectURL(u))
            audioCacheRef.current = {}
          }}
        />
      )}

      {/* Settings modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 py-6 overflow-y-auto"
             style={{ background: 'rgba(44, 62, 80, 0.35)' }}
             onClick={() => setShowSettings(false)}>
          <div className="w-full max-w-md rounded-3xl p-6 my-6"
               style={{ background: 'var(--bg-elev)' }}
               onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-semibold mb-1">Settings</h2>
            <p className="text-sm mb-5" style={{ color: 'var(--text-soft)' }}>
              These are tuned for the <span className="font-medium">{profile.title}</span> profile,
              but every person is different — adjust anything that feels off.
            </p>

            <div className="space-y-5">
              {/* Toggles first (binary feature switches) */}
              {TOGGLE_SPECS.map(spec => {
                const on = !!eff[spec.key]
                const isOverridden = overrides[spec.key] !== undefined
                return (
                  <div key={spec.key} className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <label className="text-sm font-medium block" style={{ color: 'var(--text)' }}>
                        {spec.label}
                        {isOverridden && <span className="ml-1.5 text-xs" style={{ color: 'var(--tile-selected)' }}>·</span>}
                      </label>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-faint)' }}>{spec.help}</p>
                    </div>
                    <button
                      role="switch" aria-checked={on}
                      onClick={() => updateOverride(spec.key, !on)}
                      className="relative shrink-0 w-12 h-7 rounded-full transition-colors"
                      style={{ background: on ? 'var(--tile-selected)' : 'var(--border)' }}>
                      <span className="absolute top-0.5 left-0.5 w-6 h-6 rounded-full transition-transform"
                            style={{ background: 'white', transform: on ? 'translateX(20px)' : 'translateX(0)' }} />
                    </button>
                  </div>
                )
              })}

              <div className="border-t pt-4" style={{ borderColor: 'var(--border)' }} />

              {/* Sliders */}
              {SETTING_SPECS.map(spec => {
                if (spec.showWhen && !spec.showWhen(eff)) return null
                const value = eff[spec.key] ?? spec.min
                const isOverridden = overrides[spec.key] !== undefined
                return (
                  <div key={spec.key}>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                        {spec.label}
                      </label>
                      <span className="text-sm tabular-nums"
                            style={{ color: isOverridden ? 'var(--tile-selected)' : 'var(--text-soft)' }}>
                        {typeof value === 'number' ? Number(value).toFixed(spec.step < 1 ? 2 : 0) : value}{spec.unit}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={spec.min} max={spec.max} step={spec.step}
                      value={value}
                      onChange={e => updateOverride(spec.key, Number(e.target.value))}
                      className="w-full"
                    />
                    <p className="text-xs mt-1" style={{ color: 'var(--text-faint)' }}>
                      {spec.help}
                    </p>
                  </div>
                )
              })}
            </div>

            <div className="mt-6 pt-4 border-t flex items-center justify-between"
                 style={{ borderColor: 'var(--border)' }}>
              <button onClick={resetOverrides}
                      className="text-sm"
                      style={{ color: 'var(--text-soft)' }}>
                Reset to profile defaults
              </button>
              <button onClick={() => setShowSettings(false)}
                      className="px-5 py-2.5 rounded-full text-sm font-semibold"
                      style={{ background: 'var(--tile-selected)', color: 'white' }}>
                Done
              </button>
            </div>

            <button onClick={() => { setShowSettings(false); resetProfile() }}
                    className="w-full mt-3 py-3 rounded-2xl text-sm"
                    style={{ background: 'var(--bg-soft)', color: 'var(--text-soft)', border: '1px solid var(--border)' }}>
              ← Change profile (back to start)
            </button>

            <p className="text-xs mt-5 leading-relaxed"
               style={{ color: 'var(--text-faint)' }}>
              Defaults follow general AAC research principles (calm visuals for autism,
              larger targets for CP, recognition-aided vocabulary for aphasia, voice
              banking for ALS) but the exact numbers are starting points — adjust
              freely for what works for you or with your speech therapist.
            </p>
          </div>
        </div>
      )}
    </motion.div>
    </AnimatePresence>
  )
}

// Tile with three behaviors that depend on the profile:
//   1. long-press → pin (always on; duration profile-tuned)
//   2. symbolMode → render emoji above text (autistic + aphasia profiles)
//   3. dwellEnabled → hover-for-N-ms triggers onTap automatically, with a
//      visible progress ring (CP profile + late-stage ALS)
function Tile({
  text, selected, pinned, onTap, onLongPress, style,
  longPressMs = 550, symbolMode = false,
  dwellEnabled = false, dwellMs = 1100,
}) {
  const pressTimerRef = useRef(null)
  const pressFiredRef = useRef(false)
  const dwellTimerRef = useRef(null)
  const dwellStartRef = useRef(0)
  const rafRef = useRef(0)
  const [dwellPct, setDwellPct] = useState(0)

  const startPress = () => {
    pressFiredRef.current = false
    pressTimerRef.current = setTimeout(() => {
      pressFiredRef.current = true
      onLongPress?.()
    }, longPressMs)
  }
  const cancelPress = () => {
    if (pressTimerRef.current) { clearTimeout(pressTimerRef.current); pressTimerRef.current = null }
  }
  const onClickEnd = () => {
    cancelPress()
    if (!pressFiredRef.current) onTap?.()
  }

  const startDwell = () => {
    if (!dwellEnabled) return
    dwellStartRef.current = performance.now()
    const tick = () => {
      const elapsed = performance.now() - dwellStartRef.current
      const pct = Math.min(1, elapsed / dwellMs)
      setDwellPct(pct)
      if (pct < 1) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    dwellTimerRef.current = setTimeout(() => {
      onTap?.()
      stopDwell()
    }, dwellMs)
  }
  const stopDwell = () => {
    if (dwellTimerRef.current) { clearTimeout(dwellTimerRef.current); dwellTimerRef.current = null }
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
    setDwellPct(0)
  }

  const symbol = symbolMode ? symbolFor(text) : null

  return (
    <button
      className={`tile ${selected ? 'selected' : ''} ${pinned ? 'pinned' : ''}`}
      style={{ ...style, position: 'relative', overflow: 'hidden' }}
      onMouseDown={startPress} onMouseUp={onClickEnd}
      onMouseEnter={startDwell} onMouseLeave={() => { cancelPress(); stopDwell() }}
      onTouchStart={startPress} onTouchEnd={onClickEnd} onTouchCancel={cancelPress}
    >
      <span className="flex flex-col items-center justify-center gap-1 leading-tight">
        {symbol && (
          <span aria-hidden style={{ fontSize: '1.6em', lineHeight: 1 }}>{symbol}</span>
        )}
        <span>{text}</span>
      </span>
      {dwellEnabled && dwellPct > 0 && (
        <span aria-hidden
              className="absolute left-0 bottom-0 h-1.5"
              style={{
                width: `${dwellPct * 100}%`,
                background: 'var(--tile-selected)',
                transition: 'width 60ms linear',
              }} />
      )}
    </button>
  )
}
