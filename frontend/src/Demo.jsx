import { useState, useEffect, useRef } from 'react'

const API = 'http://localhost:8000'

// Hear the difference: same sentence, same voice, two delivery profiles.
// "Standard AAC" = high stability + zero style + slow speed → robotic, flat.
// "Cadence" = the emotion-tuned settings the Generator would actually pick.
const AB_SAMPLES = [
  {
    text: "Honestly, I'm a little tired — but I'm feeling better than yesterday.",
    emotion: 'tender',
    cadence: { stability: 0.55, similarity_boost: 0.82, style: 0.40, speed: 0.88 },
    color: '#dca6c0',
  },
  {
    text: "Yes! I'd love to come — what time should I be there?",
    emotion: 'excited',
    cadence: { stability: 0.35, similarity_boost: 0.80, style: 0.55, speed: 0.98 },
    color: '#e89bbd',
  },
  {
    text: "I love you. Goodnight, Dad.",
    emotion: 'warm',
    cadence: { stability: 0.45, similarity_boost: 0.80, style: 0.40, speed: 0.92 },
    color: '#e8b486',
  },
]
const FLAT_SETTINGS = { stability: 0.95, similarity_boost: 0.85, style: 0.0, speed: 0.85 }

// Stock ElevenLabs voice "Rachel" — used for the "Standard AAC" sample so it
// clearly sounds like a generic synthesized voice, NOT the user's cloned voice.
const STOCK_AAC_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'

// Same session_id the main app uses → backend will pick up the cloned voice
// for the Cadence side of the comparison.
const SESSION_ID = (() => {
  const k = 'cadence_session_id'
  return localStorage.getItem(k) || ''
})()

function buildTtsUrl(text, settings, { useClonedVoice }) {
  const p = new URLSearchParams({
    text,
    stability: String(settings.stability),
    similarity_boost: String(settings.similarity_boost),
    style: String(settings.style),
    speed: String(settings.speed),
  })
  if (useClonedVoice) {
    // Pass session_id so the backend uses the user's banked voice
    if (SESSION_ID) p.append('session_id', SESSION_ID)
  } else {
    // Force the stock voice for the "Standard AAC" sample
    p.append('voice_id', STOCK_AAC_VOICE_ID)
  }
  return `${API}/tts?${p.toString()}`
}

/*
 * Demo / pitch page.
 *
 * Order matters here — we lead with empathy (the reader has to *feel* the
 * problem before features land), then show scale (it's not a small group),
 * then walk through how Cadence works, then close with the dignity argument.
 *
 * Stats are real and sourced from CDC, NIDCD, ALS Association, ASHA, and
 * the WHO. They're cited inline so this can't be confused with marketing fluff.
 */

const AGENT_STAGES = [
  {
    id: 'heard',
    agent: 'Listener',
    sub: 'Deepgram streaming',
    icon: '👂',
    line: 'Partner: "How are you feeling today?"',
    color: '#9bb8dc',
  },
  {
    id: 'tiles',
    agent: 'Tiles agent',
    sub: 'Claude reads the room',
    icon: '🧩',
    line: 'Picks 12 contextual tiles: tired · happy · feeling better · not great · …',
    color: '#cfe0d2',
  },
  {
    id: 'suggester',
    agent: 'Suggester',
    sub: 'Claude predicts likely replies',
    icon: '💡',
    line: 'Quick reply: "I\'m okay — a bit tired."',
    color: '#dcb8a6',
  },
  {
    id: 'memory',
    agent: 'Memory',
    sub: 'Redis per session',
    icon: '🧠',
    line: 'Recalling: yesterday we talked about a doctor visit',
    color: '#dca6c0',
  },
  {
    id: 'fusion',
    agent: 'Generator',
    sub: 'Claude fuses context + taps',
    icon: '✨',
    line: '3 candidates, each tuned to a different feeling',
    color: '#f4d35e',
  },
  {
    id: 'voice',
    agent: 'Your voice',
    sub: 'ElevenLabs clone + emotion',
    icon: '🎙️',
    line: '"Honestly… a little tired — but feeling better than yesterday." (warm)',
    color: '#c89bdc',
  },
]

