import { useState, useRef, useEffect } from 'react'

/*
 * VoiceRecorder — guided flow for the ALS voice-banking step.
 *
 * Records ~60 seconds of clean speech via MediaRecorder (webm/opus default in
 * Chrome; works on Safari too). Shows phonetically-varied prompts the user
 * reads aloud so the clone has good coverage. Uploads to /voice/clone, which
 * stores the resulting voice_id per session.
 *
 * The prompts are taken from the "Harvard Sentences" set — standardized,
 * phoneme-balanced, public-domain speech samples used in speech-tech research.
 */

const PROMPTS = [
  "The birch canoe slid on the smooth planks.",
  "Glue the sheet to the dark blue background.",
  "It's easy to tell the depth of a well.",
  "These days a chicken leg is a rare dish.",
  "Rice is often served in round bowls.",
  "The juice of lemons makes fine punch.",
  "The box was thrown beside the parked truck.",
  "The hogs were fed chopped corn and garbage.",
  "Four hours of steady work faced us.",
  "A large size in stockings is hard to sell.",
  "The boy was there when the sun rose.",
  "A rod is used to catch pink salmon.",
]

const MIN_SECONDS = 30 // ElevenLabs Instant Voice Cloning works from ~30s; we recommend ~60s
const TARGET_SECONDS = 60

const API = 'http://localhost:8000'

