# Cadence 🌊

> **Real-time assistive communication that lets people who can't speak keep up with a live conversation — in their own voice, with real emotion.**

Built solo in ~24 hours at the **UC Berkeley AI Hackathon** (June 2026).

<!-- TODO: replace with actual demo link -->
**[▶ Demo video / GIF placeholder](#)**

---

## What it does

Cadence is an augmentative and alternative communication (AAC) tool designed for people who are nonverbal or losing speech — including those with ALS, autism, aphasia, and cerebral palsy. It listens to the conversation partner in real time, presents AI-picked concept tiles the user can tap, and turns those taps into natural, first-person sentences spoken aloud in the user's own cloned voice with emotionally appropriate delivery.

Unlike traditional AAC, Cadence grounds every reply in what the other person just said: the same two taps after "Are you hungry?" and after "Did you like the food?" produce completely different sentences. The user always picks the final candidate before anything is spoken — Cadence proposes, never decides.

---

## How it works

The backend runs a multi-agent pipeline with overlapping stages to minimize latency:

```
Partner speaks → Deepgram streaming ASR → live transcript
                                            ↓
                            ┌── Tiles agent (Claude) picks contextual tiles
                            ├── Suggester (Claude) predicts quick replies
                            └── Memory (Redis) stores turn history
                                            ↓
                 User taps tiles → Generator (Claude) fuses context + taps + memory
                                            ↓
                          Emotion tagging → per-emotion voice settings
                                            ↓
                        ElevenLabs TTS → spoken in user's cloned voice
```

1. **Streaming ASR (Listener)** — Deepgram Nova-2 via raw WebSocket with interim results, endpointing, and KeepAlive pings to survive long conversational pauses.
2. **Tiles agent** — After each partner turn, Claude reads the conversation and picks the 12 most relevant concept tiles (short words and phrases the user is likely to need).
3. **Suggester** — Proactively predicts 2 likely full-sentence replies with no taps needed.
4. **Generator (Fusion Engine)** — The core of Cadence. Takes the tapped concept tiles, the heard context, and conversation history from Redis, and produces 3 natural first-person candidates, each tagged with one of 13 emotion labels.
5. **Emotion-tuned TTS** — Each emotion label maps to hand-tuned ElevenLabs voice settings (stability, similarity boost, style, speed) so cloned voices don't warble or over-act. The audio is streamed as MP3 via a GET endpoint so `<audio src=...>` can stream natively.
6. **Redis Memory** — Per-session conversation history (24-hour TTL), pinned/recent vocabulary, and cloned voice ID are stored in Redis. All features degrade gracefully when Redis is unavailable.

### Latency work

- **TTS pre-warming** — the moment the Generator returns candidates, all three audio files are fetched in parallel so tap-to-speech feels near-instant.
- **AudioWorklet-level mic gating** — audio bytes are dropped at the AudioWorklet when it's the user's turn, preventing the system from transcribing its own spoken output (echo loop) or polluting memory with room noise.
- **Pipeline overlap** — tiles, suggestions, and memory fetch fire concurrently on each partner turn completion, not sequentially.
- **Deepgram KeepAlive + browser heartbeat** — the backend sends periodic KeepAlive frames to Deepgram and ping frames to the browser so neither connection idles out during the user's composing phase.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 · Vite · Tailwind CSS · Framer Motion · Web Audio API (AudioWorklet) |
| Backend | FastAPI · WebSockets · Python 3.11+ |
| Speech-to-text | Deepgram (Nova-2 streaming) |
| LLM | Claude Haiku 4.5 (Anthropic) |
| Memory | Redis |
| Text-to-speech | ElevenLabs (Instant Voice Cloning, `eleven_turbo_v2_5`) |

---

## Local setup

### Prerequisites

- Python 3.11+
- Node.js 18+
- API keys for [Deepgram](https://deepgram.com), [Anthropic](https://console.anthropic.com), and [ElevenLabs](https://elevenlabs.io)
- (Optional) A Redis instance — the app works without it, but memory/vocab/voice-clone persistence require it

### 1. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Copy the example env file and add your keys:

```bash
cp .env.example .env
# Edit .env with your API keys
```

Run the server:

```bash
python main.py
# → FastAPI on http://localhost:8000
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
# → Vite dev server on http://localhost:5173
```

### 3. Use it

Open [http://localhost:5173](http://localhost:5173), click **Connect**, grant microphone access, and start talking.

> **No mic handy?** Expand the "Practice" panel at the bottom to type a partner phrase and test the full pipeline without audio.

---

## Project structure

```
cadence/
├── backend/
│   ├── main.py              # FastAPI app — all agents, WebSocket, TTS, memory
│   ├── requirements.txt
│   ├── .env.example
│   └── .env                  # your local keys (git-ignored)
├── frontend/
│   ├── public/
│   │   └── audio-processor.js   # AudioWorklet — PCM16 mic capture + gating
│   ├── src/
│   │   ├── App.jsx           # Main app — turn state machine, tiles, candidates, TTS
│   │   ├── Landing.jsx       # Welcome page + profile picker (ocean wave animation)
│   │   ├── Demo.jsx          # "How it works" pitch page with A/B audio comparison
│   │   ├── Tutorial.jsx      # Step-by-step guided walkthrough
│   │   ├── VoiceRecorder.jsx # Voice-banking flow (record → clone via ElevenLabs)
│   │   ├── symbols.js        # Emoji symbol map for PECS-style tile rendering
│   │   ├── index.css          # Design tokens + animations
│   │   └── main.jsx          # React entry point
│   └── package.json
├── .gitignore
└── README.md
```

---

## Note

This is a working prototype built at a hackathon — not a medical device. For any clinical use, consult a speech-language pathologist. Voices are cloned with consent and stored privately per session.

---

*Built solo by Yash Patil at the UC Berkeley AI Hackathon, June 2026.*
