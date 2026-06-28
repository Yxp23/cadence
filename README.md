# Cadence — a voice that sounds like you

Real-time AAC that lets people who can't speak keep up with a conversation, in their own voice.

Built solo in 24 hours at the UC Berkeley AI Hackathon 2026.

## The problem

Nearly 100 million people worldwide can't rely on their own voice — ALS, stroke, autism, cerebral palsy. The cruelest part of a condition like aphasia is that the person knows exactly what they want to say and just can't get it out. And the augmentative and alternative communication (AAC) tools they're given today were designed in the 1990s: robotic voices, slow menus that take minutes to navigate, zero emotion.

Cadence is built to change that.

## What it does

Cadence listens to the conversation live. When someone taps a few concept tiles, it turns them into a full, natural sentence — spoken in a clone of the person's own voice, with the right emotion, in seconds.

It's not autocomplete. The wedge is that every other AAC tool predicts in a vacuum — Cadence is the first to ground every reply in what the other person just said. The same two taps after "Are you hungry?" and after "Did you like the food?" produce completely different sentences, because it heard the difference.

And it always proposes, never speaks for you — the user picks the candidate before anything is said aloud. Agency stays with the person.

## How it works

A 4-agent real-time pipeline, plus a cloned-voice layer:

| Layer | Tech | Role |
| --- | --- | --- |
| Listener | Deepgram streaming WS | Real-time partner transcription with endpointing + KeepAlive |
| Tiles agent | Claude Haiku | Picks the most contextually relevant tiles after each partner turn |
| Suggester | Claude Haiku | Proactive reply predictions with no taps needed |
| Generator | Claude Haiku | Fuses heard context + taps + memory into 3 emotion-tagged candidates |
| Memory | Redis (per session) | Persistent conversation log; recent turns feed back into the Generator |
| Voice | ElevenLabs (Instant Voice Cloning) | Speaks the chosen candidate in the user's cloned voice, with per-emotion settings |

Four decision-making AI agents — Listener, Tiles, Suggester, Generator — coordinate over a Redis memory layer, with ElevenLabs as the voice output.

### Key engineering details:

* **TTS pre-warming** — the moment the Generator returns candidates, all audio is fetched in parallel so tap-to-speech feels near-instant.
* **AudioWorklet-level mic gating** — audio is dropped at the worklet when it isn't the partner's turn, preventing the app from transcribing its own spoken output (echo) or polluting memory with room noise.
* **13 hand-tuned emotion profiles** — the hard part isn't cloning a voice, it's making a cloned voice feel. The Generator picks an emotion label; the backend maps it to locked, hand-tuned ElevenLabs voice settings (stability floored at 0.35 to avoid warbling).
* **Turn-taking state machine** plus Deepgram KeepAlive so the connection survives long conversational pauses.
* **Four accessibility profiles** — autistic, ALS, aphasia, cerebral palsy — each transforming the UI (picture+word tiles, voice banking, dwell-click), all overridable in Settings.

## Tech stack

* **Frontend:** React + Vite + Tailwind + framer-motion · Web Audio API
* **Backend:** FastAPI + WebSockets (Python)
* **Speech-to-text:** Deepgram (streaming)
* **Reasoning:** Claude Haiku
* **Memory:** Redis
* **Voice:** ElevenLabs (Instant Voice Cloning, turbo_v2_5)

## Running locally

You'll need API keys for Deepgram, Anthropic, ElevenLabs, and a Redis URL.

### 1. Backend

```bash
cd backend
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Create `backend/.env` with your keys:

```
DEEPGRAM_API_KEY=your_key
ANTHROPIC_API_KEY=your_key
ELEVENLABS_API_KEY=your_key
REDIS_URL=your_redis_url
```

Then run:

```bash
python main.py
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`, click Connect, grant microphone access, and start a conversation.

> **No mic handy?** Use the Simulate panel to feed a partner phrase as text and test the full pipeline without audio.

## Links

* Demo and full writeup: Devpost

## Note

This is a working prototype built at a hackathon — not a medical device. For any clinical use, consult a speech-language pathologist. Voices are cloned with consent and stored privately per session.

Built with Deepgram, Claude, ElevenLabs, and Redis.