export default function VoiceRecorder({ sessionId, onClose, onCloned }) {
  const [stage, setStage] = useState('intro') // intro → recording → review → uploading → done
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)        // 0-1 mic input level for the meter
  const [error, setError] = useState('')
  const [blob, setBlob] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')

  const mediaRecorderRef = useRef(null)
  const streamRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const rafRef = useRef(0)

  // ---- cleanup on close
  useEffect(() => () => stopAll(), [])

  const stopAll = () => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    audioCtxRef.current?.close().catch(() => {})
    streamRef.current = null
    audioCtxRef.current = null
    analyserRef.current = null
  }

  const start = async () => {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream

      // Mic level meter — pure visual feedback so the user knows it's hearing them
      const ctx = new AudioContext()
      audioCtxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      analyserRef.current = analyser
      const buf = new Uint8Array(analyser.fftSize)
      const tick = () => {
        analyser.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128
          sum += v * v
        }
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3))
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)

      // Pick a mimeType the browser supports
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : ''
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      chunksRef.current = []
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data) }
      rec.onstop = () => {
        const b = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        setBlob(b)
        setPreviewUrl(URL.createObjectURL(b))
        stopAll()
        setStage('review')
      }
      mediaRecorderRef.current = rec
      rec.start(1000)
      setSeconds(0)
      setStage('recording')
      timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000)
    } catch (e) {
      setError(`Mic access failed: ${e.message}`)
    }
  }

  const stop = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    mediaRecorderRef.current?.state === 'recording' && mediaRecorderRef.current.stop()
  }

  const retry = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setBlob(null); setPreviewUrl(''); setSeconds(0); setStage('intro')
  }

  const upload = async () => {
    if (!blob) return
    setStage('uploading')
    setError('')
    try {
      const fd = new FormData()
      fd.append('file', blob, 'voice.webm')
      fd.append('name', 'My voice')
      const r = await fetch(`${API}/voice/clone/${sessionId}`, { method: 'POST', body: fd })
      if (!r.ok) {
        const err = await r.json().catch(() => ({}))
        throw new Error(err.detail || `Upload failed (${r.status})`)
      }
      const d = await r.json()
      setStage('done')
      onCloned?.(d.voice_id)
    } catch (e) {
      setError(e.message)
      setStage('review')
    }
  }

  // ---- render helpers
  const pct = Math.min(1, seconds / TARGET_SECONDS)
  const reached = seconds >= MIN_SECONDS

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 py-6 overflow-y-auto"
         style={{ background: 'rgba(44, 62, 80, 0.45)' }}
         onClick={stage !== 'recording' && stage !== 'uploading' ? onClose : undefined}>
      <div className="w-full max-w-xl rounded-3xl p-6 my-6"
           style={{ background: 'var(--bg-elev)' }}
           onClick={(e) => e.stopPropagation()}>

        {stage === 'intro' && (
          <>
            <div className="text-4xl mb-3">🎙️</div>
            <h2 className="text-2xl font-semibold mb-2">Record your voice</h2>
            <p className="text-sm mb-4" style={{ color: 'var(--text-soft)' }}>
              We'll record about 60 seconds of you reading short sentences out loud.
              That's enough for Cadence to clone your voice so it can speak in <em>your</em>
              voice later.
            </p>
            <ul className="text-sm space-y-1.5 mb-5" style={{ color: 'var(--text-soft)' }}>
              <li>• Find a quiet room</li>
              <li>• Speak in your normal voice — calm and clear</li>
              <li>• You can stop anytime after 30 seconds</li>
            </ul>
            {error && (
              <div className="mb-4 px-3 py-2 rounded-xl text-sm"
                   style={{ background: '#fce8e8', color: '#7d3838' }}>{error}</div>
            )}
            <div className="flex gap-2">
              <button onClick={start}
                      className="flex-1 py-4 rounded-2xl text-base font-semibold"
                      style={{ background: 'var(--tile-selected)', color: 'white' }}>
                Start recording
              </button>
              <button onClick={onClose}
                      className="px-5 py-4 rounded-2xl text-sm"
                      style={{ color: 'var(--text-soft)' }}>
                Cancel
              </button>
            </div>
          </>
        )}

        {stage === 'recording' && (
          <>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-sm font-medium"
                   style={{ color: '#b04848' }}>
                <span className="w-2.5 h-2.5 rounded-full calm-pulse"
                      style={{ background: '#d05858' }} />
                Recording
              </div>
              <div className="text-sm tabular-nums" style={{ color: 'var(--text-soft)' }}>
                {String(Math.floor(seconds / 60)).padStart(2, '0')}
                :{String(seconds % 60).padStart(2, '0')} / 01:00
              </div>
            </div>

            {/* Progress bar */}
            <div className="h-2 rounded-full mb-1" style={{ background: 'var(--border)' }}>
              <div className="h-2 rounded-full transition-all"
                   style={{ width: `${pct * 100}%`,
                            background: reached ? 'var(--tile-selected)' : '#d2c478' }} />
            </div>
            <p className="text-xs mb-4" style={{ color: 'var(--text-faint)' }}>
              {reached ? '✓ Long enough — you can stop anytime now' : `${MIN_SECONDS - seconds}s to minimum`}
            </p>

            {/* Mic level meter */}
            <div className="flex items-end gap-1 h-10 mb-5">
              {Array.from({ length: 20 }).map((_, i) => {
                const on = level * 20 > i
                return (
                  <div key={i}
                       className="flex-1 rounded-sm transition-all"
                       style={{
                         height: `${Math.max(15, (i + 1) * 5)}%`,
                         background: on ? 'var(--tile-selected)' : 'var(--border)',
                       }} />
                )
              })}
            </div>

            {/* Prompts to read */}
            <div className="rounded-2xl p-4 mb-5"
                 style={{ background: 'var(--bg-soft)', border: '1px solid var(--border)' }}>
              <div className="text-xs uppercase tracking-widest mb-2"
                   style={{ color: 'var(--text-faint)' }}>
                Read these out loud
              </div>
              <ol className="text-base space-y-2 list-decimal list-inside"
                  style={{ color: 'var(--text)' }}>
                {PROMPTS.slice(0, 8).map((p, i) => (
                  <li key={i} className="leading-snug">{p}</li>
                ))}
              </ol>
            </div>

            <button onClick={stop}
                    disabled={!reached}
                    className="w-full py-4 rounded-2xl text-base font-semibold disabled:opacity-40"
                    style={{ background: reached ? 'var(--tile-selected)' : 'var(--bg-soft)',
                             color: reached ? 'white' : 'var(--text-soft)',
                             border: reached ? 'none' : '1px solid var(--border)' }}>
              {reached ? 'Done recording' : `Keep going (${MIN_SECONDS - seconds}s)`}
            </button>
          </>
        )}

        {stage === 'review' && (
          <>
            <h2 className="text-xl font-semibold mb-2">Listen back</h2>
            <p className="text-sm mb-4" style={{ color: 'var(--text-soft)' }}>
              Make sure you can hear yourself clearly without background noise.
              If it sounds muffled or quiet, record again.
            </p>
            {previewUrl && (
              <audio controls src={previewUrl} className="w-full mb-4" />
            )}
            {error && (
              <div className="mb-4 px-3 py-2 rounded-xl text-sm"
                   style={{ background: '#fce8e8', color: '#7d3838' }}>{error}</div>
            )}
            <div className="flex gap-2">
              <button onClick={retry}
                      className="flex-1 py-4 rounded-2xl text-base font-semibold"
                      style={{ background: 'var(--bg-soft)', color: 'var(--text)',
                               border: '1px solid var(--border)' }}>
                Record again
              </button>
              <button onClick={upload}
                      className="flex-1 py-4 rounded-2xl text-base font-semibold"
                      style={{ background: 'var(--tile-selected)', color: 'white' }}>
                Use this voice
              </button>
            </div>
          </>
        )}

        {stage === 'uploading' && (
          <div className="py-8 text-center">
            <div className="text-3xl mb-3 calm-pulse">🎙️</div>
            <p className="text-base mb-1" style={{ color: 'var(--text)' }}>
              Cloning your voice…
            </p>
            <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
              This usually takes 15-30 seconds.
            </p>
          </div>
        )}

        {stage === 'done' && (
          <div className="py-6 text-center">
            <div className="text-4xl mb-3">✓</div>
            <h2 className="text-xl font-semibold mb-2">Your voice is ready</h2>
            <p className="text-sm mb-5" style={{ color: 'var(--text-soft)' }}>
              From now on Cadence will speak in your voice.
            </p>
            <button onClick={onClose}
                    className="px-6 py-3 rounded-2xl text-base font-semibold"
                    style={{ background: 'var(--tile-selected)', color: 'white' }}>
              Continue
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