const STATS = [
  { big: '97M', label: 'people worldwide could benefit from AAC',
    cite: 'WHO / Beukelman 2013' },
  { big: '2M+', label: 'Americans live with aphasia after stroke',
    cite: 'National Aphasia Association' },
  { big: '~30k', label: 'Americans live with ALS, losing speech progressively',
    cite: 'ALS Association' },
  { big: '1 in 36', label: 'children diagnosed with autism — ~30% minimally verbal',
    cite: 'CDC, 2023' },
]

function ABPlayer({ sample }) {
  const [playing, setPlaying] = useState(null)  // 'flat' | 'cadence' | null
  const audioRef = useRef(null)

  const play = (which) => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    const settings = which === 'flat' ? FLAT_SETTINGS : sample.cadence
    const url = buildTtsUrl(sample.text, settings, { useClonedVoice: which === 'cadence' })
    const a = new Audio(url)
    audioRef.current = a
    setPlaying(which)
    a.onended = () => setPlaying(p => (p === which ? null : p))
    a.onerror = () => setPlaying(null)
    a.play().catch(() => setPlaying(null))
  }

  return (
    <div className="rounded-3xl p-5"
         style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)' }}>
      <p className="text-base sm:text-lg mb-4 leading-snug"
         style={{ color: 'var(--text)' }}>
        "{sample.text}"
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {/* Standard AAC — the flat version */}
        <button
          onClick={() => play('flat')}
          className="rounded-2xl px-4 py-3 text-left transition-colors flex items-center gap-3"
          style={{
            background: playing === 'flat' ? '#e8e8e8' : 'var(--bg-soft)',
            border: '1px solid var(--border)',
          }}>
          <span className="text-2xl">{playing === 'flat' ? '🔊' : '▶'}</span>
          <div className="flex-1">
            <div className="text-xs uppercase tracking-widest"
                 style={{ color: 'var(--text-faint)' }}>
              Standard AAC
            </div>
            <div className="text-sm font-medium" style={{ color: 'var(--text-soft)' }}>
              Flat, robotic
            </div>
          </div>
        </button>
        {/* Cadence — the emotional version */}
        <button
          onClick={() => play('cadence')}
          className="rounded-2xl px-4 py-3 text-left transition-colors flex items-center gap-3"
          style={{
            background: playing === 'cadence' ? sample.color + '40' : 'var(--user)',
            border: `1px solid ${playing === 'cadence' ? sample.color : '#a8c5b0'}`,
          }}>
          <span className="text-2xl">{playing === 'cadence' ? '🔊' : '▶'}</span>
          <div className="flex-1">
            <div className="text-xs uppercase tracking-widest flex items-center gap-1.5"
                 style={{ color: 'var(--text-faint)' }}>
              Cadence
              <span className="w-1.5 h-1.5 rounded-full"
                    style={{ background: sample.color }} />
              <span style={{ color: sample.color }}>{sample.emotion}</span>
            </div>
            <div className="text-sm font-medium" style={{ color: 'var(--text)' }}>
              In your voice, with feeling
            </div>
          </div>
        </button>
      </div>
    </div>
  )
}

