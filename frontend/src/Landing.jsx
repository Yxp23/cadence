import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

/*
 * Landing — gentle welcome + profile picker. Sets up Cadence's defaults for
 * the user's specific situation. No high-energy animation; everything fades in
 * slowly so it doesn't overwhelm anyone with sensory sensitivities.
 */

// Each profile maps to defaults that tune the rest of the app for that user.
// Add new keys here whenever a new feature needs to behave differently per profile.
export const PROFILES = {
  autistic: {
    key: 'autistic',
    title: 'Autistic',
    blurb: 'Nonverbal or minimally verbal. Tiles show pictures + words for easier recognition.',
    icon: '🌿',
    defaults: {
      longPressMs: 550,
      tileFontPx: 16,           // slightly smaller because symbol takes space
      tileMinHeight: 100,
      pulseSpeedSec: 2.4,
      showSuggestions: true,
      symbolMode: true,         // PECS-style symbol + word
      dwellEnabled: false,
      showVoiceBanking: false,
      welcomeLine: "Take your time. Tap when you're ready.",
    },
  },
  als: {
    key: 'als',
    title: 'ALS',
    blurb: 'Speech is changing. Record your own voice now so we can speak in it later.',
    icon: '🎙️',
    defaults: {
      longPressMs: 700,
      tileFontPx: 18,
      tileMinHeight: 84,
      pulseSpeedSec: 2.4,
      showSuggestions: true,
      symbolMode: false,
      dwellEnabled: false,       // becomes true as ALS progresses
      showVoiceBanking: true,    // big CTA to record voice while still possible
      welcomeLine: 'Your voice. Your words. Your pace.',
    },
  },
  aphasia: {
    key: 'aphasia',
    title: 'Stroke / Aphasia',
    blurb: 'You know what you want to say. Pictures + words help retrieval.',
    icon: '💭',
    defaults: {
      longPressMs: 650,
      tileFontPx: 17,
      tileMinHeight: 100,
      pulseSpeedSec: 2.4,
      showSuggestions: true,
      emphasizeSuggestions: true, // proactive replies are huge for aphasia
      symbolMode: true,           // recognition >> retrieval
      dwellEnabled: false,
      showVoiceBanking: false,
      welcomeLine: 'The right words, ready when you are.',
    },
  },
  cp: {
    key: 'cp',
    title: 'Cerebral Palsy',
    blurb: 'Motor varies day to day. Big targets, optional hover-to-tap.',
    icon: '🤝',
    defaults: {
      longPressMs: 900,
      tileFontPx: 20,
      tileMinHeight: 110,
      pulseSpeedSec: 2.4,
      showSuggestions: true,
      symbolMode: false,
      dwellEnabled: true,         // hover-to-activate, no tap required
      dwellMs: 1100,
      showVoiceBanking: false,
      welcomeLine: 'No rush. We wait for you.',
    },
  },
  other: {
    key: 'other',
    title: 'Skip for now',
    blurb: 'Use balanced defaults. You can change this anytime.',
    icon: '✨',
    defaults: {
      longPressMs: 550,
      tileFontPx: 18,
      tileMinHeight: 84,
      pulseSpeedSec: 2.4,
      showSuggestions: true,
      symbolMode: false,
      dwellEnabled: false,
      showVoiceBanking: false,
      welcomeLine: 'Welcome.',
    },
  },
}

// Pre-generate one big pre-shaped ocean buffer that ALREADY contains the wave
// pattern baked into the samples. Looping it gives reliable, audible waves
// with no scheduling, no LFOs, no timing bugs — what you hear is what's in
// the buffer. Much harder to break than the previous live-synthesis approach.
function generateOceanBuffer(ctx, seconds = 12) {
  const sr = ctx.sampleRate
  const len = sr * seconds
  const buf = ctx.createBuffer(2, len, sr)  // stereo for width
  const cycleSeconds = 5.5  // one full wave cycle every 5.5 seconds
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch)
    let last = 0
    for (let i = 0; i < len; i++) {
      // White noise → brown-ish (low-pass via integration) for the watery body
      const white = Math.random() * 2 - 1
      last = (last + 0.04 * white) / 1.04
      const lowNoise = last * 4.5
      // Bright white noise on top (the foam hiss)
      const hiss = (Math.random() * 2 - 1) * 0.4

      // Wave envelope — sharp attack, then long roll/recede.
      // Slightly offset on right channel so it sounds stereo-wide.
      const t = i / sr + (ch === 1 ? 0.18 : 0)
      const phase = (t % cycleSeconds) / cycleSeconds  // 0..1 over each cycle
      let env
      if (phase < 0.08) {
        env = Math.pow(phase / 0.08, 0.6)              // crash builds fast
      } else if (phase < 0.35) {
        env = 1 - ((phase - 0.08) / 0.27) * 0.45       // wash phase
      } else if (phase < 0.85) {
        env = 0.55 * (1 - (phase - 0.35) / 0.5)        // recede
      } else {
        env = 0.05                                      // quiet between waves
      }

      // Mix: more lowNoise during wash, more hiss during crash peak
      const hissAmt = phase < 0.15 ? 1.2 : 0.6
      data[i] = (lowNoise * env + hiss * env * hissAmt) * 0.5
    }
  }
  return buf
}

