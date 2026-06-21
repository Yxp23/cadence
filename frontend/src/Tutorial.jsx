import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

/*
 * Tutorial — guided walkthrough for new users.
 *
 * Designed for AAC users + their caregivers: one idea per screen, big visuals,
 * plain language, never assume prior tech experience. The user advances at
 * their own pace; nothing auto-advances except gentle pulse animations.
 */

const STEPS = [
  {
    icon: '🎙️',
    title: 'First, press Connect',
    body: 'This turns on the microphone so Cadence can hear the conversation. Your browser will ask permission — say yes.',
    visual: (
      <div className="rounded-2xl p-4 inline-flex items-center gap-3"
           style={{ background: 'var(--bg-soft)', border: '1px solid var(--border)' }}>
        <span className="text-sm" style={{ color: 'var(--text-faint)' }}>You'll see:</span>
        <span className="px-5 py-2.5 rounded-full text-sm font-semibold"
              style={{ background: 'var(--tile-selected)', color: 'white' }}>
          Connect
        </span>
      </div>
    ),
  },
  {
    icon: '👂',
    title: 'Watch for "Their turn"',
    body: 'The big green button at the top means Cadence is listening to the person talking to you. When they stop, it flips to "My turn" automatically.',
    visual: (
      <div className="w-full max-w-sm rounded-2xl py-4 px-6 inline-flex items-center justify-center gap-3"
           style={{ background: 'var(--partner)', border: '1px solid #b6cfde' }}>
        <span className="w-3 h-3 rounded-full calm-pulse" style={{ background: '#6f9cbf' }} />
        <span className="font-semibold">Their turn — listening</span>
      </div>
    ),
  },
  {
    icon: '💬',
    title: 'What they said shows up live',
    body: 'Anything they say appears in the "Heard" box in real time, so you always know what you\'re replying to.',
    visual: (
      <div className="w-full max-w-sm rounded-2xl px-5 py-4"
           style={{ background: 'var(--bg-soft)', border: '1px solid var(--border)' }}>
        <div className="text-xs uppercase tracking-widest mb-1.5"
             style={{ color: 'var(--text-faint)' }}>Heard</div>
        <div className="text-lg" style={{ color: 'var(--text)' }}>
          How are you feeling today?
        </div>
      </div>
    ),
  },
  {
    icon: '🧩',
    title: 'Tap the words you want to say',
    body: 'Cadence picks the most useful words for the moment. Tap up to 4 — they don\'t have to make a full sentence, just the idea.',
    visual: (
      <div className="grid grid-cols-3 gap-2.5 max-w-sm mx-auto">
        {[
          { t: 'tired', sel: true },
          { t: 'okay', sel: false },
          { t: 'better', sel: true },
        ].map((x, i) => (
          <div key={i} className={`tile ${x.sel ? 'selected' : ''}`}
               style={{ minHeight: 70, fontSize: 16 }}>
            {x.t}
          </div>
        ))}
      </div>
    ),
  },
  {
    icon: '✨',
    title: 'Make sentences',
    body: 'Cadence turns your taps into 3 full sentences — each with a different feeling. Pick whichever sounds most like you.',
    visual: (
      <div className="w-full max-w-md space-y-2">
        {[
          { t: 'Honestly, I\'m pretty tired — but feeling better.', e: 'warm', c: '#e8b486' },
          { t: 'A bit worn out, but okay.', e: 'thoughtful', c: '#9bb8dc' },
        ].map((x, i) => (
          <div key={i} className="px-4 py-3 rounded-2xl flex items-start justify-between gap-3"
               style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)' }}>
            <span style={{ color: 'var(--text)' }}>{x.t}</span>
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest mt-1.5"
                  style={{ color: 'var(--text-faint)' }}>
              <span className="w-2 h-2 rounded-full" style={{ background: x.c }} />
              {x.e}
            </span>
          </div>
        ))}
      </div>
    ),
  },
  {
    icon: '🔊',
    title: 'Tap the one you want — and you speak',
    body: 'Cadence says it out loud in your cloned voice, with the feeling you picked. That\'s the whole conversation loop.',
    visual: (
      <div className="px-5 py-4 rounded-2xl max-w-md mx-auto"
           style={{ background: 'var(--user)', border: '1px solid var(--tile-selected)' }}>
        <span className="text-lg" style={{ color: 'var(--text)' }}>
          🔊 Honestly, I'm pretty tired — but feeling better.
        </span>
      </div>
    ),
  },
  {
    icon: '⚙️',
    title: 'Make it yours',
    body: 'Hold a tile to pin it always. Tap "+" to add custom words. The gear icon adjusts tile size, hold time, speech speed — everything is overridable.',
    visual: (
      <div className="flex flex-wrap items-center justify-center gap-3 max-w-md mx-auto">
        <div className="tile pinned" style={{ minHeight: 70, fontSize: 16, width: 100 }}>mom</div>
        <div className="tile add" style={{ minHeight: 70, fontSize: 24, width: 60 }}>+</div>
        <div className="w-11 h-11 rounded-full flex items-center justify-center text-xl"
             style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)' }}>
          ⚙
        </div>
      </div>
    ),
  },
  {
    icon: '🌊',
    title: "You're ready",
    body: 'That\'s really it. Connect, listen, tap, speak. Cadence handles the rest.',
    visual: null,
  },
]