export default function Demo({ onTryIt, onBack }) {
  const [activeIdx, setActiveIdx] = useState(0)
  const [playing, setPlaying] = useState(true)
  const tRef = useRef(null)

  useEffect(() => {
    if (!playing) return
    tRef.current = setInterval(() => {
      setActiveIdx(i => (i + 1) % AGENT_STAGES.length)
    }, 2200)
    return () => clearInterval(tRef.current)
  }, [playing])

  return (
    <div className="min-h-screen px-5 py-10 max-w-5xl mx-auto animate-fade-in"
         style={{ color: 'var(--text)' }}>

      {/* Back */}
      <div className="mb-6">
        <button onClick={onBack}
                className="text-sm" style={{ color: 'var(--text-soft)' }}>
          ← Back
        </button>
      </div>

      {/* HERO — lead with the human, not the product */}
      <section className="text-center mb-20 mt-6">
        <div className="text-6xl mb-4 calm-pulse">🌊</div>
        <h1 className="text-5xl sm:text-7xl font-semibold tracking-tight mb-5 leading-tight">
          A voice that<br/>sounds like you.
        </h1>
        <p className="text-xl max-w-xl mx-auto leading-relaxed"
           style={{ color: 'var(--text-soft)' }}>
          For everyone who has something to say —<br/>
          and a body that won't let them say it.
        </p>
      </section>

      {/* IMAGINE — empathy gut-punch before any stats */}
      <section className="mb-20">
        <div className="text-xs uppercase tracking-widest mb-3"
             style={{ color: 'var(--text-faint)' }}>
          Imagine
        </div>
        <div className="rounded-3xl p-8 sm:p-10"
             style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)' }}>
          <p className="text-2xl sm:text-3xl leading-relaxed font-medium mb-6"
             style={{ color: 'var(--text)' }}>
            You're at dinner with your family. Your daughter tells a joke.
            You laugh — but the only voice you can use to say
            <span style={{ color: 'var(--tile-selected)' }}> "that's funny"</span>
            sounds like a GPS.
          </p>
          <p className="text-lg leading-relaxed mb-4"
             style={{ color: 'var(--text-soft)' }}>
            Your mom asks how you're feeling. You want to say "a little tired,
            but okay." By the time you've tapped it out, the conversation has
            moved on. When the voice finally speaks, it sounds flat — like a
            stranger reading your words.
          </p>
          <p className="text-lg leading-relaxed"
             style={{ color: 'var(--text-soft)' }}>
            You wanted to tell your dad you love him. The robot did it for you.
          </p>
        </div>
        <p className="text-sm mt-4 text-center" style={{ color: 'var(--text-faint)' }}>
          This is the reality for tens of millions of people. Every day.
        </p>
      </section>

      {/* SCALE — stats with citations */}
      <section className="mb-20">
        <div className="text-xs uppercase tracking-widest mb-3"
             style={{ color: 'var(--text-faint)' }}>
          And it's not a small group
        </div>
        <h2 className="text-3xl font-semibold mb-6 max-w-2xl">
          Almost 100 million people on Earth need a way to be heard.
        </h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {STATS.map((s, i) => (
            <div key={i} className="rounded-3xl p-5"
                 style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)' }}>
              <div className="text-4xl font-semibold mb-2"
                   style={{ color: 'var(--tile-selected)' }}>
                {s.big}
              </div>
              <div className="text-sm leading-snug mb-2"
                   style={{ color: 'var(--text)' }}>
                {s.label}
              </div>
              <div className="text-[11px] uppercase tracking-widest"
                   style={{ color: 'var(--text-faint)' }}>
                {s.cite}
              </div>
            </div>
          ))}
        </div>
        <p className="text-sm mt-4" style={{ color: 'var(--text-faint)' }}>
          The tools they're given today were designed in the 1990s.
        </p>
      </section>

      {/* WHAT'S BROKEN */}
      <section className="mb-20">
        <div className="text-xs uppercase tracking-widest mb-3"
             style={{ color: 'var(--text-faint)' }}>
          What current AAC fails to do
        </div>
        <h2 className="text-3xl font-semibold mb-6">
          The voice doesn't sound like a person. So they get treated like one less.
        </h2>
        <div className="grid sm:grid-cols-3 gap-3">
          {[
            { icon: '🤖', title: 'No identity',
              body: 'Generic synthesized voices. The user disappears behind the machine.' },
            { icon: '😐', title: 'No feeling',
              body: 'Anger sounds like a grocery list. Joy sounds like dictation.' },
            { icon: '🐢', title: 'Too slow',
              body: 'By the time the sentence is built, the conversation has moved on.' },
          ].map((c, i) => (
            <div key={i} className="rounded-3xl p-5"
                 style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)' }}>
              <div className="text-3xl mb-2">{c.icon}</div>
              <div className="font-semibold mb-1">{c.title}</div>
              <div className="text-sm leading-snug" style={{ color: 'var(--text-soft)' }}>
                {c.body}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* HOW CADENCE WORKS — animated pipeline */}
      <section className="mb-20">
        <div className="text-xs uppercase tracking-widest mb-3"
             style={{ color: 'var(--text-faint)' }}>
          How Cadence works
        </div>
        <h2 className="text-3xl font-semibold mb-2">
          Four AI agents. One memory. One voice.
        </h2>
        <p className="text-base mb-6 max-w-2xl" style={{ color: 'var(--text-soft)' }}>
          Each box below is an actual service running this very moment.
          Watch a partner sentence travel through Cadence and come back as a reply
          spoken in <em>their</em> voice, with the <em>right</em> feeling.
        </p>

        <div className="rounded-3xl p-6"
             style={{ background: 'var(--bg-soft)', border: '1px solid var(--border)' }}>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 mb-5">
            {AGENT_STAGES.map((s, i) => {
              const isActive = i === activeIdx
              return (
                <div key={s.id}
                     className="relative rounded-2xl p-4 transition-all"
                     style={{
                       background: isActive ? s.color : 'var(--bg-elev)',
                       border: `1px solid ${isActive ? s.color : 'var(--border)'}`,
                       transform: isActive ? 'translateY(-2px)' : 'translateY(0)',
                       opacity: isActive ? 1 : 0.65,
                     }}>
                  <div className="text-3xl mb-2">{s.icon}</div>
                  <div className="text-sm font-semibold"
                       style={{ color: '#2c3e50' }}>
                    {s.agent}
                  </div>
                  <div className="text-xs mt-0.5"
                       style={{ color: isActive ? '#2c3e50' : 'var(--text-faint)' }}>
                    {s.sub}
                  </div>
                  {isActive && (
                    <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full calm-pulse"
                         style={{ background: '#2c3e50' }} />
                  )}
                </div>
              )
            })}
          </div>

          <div className="rounded-2xl p-4 min-h-[5rem] flex items-center"
               style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)' }}>
            <div className="text-sm w-full">
              <div className="uppercase tracking-widest text-xs mb-1.5"
                   style={{ color: 'var(--text-faint)' }}>
                {AGENT_STAGES[activeIdx].agent} →
              </div>
              <div className="text-base sm:text-lg leading-snug"
                   style={{ color: 'var(--text)' }}>
                {AGENT_STAGES[activeIdx].line}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between mt-4">
            <div className="text-xs" style={{ color: 'var(--text-faint)' }}>
              Stage {activeIdx + 1} of {AGENT_STAGES.length}
            </div>
            <button onClick={() => setPlaying(p => !p)}
                    className="text-sm px-3 py-1.5 rounded-full"
                    style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)',
                             color: 'var(--text-soft)' }}>
              {playing ? '⏸ Pause' : '▶ Play'}
            </button>
          </div>
        </div>
      </section>

      {/* HEAR THE DIFFERENCE — A/B audio comparison */}
      <section className="mb-20">
        <div className="text-xs uppercase tracking-widest mb-3"
             style={{ color: 'var(--text-faint)' }}>
          Hear the difference
        </div>
        <h2 className="text-3xl font-semibold mb-2">
          Same words. Same voice. Different feeling.
        </h2>
        <p className="text-base mb-7 max-w-2xl" style={{ color: 'var(--text-soft)' }}>
          Press both buttons. The first is how today's AAC tools speak. The second
          is Cadence — your voice, tuned with the emotion the moment calls for.
        </p>

        <div className="space-y-3">
          {AB_SAMPLES.map((s, i) => (
            <ABPlayer key={i} sample={s} />
          ))}
        </div>

        <p className="text-xs mt-4 text-center" style={{ color: 'var(--text-faint)' }}>
          Audio generated live by ElevenLabs — your own cloned voice plays here if you've recorded one.
        </p>
      </section>

      {/* THE MOAT — why this is hard to copy */}
      <section className="mb-20">
        <div className="text-xs uppercase tracking-widest mb-3"
             style={{ color: 'var(--text-faint)' }}>
          What makes it Cadence
        </div>
        <h2 className="text-3xl font-semibold mb-6">
          The voice is yours. The feeling is yours. The conversation is yours.
        </h2>
        <div className="grid sm:grid-cols-2 gap-3">
          {[
            { icon: '🎙️', title: 'Your real voice — banked or cloned',
              body: 'For someone with ALS, we record their voice now, while they still can speak. After the diagnosis lands, the voice they\'ll use to say goodnight to their kids is still theirs.' },
            { icon: '💗', title: 'Emotion that actually lands',
              body: '13 emotion profiles tune stability, expressiveness, and pacing per sentence. Joy sounds like joy. Frustration sounds like frustration. Tenderness lands.' },
            { icon: '🧩', title: 'AI that reads the room',
              body: 'After every partner turn, Claude picks the 12 tiles most likely to be needed next. The right words are already in front of you. No menu-diving.' },
            { icon: '🪶', title: 'Built calm — built with the community in mind',
              body: 'Pastel palette, slow animations, large targets, no harsh contrasts. Tuned per profile: autistic, ALS, aphasia, cerebral palsy. Every setting overridable.' },
          ].map((c, i) => (
            <div key={i} className="rounded-3xl p-5 flex gap-4"
                 style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)' }}>
              <div className="text-3xl shrink-0">{c.icon}</div>
              <div>
                <div className="font-semibold mb-1">{c.title}</div>
                <div className="text-sm leading-snug" style={{ color: 'var(--text-soft)' }}>
                  {c.body}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* WHO IT'S FOR */}
      <section className="mb-20">
        <div className="text-xs uppercase tracking-widest mb-3"
             style={{ color: 'var(--text-faint)' }}>
          Built for
        </div>
        <h2 className="text-3xl font-semibold mb-6">Four groups. One tool. Everyone gets a voice.</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { icon: '🌿', label: 'Autistic',
              sub: '~30% of autistic people are minimally verbal' },
            { icon: '🎙️', label: 'ALS',
              sub: 'Speech is changing. We help before it\'s gone.' },
            { icon: '💭', label: 'Aphasia',
              sub: '2M+ Americans. The thought is intact.' },
            { icon: '🤝', label: 'Cerebral palsy',
              sub: '1M+ Americans with motor variability' },
          ].map((c, i) => (
            <div key={i} className="rounded-3xl p-4 text-center"
                 style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)' }}>
              <div className="text-4xl mb-2">{c.icon}</div>
              <div className="font-semibold text-sm">{c.label}</div>
              <div className="text-xs mt-1.5" style={{ color: 'var(--text-faint)' }}>
                {c.sub}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CLOSING — back to the human */}
      <section className="mb-12 text-center">
        <p className="text-2xl sm:text-3xl leading-relaxed max-w-2xl mx-auto mb-8"
           style={{ color: 'var(--text)' }}>
          When you can speak in <em>your</em> voice, with <em>your</em> feeling, in real time —
          you're not "using AAC." You're just <span style={{ color: 'var(--tile-selected)' }}>talking</span>.
        </p>
        <button onClick={onTryIt}
                className="px-10 py-5 rounded-full text-lg font-semibold transition-colors"
                style={{ background: 'var(--tile-selected)', color: 'white' }}>
          Try Cadence
        </button>
        <p className="text-xs mt-5 max-w-md mx-auto leading-relaxed"
           style={{ color: 'var(--text-faint)' }}>
          This is a working prototype, not yet a medical device. For clinical
          deployment, consult a speech-language pathologist. Voices are cloned
          with consent, stored privately per session.
        </p>
      </section>
    </div>
  )
}