async function startOceanSound(audioRefs) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) { console.warn('Web Audio not available'); return }
    const ctx = new Ctx()
    await ctx.resume()  // critical for Safari + autoplay policies
    audioRefs.ctx = ctx

    const buf = generateOceanBuffer(ctx, 12)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true

    // Final tonal shaping — gentle highpass to remove rumble, soft lowpass
    // to keep it warm. Master output is LOUD (0.9) so it's actually audible.
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'; hp.frequency.value = 80
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'; lp.frequency.value = 3500; lp.Q.value = 0.7

    const master = ctx.createGain()
    master.gain.value = 0
    master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 1.2)

    src.connect(hp).connect(lp).connect(master).connect(ctx.destination)
    src.start()

    console.log('🌊 Ocean sound playing — if you can\'t hear it, check system volume')

    audioRefs.master = master
    audioRefs.src = src
  } catch (e) {
    console.error('Ocean sound failed:', e)
  }
}

function stopOceanSound(audioRefs) {
  try {
    const { ctx, master, src } = audioRefs
    if (!ctx) return
    if (master) {
      master.gain.cancelScheduledValues(ctx.currentTime)
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime)
      master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5)
    }
    setTimeout(() => {
      try { src?.stop(); ctx.close() } catch {}
    }, 600)
  } catch {}
  Object.keys(audioRefs).forEach(k => delete audioRefs[k])
}

// Wave-wash background — three layered water sheets that slide down from
// above the viewport, reach a peak (covering most of the screen), then
// recede back up. Each layer has a wavy bottom edge via SVG mask and its
// own timing for parallax depth. No image asset — purely CSS + SVG mask.
//
// data-URI SVG masks (each is a wave-bottomed rectangle). The fill is
// white because mask-image uses luminance: white = visible, transparent = clipped.
const WAVE_MASK_BACK = encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'>" +
  "<path d='M0,0 L100,0 L100,82 C82,87 65,76 50,82 C32,89 16,76 0,80 Z' fill='white'/></svg>"
)
const WAVE_MASK_MID = encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'>" +
  "<path d='M0,0 L100,0 L100,76 C80,84 60,70 42,78 C24,84 12,72 0,76 Z' fill='white'/></svg>"
)
const WAVE_MASK_FRONT = encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'>" +
  "<path d='M0,0 L100,0 L100,72 C78,80 58,68 38,74 C22,78 10,68 0,72 Z' fill='white'/></svg>"
)

const waveLayerStyle = (maskUri, bg, opacity) => ({
  position: 'absolute',
  inset: 0,
  background: bg,
  opacity,
  WebkitMaskImage: `url("data:image/svg+xml,${maskUri}")`,
  maskImage: `url("data:image/svg+xml,${maskUri}")`,
  WebkitMaskSize: '100% 100%',
  maskSize: '100% 100%',
  WebkitMaskRepeat: 'no-repeat',
  maskRepeat: 'no-repeat',
  willChange: 'transform',
})