export default function Tutorial({ onDone, onBack }) {
  const [idx, setIdx] = useState(0)
  const step = STEPS[idx]
  const isLast = idx === STEPS.length - 1

  return (
    <div className="min-h-screen flex flex-col px-5 py-8 max-w-3xl mx-auto"
         style={{ color: 'var(--text)' }}>

      {/* Top bar — back + progress */}
      <div className="flex items-center justify-between mb-8">
        <button onClick={onBack}
                className="text-sm" style={{ color: 'var(--text-soft)' }}>
          ← Back
        </button>
        <div className="text-xs tracking-widest uppercase"
             style={{ color: 'var(--text-faint)' }}>
          Step {idx + 1} of {STEPS.length}
        </div>
        <button onClick={onDone}
                className="text-sm" style={{ color: 'var(--text-soft)' }}>
          Skip
        </button>
      </div>

      {/* Calm progress dots */}
      <div className="flex items-center justify-center gap-2 mb-10">
        {STEPS.map((_, i) => (
          <motion.div
            key={i}
            animate={{
              width: i === idx ? 28 : 8,
              backgroundColor: i <= idx ? 'var(--tile-selected)' : 'var(--border)',
            }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="h-2 rounded-full"
          />
        ))}
      </div>

      {/* Step content */}
      <div className="flex-1 flex flex-col items-center justify-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={idx}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="text-center w-full max-w-2xl">

            <div className="text-6xl mb-6">{step.icon}</div>

            <h2 className="text-3xl sm:text-4xl font-semibold mb-4"
                style={{ color: 'var(--text)', letterSpacing: '-0.01em' }}>
              {step.title}
            </h2>

            <p className="text-lg leading-relaxed mb-10 max-w-lg mx-auto"
               style={{ color: 'var(--text-soft)' }}>
              {step.body}
            </p>

            {step.visual && (
              <motion.div
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.25, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                className="flex justify-center mb-2">
                {step.visual}
              </motion.div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Footer — primary action */}
      <div className="mt-10 flex flex-col items-center gap-3">
        <motion.button
          onClick={() => (isLast ? onDone() : setIdx(i => i + 1))}
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 360, damping: 22 }}
          className="px-10 py-4 rounded-full text-base font-semibold"
          style={{
            background: 'var(--tile-selected)',
            color: 'white',
            boxShadow: '0 10px 24px -8px rgba(95,166,114,0.5)',
            minWidth: 220,
          }}>
          {isLast ? "Let's get started" : 'Next'}
        </motion.button>

        {idx > 0 && (
          <button onClick={() => setIdx(i => i - 1)}
                  className="text-sm" style={{ color: 'var(--text-soft)' }}>
            Previous
          </button>
        )}
      </div>
    </div>
  )
}