function WaveCanvas() {
  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none"
         style={{ zIndex: 0 }}>
      {/* Layer 1 — palest, furthest, slowest */}
      <div className="wave-wash-back"
           style={waveLayerStyle(
             WAVE_MASK_BACK,
             'linear-gradient(180deg, #c2dae5 0%, #a8c8d9 70%, #93b9cd 100%)',
             0.45,
           )} />
      {/* Layer 2 — mid depth, medium tempo */}
      <div className="wave-wash-mid"
           style={waveLayerStyle(
             WAVE_MASK_MID,
             'linear-gradient(180deg, #a5c5d8 0%, #80aac4 70%, #6498b3 100%)',
             0.55,
           )} />
      {/* Layer 3 — closest, fastest, most opaque */}
      <div className="wave-wash-front"
           style={waveLayerStyle(
             WAVE_MASK_FRONT,
             'linear-gradient(180deg, #80aac4 0%, #5589a3 70%, #3a6f8c 100%)',
             0.65,
           )} />

      {/* Soft top tint — keeps title legible even at peak wash */}
      <div className="absolute inset-x-0 top-0 h-[35vh] pointer-events-none"
           style={{ background: 'linear-gradient(to bottom, rgba(234,242,244,0.7), transparent)' }} />
    </div>
  )
}

export default function Landing({ onPick, onSeeDemo, onSeeTutorial }) {
  const [stage, setStage] = useState('welcome') // welcome → pick
  const [picking, setPicking] = useState(null)
  const [soundOn, setSoundOn] = useState(false)
  const audioRefs = useRef({})

  // Tear down audio on unmount or stage change away from welcome
  useEffect(() => {
    if (stage !== 'welcome' && soundOn) {
      stopOceanSound(audioRefs.current)
      setSoundOn(false)
    }
    return () => stopOceanSound(audioRefs.current)
  }, [stage, soundOn])

  const toggleSound = async () => {
    if (soundOn) {
      stopOceanSound(audioRefs.current)
      setSoundOn(false)
    } else {
      setSoundOn(true)
      await startOceanSound(audioRefs.current)
    }
  }

  const choose = (key) => {
    setPicking(key)
    setTimeout(() => onPick(PROFILES[key]), 380)
  }

  return (
    <div className="min-h-screen relative overflow-hidden"
         style={{ background: 'var(--bg)' }}>

      {/* Cinematic wave canvas — only on the welcome stage */}
      {stage === 'welcome' && <WaveCanvas />}

      {/* Sound toggle — top-right corner, completely separate from main content */}
      <AnimatePresence>
        {stage === 'welcome' && (
          <motion.button
            onClick={toggleSound}
            aria-label={soundOn ? 'Turn ocean sound off' : 'Turn ocean sound on'}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, delay: 2.4 }}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.96 }}
            className="fixed top-6 right-6 z-30 inline-flex items-center gap-2 text-sm px-4 py-2.5 rounded-full"
            style={{
              background: 'rgba(255,255,255,0.92)',
              border: '1px solid var(--border)',
              color: 'var(--text-soft)',
              backdropFilter: 'blur(8px)',
              boxShadow: '0 4px 14px rgba(44,62,80,0.08)',
            }}>
            <span aria-hidden>{soundOn ? '🔊' : '🔈'}</span>
            <span>{soundOn ? 'Sound on' : 'Sound'}</span>
          </motion.button>
        )}
      </AnimatePresence>

      <div className={`relative z-10 min-h-screen flex ${stage === 'welcome' ? 'items-start pt-[12vh]' : 'items-center'} justify-center px-5 py-10 transition-opacity duration-500 ${picking ? 'opacity-0' : 'opacity-100'}`}>
        <div className="w-full max-w-3xl">

        {stage === 'welcome' && (
          <motion.div className="text-center"
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                      transition={{ duration: 0.8 }}>
            {/* Wave glyph */}
            <motion.div className="text-5xl mb-5"
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: [0, -8, 0] }}
                        transition={{
                          opacity: { duration: 1, delay: 0.1 },
                          y: { duration: 6.5, ease: 'easeInOut', repeat: Infinity, delay: 1 },
                        }}>
              🌊
            </motion.div>

            {/* Title */}
            <motion.h1 className="font-semibold tracking-tight mb-5"
                       style={{
                         color: 'var(--text)',
                         letterSpacing: '-0.025em',
                         fontSize: 'clamp(2.75rem, 8vw, 5.5rem)',
                         lineHeight: 1.05,
                         textShadow: '0 1px 12px rgba(234,242,244,0.7)',
                       }}
                       initial={{ opacity: 0, y: 28 }}
                       animate={{ opacity: 1, y: 0 }}
                       transition={{ duration: 1.2, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}>
              Welcome to Cadence
            </motion.h1>

            {/* Subtitle */}
            <motion.p className="mx-auto mb-12"
                      style={{
                        color: 'var(--text-soft)',
                        maxWidth: '34rem',
                        fontSize: 'clamp(1.1rem, 1.9vw, 1.35rem)',
                        lineHeight: 1.5,
                      }}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 1.1, delay: 0.85, ease: [0.16, 1, 0.3, 1] }}>
              A voice that sounds like you, ready when you need it.
            </motion.p>

            {/* Primary action — huge, unmistakable, the only thing you can't miss */}
            <motion.div initial={{ opacity: 0, y: 14 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.9, delay: 1.5, ease: [0.16, 1, 0.3, 1] }}>
              <motion.button
                onClick={() => setStage('pick')}
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                transition={{ type: 'spring', stiffness: 360, damping: 22 }}
                className="rounded-full font-semibold tracking-tight"
                style={{
                  background: 'var(--tile-selected)',
                  color: 'white',
                  padding: '1.15rem 3rem',
                  fontSize: '1.2rem',
                  boxShadow: '0 14px 32px -10px rgba(95,166,114,0.55), 0 4px 10px rgba(95,166,114,0.2)',
                }}>
                Let's set it up
              </motion.button>
            </motion.div>

            {/* Secondary actions — quieter text links beneath, clearly subordinate */}
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        transition={{ duration: 0.9, delay: 2.0 }}
                        className="mt-7 flex flex-wrap items-center justify-center gap-2">
              {onSeeTutorial && (
                <motion.button onClick={onSeeTutorial}
                               whileHover={{ y: -1 }}
                               className="inline-flex items-center gap-1.5 text-base font-medium px-4 py-2 rounded-full"
                               style={{ color: 'var(--text-soft)' }}>
                  How to use it
                  <span aria-hidden>→</span>
                </motion.button>
              )}
              {onSeeDemo && (
                <motion.button onClick={onSeeDemo}
                               whileHover={{ y: -1 }}
                               className="inline-flex items-center gap-1.5 text-base font-medium px-4 py-2 rounded-full"
                               style={{ color: 'var(--text-soft)' }}>
                  How it works
                  <span aria-hidden>→</span>
                </motion.button>
              )}
            </motion.div>
          </motion.div>
        )}

        {stage === 'pick' && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}>
            <h2 className="text-3xl sm:text-4xl font-semibold mb-3 text-center"
                style={{ color: 'var(--text)' }}>
              How can we set this up for you?
            </h2>
            <p className="text-base sm:text-lg mb-10 text-center max-w-lg mx-auto"
               style={{ color: 'var(--text-soft)' }}>
              Choose what best describes you. You can change this anytime.
            </p>

            <div className="grid sm:grid-cols-2 gap-4 mb-4">
              {['autistic', 'als', 'aphasia', 'cp'].map((k, i) => {
                const p = PROFILES[k]
                return (
                  <motion.button
                    key={k}
                    onClick={() => choose(k)}
                    initial={{ opacity: 0, y: 18 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.55, delay: 0.15 + i * 0.09, ease: [0.16, 1, 0.3, 1] }}
                    whileHover={{ y: -3, boxShadow: '0 14px 28px -10px rgba(44,62,80,0.18)' }}
                    whileTap={{ scale: 0.985 }}
                    className="text-left rounded-3xl p-6"
                    style={{
                      background: 'var(--bg-elev)',
                      border: '1px solid var(--border)',
                      minHeight: 150,
                    }}>
                    <div className="text-4xl mb-3">{p.icon}</div>
                    <div className="text-xl font-semibold mb-1.5"
                         style={{ color: 'var(--text)' }}>
                      {p.title}
                    </div>
                    <div className="text-sm leading-snug"
                         style={{ color: 'var(--text-soft)' }}>
                      {p.blurb}
                    </div>
                  </motion.button>
                )
              })}
            </div>

            <motion.button
              onClick={() => choose('other')}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.6 }}
              whileHover={{ y: -1 }}
              className="w-full py-4 rounded-2xl text-sm"
              style={{ color: 'var(--text-soft)', background: 'transparent' }}>
              Skip for now
            </motion.button>
          </motion.div>
        )}
        </div>
      </div>
    </div>
  )
}
