"""
Cadence backend — Step 2: Fusion Engine (Generator)

Flow:
  browser mic (PCM16) → WebSocket → here → Deepgram raw WS → transcripts → back to browser
  browser taps → here → Claude (context + taps) → 3 candidate sentences → back to browser

The Generator is the core of Cadence: same taps + different heard context = different candidates.
"""

import asyncio
import json
import logging
import os
from collections import deque

import time
from typing import Optional

import anthropic
import httpx
import redis.asyncio as redis_async
import uvicorn
import websockets as ws_lib
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")
log = logging.getLogger("cadence")

app = FastAPI(title="Cadence")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "")
DEEPGRAM_BASE = "wss://api.deepgram.com/v1/listen"

# NOTE: verify these query params at https://developers.deepgram.com/reference/streaming
# if behaviour seems wrong after a Deepgram API update.
DEEPGRAM_PARAMS = (
    "model=nova-2"
    "&language=en-US"
    "&encoding=linear16"
    "&channels=1"
    "&interim_results=true"
    "&endpointing=500"       # ms of silence to finalize a turn
    "&utterance_end_ms=1000" # fire UtteranceEnd event after this much extra silence
)

# -- Anthropic (Claude) for the Generator ------------------------------------
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
# Using claude-3-5-haiku for speed (latency-critical path)
CLAUDE_MODEL = "claude-haiku-4-5"

# Create async client (lazy — won't fail if key is missing until actually called)
anthropic_client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY) if ANTHROPIC_API_KEY else None

# -- ElevenLabs (TTS) — Step 3 ---------------------------------------------------
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
# Default demo voice: "Rachel" — clear, natural-sounding English. Replace with cloned voice later.
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
# Flash v2.5 = lowest-latency model (~75ms). Use eleven_turbo_v2_5 or _multilingual for quality.
ELEVENLABS_MODEL = "eleven_turbo_v2_5"  # better expression than flash; still fast

# Default neutral voice settings — Emotion layer overrides these per-sentence
DEFAULT_VOICE_SETTINGS = {
    "stability": 0.5,
    "similarity_boost": 0.8,
    "style": 0.3,
    "use_speaker_boost": True,
    "speed": 0.92,  # slightly slower than 1.0 = more natural, less rushed
}

# Hand-tuned per-emotion settings for a CLONED voice. Cloned voices need higher
# stability + similarity_boost than stock voices, or they warble. style stays
# moderate so emotion comes through without sounding over-acted.
#   stability ↓ = more variation in pitch/rhythm (more expressive)
#   similarity_boost ↑ = stay closer to the cloned voice identity
#   style ↑ = lean harder into the speaker's stylistic quirks
EMOTION_PROFILES = {
    "neutral":     {"stability": 0.55, "similarity_boost": 0.80, "style": 0.25, "speed": 0.92},
    "warm":        {"stability": 0.45, "similarity_boost": 0.80, "style": 0.40, "speed": 0.92},
    "happy":       {"stability": 0.40, "similarity_boost": 0.80, "style": 0.50, "speed": 0.95},
    "excited":     {"stability": 0.35, "similarity_boost": 0.80, "style": 0.55, "speed": 0.98},
    "playful":     {"stability": 0.40, "similarity_boost": 0.80, "style": 0.50, "speed": 0.95},
    "thoughtful":  {"stability": 0.60, "similarity_boost": 0.80, "style": 0.30, "speed": 0.88},
    "tender":      {"stability": 0.55, "similarity_boost": 0.82, "style": 0.40, "speed": 0.88},
    "tired":       {"stability": 0.65, "similarity_boost": 0.82, "style": 0.30, "speed": 0.85},
    "sad":         {"stability": 0.55, "similarity_boost": 0.82, "style": 0.45, "speed": 0.86},
    "anxious":     {"stability": 0.40, "similarity_boost": 0.80, "style": 0.45, "speed": 0.94},
    "frustrated":  {"stability": 0.55, "similarity_boost": 0.85, "style": 0.35, "speed": 0.88},
    "firm":        {"stability": 0.60, "similarity_boost": 0.85, "style": 0.28, "speed": 0.87},
    "apologetic":  {"stability": 0.55, "similarity_boost": 0.82, "style": 0.40, "speed": 0.88},
}

# -- Memory agent (Redis) --------------------------------------------------------
REDIS_URL = os.getenv("REDIS_URL", "")
redis_client: Optional[redis_async.Redis] = None
if REDIS_URL:
    try:
        redis_client = redis_async.from_url(REDIS_URL, decode_responses=True)
    except Exception as e:
        log.error(f"Redis init failed: {e}")
        redis_client = None


class MemoryAgent:
    """
    Stores conversation history per session in Redis.
    Each session has a list of turns: {role: 'partner'|'user', text, ts}.
    The Generator queries recent history to ground candidates further.
    """
    def __init__(self, client: Optional[redis_async.Redis]):
        self.client = client

    def _key(self, session_id: str) -> str:
        return f"cadence:session:{session_id}:turns"

    async def save_turn(self, session_id: str, role: str, text: str):
        if not self.client or not session_id or not text.strip():
            return
        entry = json.dumps({"role": role, "text": text.strip(), "ts": int(time.time())})
        try:
            await self.client.rpush(self._key(session_id), entry)
            await self.client.expire(self._key(session_id), 60 * 60 * 24)  # 24h TTL
        except Exception as e:
            log.warning(f"Memory save failed: {e}")

    async def get_history(self, session_id: str, limit: int = 20) -> list[dict]:
        if not self.client or not session_id:
            return []
        try:
            raw = await self.client.lrange(self._key(session_id), -limit, -1)
            return [json.loads(r) for r in raw]
        except Exception as e:
            log.warning(f"Memory get failed: {e}")
            return []

    async def clear(self, session_id: str):
        if not self.client or not session_id:
            return
        try:
            await self.client.delete(self._key(session_id))
        except Exception as e:
            log.warning(f"Memory clear failed: {e}")


memory = MemoryAgent(redis_client)


class VocabStore:
    """
    Per-user vocabulary persistence (Redis-backed):
    - pinned: words/phrases the user always wants visible (e.g. family names, go-to needs)
    - recents: last-N custom tiles they've typed, for one-tap re-add
    """
    PINNED_MAX = 8
    RECENT_MAX = 12

    def __init__(self, client: Optional[redis_async.Redis]):
        self.client = client

    def _pk(self, sid: str) -> str:  return f"cadence:session:{sid}:pinned"
    def _rk(self, sid: str) -> str:  return f"cadence:session:{sid}:recents"

    async def get(self, sid: str) -> dict:
        if not self.client or not sid:
            return {"pinned": [], "recents": []}
        try:
            pinned = await self.client.lrange(self._pk(sid), 0, -1)
            recents = await self.client.lrange(self._rk(sid), 0, -1)
            return {"pinned": pinned, "recents": recents}
        except Exception as e:
            log.warning(f"VocabStore.get failed: {e}")
            return {"pinned": [], "recents": []}

    async def add_recent(self, sid: str, word: str):
        if not self.client or not sid or not word.strip(): return
        word = word.strip().lower()
        try:
            await self.client.lrem(self._rk(sid), 0, word)  # dedupe
            await self.client.lpush(self._rk(sid), word)
            await self.client.ltrim(self._rk(sid), 0, self.RECENT_MAX - 1)
        except Exception as e:
            log.warning(f"VocabStore.add_recent failed: {e}")

    async def toggle_pin(self, sid: str, word: str) -> list[str]:
        if not self.client or not sid or not word.strip(): return []
        word = word.strip().lower()
        try:
            existing = await self.client.lrange(self._pk(sid), 0, -1)
            if word in existing:
                await self.client.lrem(self._pk(sid), 0, word)
            else:
                await self.client.rpush(self._pk(sid), word)
                await self.client.ltrim(self._pk(sid), 0, self.PINNED_MAX - 1)
            return await self.client.lrange(self._pk(sid), 0, -1)
        except Exception as e:
            log.warning(f"VocabStore.toggle_pin failed: {e}")
            return []


vocab = VocabStore(redis_client)


class VoiceStore:
    """Per-session voice_id mapping. When a user records their own voice via
    Instant Voice Cloning, we store the ElevenLabs voice_id here and use it
    for that user's TTS instead of the default."""

    def __init__(self, client: Optional[redis_async.Redis]):
        self.client = client

    def _key(self, sid: str) -> str: return f"cadence:session:{sid}:voice"

    async def get(self, sid: str) -> Optional[str]:
        if not self.client or not sid: return None
        try:
            return await self.client.get(self._key(sid))
        except Exception as e:
            log.warning(f"VoiceStore.get failed: {e}")
            return None

    async def set(self, sid: str, voice_id: str):
        if not self.client or not sid: return
        try:
            await self.client.set(self._key(sid), voice_id)
        except Exception as e:
            log.warning(f"VoiceStore.set failed: {e}")

    async def clear(self, sid: str):
        if not self.client or not sid: return
        try:
            await self.client.delete(self._key(sid))
        except Exception as e:
            log.warning(f"VoiceStore.clear failed: {e}")


voice_store = VoiceStore(redis_client)


async def elevenlabs_clone_voice(file_bytes: bytes, filename: str, voice_name: str) -> dict:
    """
    POST audio to ElevenLabs Instant Voice Cloning. Returns {"voice_id": "..."} on
    success or {"error": "..."} on failure. Needs >= 30s of clean speech.
    """
    if not ELEVENLABS_API_KEY:
        return {"error": "No ELEVENLABS_API_KEY set in backend/.env"}
    url = "https://api.elevenlabs.io/v1/voices/add"
    headers = {"xi-api-key": ELEVENLABS_API_KEY}
    files = {"files": (filename, file_bytes, "audio/webm")}
    data = {"name": voice_name, "description": f"Cadence cloned voice for {voice_name}"}
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(url, headers=headers, files=files, data=data)
        if resp.status_code != 200:
            return {"error": f"ElevenLabs {resp.status_code}: {resp.text[:300]}"}
        body = resp.json()
        vid = body.get("voice_id")
        if not vid:
            return {"error": f"No voice_id in response: {body}"}
        return {"voice_id": vid}
    except Exception as e:
        log.error(f"clone failed: {e}")
        return {"error": str(e)[:300]}


# =============================================================================
# TILES AGENT — Claude reads the room and picks contextually relevant tiles.
# =============================================================================

# Fallback when no context yet — common AAC core vocabulary
FALLBACK_TILES = [
    "yes", "no", "thank you", "please",
    "I don't know", "maybe", "later", "help",
    "tired", "happy", "okay", "more",
]


async def generate_tiles(context: str, session_id: str = "", n: int = 12) -> list[str]:
    """
    Returns up to n concept tiles (mix of single words + short phrases) that are
    the most likely useful responses to the current heard context. Picked by
    Claude reading the conversation, not a fixed list.
    """
    if not anthropic_client or not context.strip():
        return FALLBACK_TILES[:n]

    history = await memory.get_history(session_id, limit=8) if session_id else []
    history_block = _format_history(history)

    prompt = f"""You are the Tiles agent for Cadence, an AAC tool for a non-speaking user.

Look at what the conversation partner just said + recent history. Predict the {n} most likely \
concept tiles the user would want to TAP to start composing their reply. Mix:
- short single words (yes, no, hungry, tired, later)
- short concept phrases (not really, with you, feeling better, in a bit)

RULES:
- Tiles must be RELEVANT to the partner's question/statement — what would a thoughtful person \
likely want to respond?
- Each tile <= 3 words. Lowercase. Natural conversational language.
- Cover a range of possible responses (positive, negative, qualified, ask-back).
- Always include 1-2 core acknowledgements (yes/no/maybe/okay) tuned to this context.
- No duplicates. No punctuation.

## History:
{history_block}

## Partner just said:
"{context}"

Return ONLY JSON: {{"tiles": ["yes", "not really", "later", ...]}}"""

    try:
        response = await anthropic_client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=250,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text.strip()
        start, end = raw.find("{"), raw.rfind("}")
        if start != -1 and end != -1:
            raw = raw[start:end + 1]
        result = json.loads(raw)
        tiles = [t.strip().lower() for t in result.get("tiles", []) if isinstance(t, str) and t.strip()]
        # Dedupe, preserve order
        seen = set()
        out = []
        for t in tiles:
            if t not in seen:
                seen.add(t)
                out.append(t)
        return out[:n] or FALLBACK_TILES[:n]
    except Exception as e:
        log.error(f"Tiles agent error: {e}")
        return FALLBACK_TILES[:n]


class RollingBuffer:
    """Keeps the last 6 finalized partner utterances for the Generator —
    enough context for a real conversation, not just a single back-and-forth."""
    def __init__(self, max_turns: int = 6):
        self.turns: deque[str] = deque(maxlen=max_turns)
        self.interim: str = ""
        self.session_id: str = ""

    def set_interim(self, text: str):
        self.interim = text

    def push(self, text: str):
        if text.strip():
            self.turns.append(text.strip())
        self.interim = ""

    def context(self) -> str:
        return " | ".join(self.turns)

    def to_dict(self) -> dict:
        return {
            "turns": list(self.turns),
            "interim": self.interim,
            "context": self.context(),
        }


# =============================================================================
# STEP 2: FUSION ENGINE — the core of Cadence
# =============================================================================

FUSION_PROMPT = """\
You are the language engine for Cadence, an AAC tool. The user CANNOT speak. Someone just said \
something to them (heard context), and they tapped concept tiles. Generate {n} natural, \
first-person candidate replies AND choose how each one should SOUND emotionally — because the \
voice is their cloned voice and flat delivery makes it feel robotic.

## RULES:
1. Ground every candidate in the heard context. Same taps + different context = different replies.
2. Sound like a real person mid-conversation, NOT an AI. Use contractions ("I'm", "don't", "yeah"). \
Use natural fillers when fitting ("oh", "hmm", "well", "honestly"). Vary sentence length. Avoid \
formal phrasing like "I would like to" — say "I'd love to" or "yeah, let's".
3. First-person, 4-14 words. Conversational, not stilted.
4. Vary the 3 candidates in tone — e.g. one warm, one direct, one playful — so the user has real choice.
5. Use the history for continuity (don't repeat phrasing the user just used).
{extra_rules}

## EMOTION (per candidate):
Pick the SINGLE emotion that best matches how the user would actually deliver this line, given the \
context. Don't default to "neutral" — choose the real feeling. Allowed labels (use these EXACT \
strings, lowercase):
neutral, warm, happy, excited, playful, thoughtful, tender, tired, sad, anxious, frustrated, \
firm, apologetic

## Conversation history:
{history}

## Heard context:
{context}

## Concept tiles tapped:
{taps}

Return ONLY this JSON (no markdown, no preamble):
{{"candidates": [{{"text": "...", "emotion": "warm"}}, ...]}}
Exactly {n} candidates."""


def _clamp(v, lo, hi):
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return None


def _settings_for_emotion(emotion: str) -> dict:
    profile = EMOTION_PROFILES.get(emotion, EMOTION_PROFILES["neutral"])
    return {**DEFAULT_VOICE_SETTINGS, **profile}


def _normalize_candidate(c) -> dict:
    """
    Ensure each candidate has {text, emotion, settings}. The Generator only picks
    the EMOTION LABEL — we look up hand-tuned settings to keep delivery natural
    on a cloned voice (Claude's raw numbers can warble or over-act).
    """
    if isinstance(c, str):
        return {"text": c, "emotion": "neutral", "settings": _settings_for_emotion("neutral")}
    text = (c.get("text") or "").strip()
    emotion = (c.get("emotion") or "neutral").strip().lower()
    if emotion not in EMOTION_PROFILES:
        emotion = "neutral"
    return {"text": text, "emotion": emotion, "settings": _settings_for_emotion(emotion)}


def _format_history(turns: list[dict]) -> str:
    if not turns:
        return "(no prior turns)"
    lines = []
    for t in turns[-10:]:
        who = "Partner" if t.get("role") == "partner" else "User said"
        lines.append(f"- {who}: \"{t.get('text', '')}\"")
    return "\n".join(lines)


async def generate_candidates(taps: list[str], context: str, session_id: str = "",
                              n: int = 3, variety: str = "") -> dict:
    """
    Call Claude with the fusion prompt to generate 3 context-grounded candidates.
    Returns {"candidates": [...]} or {"error": "..."}.
    """
    if not anthropic_client:
        return {"error": "No ANTHROPIC_API_KEY set in backend/.env. Add your key and restart."}

    if not taps:
        return {"error": "No concept tiles selected. Tap at least one tile first."}

    # Memory recall — pull recent history for this session
    history = await memory.get_history(session_id, limit=10) if session_id else []

    extra_rules = ""
    if variety:
        extra_rules = f"7. {variety}"

    prompt = FUSION_PROMPT.format(
        n=n,
        history=_format_history(history),
        context=context if context else "(no conversation heard yet)",
        taps=", ".join(taps),
        extra_rules=extra_rules,
    )

    try:
        log.info(f"Generator: taps={taps}, context='{context[:80]}...' → calling Claude")

        response = await anthropic_client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )

        raw_text = response.content[0].text.strip()
        log.info(f"Generator: Claude returned: {raw_text[:200]}")

        # Strip markdown code fences if present, then extract first JSON object
        cleaned = raw_text
        if cleaned.startswith("```"):
            cleaned = cleaned.split("```", 2)[1]
            if cleaned.startswith("json"):
                cleaned = cleaned[4:]
            cleaned = cleaned.strip().rstrip("`").strip()
        # Fallback: find the first { ... } block
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1:
            cleaned = cleaned[start:end + 1]

        result = json.loads(cleaned)

        if "candidates" not in result or not isinstance(result["candidates"], list):
            return {"error": f"Claude returned unexpected shape: {raw_text[:200]}"}

        candidates = [_normalize_candidate(c) for c in result["candidates"][:n]]
        return {"candidates": candidates}

    except json.JSONDecodeError:
        log.error(f"Generator: Claude returned non-JSON: {raw_text[:300]}")
        return {"error": "Claude returned non-JSON. Retrying may help."}
    except anthropic.APIError as e:
        log.error(f"Generator: Anthropic API error: {e}")
        return {"error": f"Anthropic API error: {str(e)[:200]}"}
    except Exception as e:
        log.error(f"Generator: unexpected error: {type(e).__name__} - {e}")
        return {"error": f"Generator error: {str(e)[:200]}"}


# =============================================================================
# STEP 3: VOICE — ElevenLabs streaming TTS
# =============================================================================

@app.post("/generate")
async def generate_http(request: Request):
    """Generator agent — context + taps + memory → candidates."""
    body = await request.json()
    taps = body.get("taps", [])
    context = (body.get("context") or "").strip()
    session_id = (body.get("session_id") or "").strip()
    n = int(body.get("n") or 3)
    variety = (body.get("variety") or "").strip()
    result = await generate_candidates(taps, context, session_id, n=n, variety=variety)
    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])
    return result


@app.post("/pick")
async def pick_http(request: Request):
    """Record the user's chosen candidate into Memory."""
    body = await request.json()
    session_id = (body.get("session_id") or "").strip()
    text = (body.get("text") or "").strip()
    if not session_id or not text:
        raise HTTPException(status_code=400, detail="session_id and text required")
    await memory.save_turn(session_id, "user", text)
    return {"ok": True}


@app.get("/history/{session_id}")
async def history_http(session_id: str):
    """Fetch the chat log for a session — bumped to 200 so long conversations
    stay visible in the UI rather than rolling off after a few exchanges."""
    return {"turns": await memory.get_history(session_id, limit=200)}


@app.post("/clear/{session_id}")
async def clear_http(session_id: str):
    await memory.clear(session_id)
    return {"ok": True}


@app.post("/voice/clone/{session_id}")
async def voice_clone(session_id: str,
                       file: UploadFile = File(...),
                       name: str = Form("My voice")):
    """
    Upload a recorded voice sample to ElevenLabs Instant Voice Cloning.
    Returns {voice_id} on success. The voice is then stored as this session's
    default and used automatically by /tts.
    """
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id required")
    audio_bytes = await file.read()
    if len(audio_bytes) < 30_000:  # ~3 seconds at low bitrates — too short to clone
        raise HTTPException(status_code=400,
                            detail="Recording too short. Please record at least 30 seconds.")
    log.info(f"Voice clone: session={session_id} bytes={len(audio_bytes)} name={name!r}")
    result = await elevenlabs_clone_voice(audio_bytes, file.filename or "voice.webm", name)
    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])
    await voice_store.set(session_id, result["voice_id"])
    return {"voice_id": result["voice_id"]}


@app.get("/voice/{session_id}")
async def voice_get(session_id: str):
    vid = await voice_store.get(session_id)
    return {"voice_id": vid, "has_custom": bool(vid)}


@app.delete("/voice/{session_id}")
async def voice_delete(session_id: str):
    await voice_store.clear(session_id)
    return {"ok": True}


@app.post("/tiles")
async def tiles_http(request: Request):
    """Contextual tiles agent — heard context → list of relevant concept tiles."""
    body = await request.json()
    context = (body.get("context") or "").strip()
    session_id = (body.get("session_id") or "").strip()
    n = int(body.get("n") or 12)
    tiles = await generate_tiles(context, session_id, n=n)
    return {"tiles": tiles}


@app.get("/vocab/{session_id}")
async def vocab_get(session_id: str):
    return await vocab.get(session_id)


@app.post("/vocab/{session_id}/recent")
async def vocab_add_recent(session_id: str, request: Request):
    body = await request.json()
    word = (body.get("word") or "").strip()
    if not word:
        raise HTTPException(status_code=400, detail="word required")
    await vocab.add_recent(session_id, word)
    return await vocab.get(session_id)


@app.post("/vocab/{session_id}/pin")
async def vocab_toggle_pin(session_id: str, request: Request):
    body = await request.json()
    word = (body.get("word") or "").strip()
    if not word:
        raise HTTPException(status_code=400, detail="word required")
    pinned = await vocab.toggle_pin(session_id, word)
    return {"pinned": pinned}


@app.post("/suggest")
async def suggest_http(request: Request):
    """
    Suggester agent — when the partner finishes a turn, proactively suggest
    2 likely replies the user might want to say, WITHOUT tile taps.
    """
    body = await request.json()
    context = (body.get("context") or "").strip()
    session_id = (body.get("session_id") or "").strip()
    if not context:
        return {"suggestions": []}
    if not anthropic_client:
        raise HTTPException(status_code=500, detail="No ANTHROPIC_API_KEY set")

    history = await memory.get_history(session_id, limit=8) if session_id else []
    history_block = _format_history(history)

    prompt = f"""You are the Suggester agent for Cadence, an AAC tool for a non-speaking user.
The conversation partner just said something. Without any tile taps, predict 2 very likely \
short first-person replies — concrete, conversational, varied, with contractions and natural \
fillers so it sounds like a real person, not an AI.

For each, also pick the SINGLE emotion that best matches how the user would deliver it. Allowed \
labels (lowercase, exact): neutral, warm, happy, excited, playful, thoughtful, tender, tired, sad, \
anxious, frustrated, firm, apologetic. Don't default to neutral — pick the real feeling.

## Conversation history:
{history_block}

## Partner just said:
"{context}"

Return ONLY JSON:
{{"suggestions": [{{"text": "...", "emotion": "warm"}}, {{"text": "...", "emotion": "playful"}}]}}"""

    try:
        response = await anthropic_client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=400,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text.strip()
        start, end = raw.find("{"), raw.rfind("}")
        if start != -1 and end != -1:
            raw = raw[start:end + 1]
        result = json.loads(raw)
        sugg = [_normalize_candidate(s) for s in result.get("suggestions", [])[:2]]
        return {"suggestions": sugg}
    except Exception as e:
        log.error(f"Suggester error: {e}")
        return {"suggestions": []}


@app.get("/tts")
async def tts(
    text: str = "",
    stability: Optional[float] = None,
    similarity_boost: Optional[float] = None,
    style: Optional[float] = None,
    speed: Optional[float] = None,
    emotion: str = "",
    session_id: str = "",
):
    """
    Stream MP3 audio from ElevenLabs. GET so <audio src=...> can stream natively (lowest latency).
    voice_settings come from the Emotion layer per-sentence — fall back to DEFAULT_VOICE_SETTINGS.
    """
    if not ELEVENLABS_API_KEY:
        raise HTTPException(status_code=500,
                            detail="No ELEVENLABS_API_KEY set. Add it to backend/.env.")
    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="No text provided")

    voice_settings = dict(DEFAULT_VOICE_SETTINGS)
    for k, v, lo, hi in (
        ("stability", stability, 0.0, 1.0),
        ("similarity_boost", similarity_boost, 0.0, 1.0),
        ("style", style, 0.0, 1.0),
        ("speed", speed, 0.7, 1.2),
    ):
        cv = _clamp(v, lo, hi)
        if cv is not None:
            voice_settings[k] = cv

    # optimize_streaming_latency=2 is the sweet spot: still fast first byte but
    # MUCH more natural prosody than 3-4. Higher values rush words together.
    # Prefer the user's own cloned voice (per session) over the env default
    voice_id = ELEVENLABS_VOICE_ID
    if session_id:
        per_session = await voice_store.get(session_id)
        if per_session:
            voice_id = per_session

    url = (f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream"
           "?output_format=mp3_44100_64&optimize_streaming_latency=2")
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    payload = {
        "text": text,
        "model_id": ELEVENLABS_MODEL,
        "voice_settings": voice_settings,
    }

    log.info(f"TTS: '{text[:60]}' emotion={emotion or 'n/a'} settings={voice_settings}")

    async def audio_iter():
        # NEW client per request — keeps lifecycle bound to the response stream
        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("POST", url, headers=headers, json=payload) as resp:
                if resp.status_code != 200:
                    err = await resp.aread()
                    log.error(f"ElevenLabs error {resp.status_code}: {err[:300]}")
                    raise HTTPException(status_code=resp.status_code,
                                        detail=f"ElevenLabs: {err[:200].decode(errors='ignore')}")
                async for chunk in resp.aiter_bytes():
                    yield chunk

    return StreamingResponse(audio_iter(), media_type="audio/mpeg")


# =============================================================================
# WebSocket endpoint
# =============================================================================

@app.get("/health")
async def health():
    """Surface every external dependency at once. Demo-critical because
    Redis-backed features (Memory, Vocab, Voice) fail silently without it."""
    redis_status = "not_configured"
    if redis_client:
        try:
            await redis_client.ping()
            redis_status = "connected"
        except Exception as e:
            redis_status = f"error: {str(e)[:80]}"
    return {
        "status": "ok",
        "deepgram_key_set": bool(DEEPGRAM_API_KEY),
        "anthropic_key_set": bool(ANTHROPIC_API_KEY),
        "elevenlabs_key_set": bool(ELEVENLABS_API_KEY),
        "redis": redis_status,
        "persistence_features": {
            "memory": redis_status == "connected",
            "vocab": redis_status == "connected",
            "voice_clone_session": redis_status == "connected",
        },
    }


@app.websocket("/ws/listen")
async def ws_listen(browser_ws: WebSocket):
    await browser_ws.accept()
    buf = RollingBuffer()

    await browser_ws.send_text(json.dumps({
        "type": "connected",
        "message": "WebSocket open. Waiting for init message.",
    }))

    # -- Step 1: receive init message (sample_rate + session_id) -------------
    sample_rate = 16000
    session_id = ""
    try:
        raw = await asyncio.wait_for(browser_ws.receive_text(), timeout=10.0)
        msg = json.loads(raw)
        if msg.get("type") == "init":
            sample_rate = int(msg.get("sample_rate", 16000))
            session_id = (msg.get("session_id") or "").strip()
            log.info(f"Browser sample_rate={sample_rate}, session_id={session_id}")
    except asyncio.TimeoutError:
        log.warning("No init received in 10s, using sample_rate=16000")
    except Exception as e:
        log.warning(f"init parse error: {e}")
    buf.session_id = session_id

    # -- No key: simulate-only mode ------------------------------------------
    if not DEEPGRAM_API_KEY:
        await browser_ws.send_text(json.dumps({
            "type": "ready",
            "message": "No DEEPGRAM_API_KEY — simulate-only mode. Add key to backend/.env.",
        }))
        await _simulate_only_loop(browser_ws, buf)
        return

    # -- Connect to Deepgram -------------------------------------------------
    url = f"{DEEPGRAM_BASE}?{DEEPGRAM_PARAMS}&sample_rate={sample_rate}"
    headers = {"Authorization": f"Token {DEEPGRAM_API_KEY}"}

    try:
        async with ws_lib.connect(url, extra_headers=headers) as dg_ws:
            await browser_ws.send_text(json.dumps({
                "type": "ready",
                "message": f"Deepgram connected (sample_rate={sample_rate})",
            }))
            log.info("Deepgram WS open")

            audio_queue: asyncio.Queue = asyncio.Queue()

            # -- Task A: receive from browser, route audio vs control ---------
            async def from_browser():
                try:
                    while True:
                        msg = await browser_ws.receive()
                        if "bytes" in msg and msg["bytes"]:
                            await audio_queue.put(msg["bytes"])
                        elif "text" in msg and msg["text"]:
                            await _handle_text(msg["text"], browser_ws, buf)
                except (WebSocketDisconnect, RuntimeError):
                    pass
                finally:
                    await audio_queue.put(None)  # tell forwarder to stop

            # -- Task B: forward audio bytes to Deepgram ---------------------
            async def to_deepgram():
                while True:
                    chunk = await audio_queue.get()
                    if chunk is None:
                        return
                    try:
                        await dg_ws.send(chunk)
                    except ws_lib.exceptions.ConnectionClosed:
                        return

            # -- Task C: receive transcripts from Deepgram -------------------
            async def from_deepgram():
                try:
                    async for raw in dg_ws:
                        if isinstance(raw, bytes):
                            continue
                        await _handle_deepgram_message(raw, browser_ws, buf)
                except ws_lib.exceptions.ConnectionClosed:
                    pass

            # -- Task D: KeepAlive ping so Deepgram doesn't drop us during
            # quiet stretches (e.g. while the user is in my_turn composing —
            # no audio flows for 30s+, and Deepgram closes idle WS after ~10s).
            # Without this, long conversations break: the mic flips back on but
            # the upstream is gone. Spec: send `{"type":"KeepAlive"}` as text.
            async def keepalive_dg():
                try:
                    while True:
                        await asyncio.sleep(5)
                        try:
                            await dg_ws.send(json.dumps({"type": "KeepAlive"}))
                        except ws_lib.exceptions.ConnectionClosed:
                            return
                except asyncio.CancelledError:
                    return

            # -- Task E: heartbeat ping to the browser too so any intermediate
            # proxy (Vite dev server, cloud load balancer) doesn't time out
            # the browser↔backend WS. Idle timeouts are typically 30-60s.
            async def heartbeat_browser():
                try:
                    while True:
                        await asyncio.sleep(20)
                        try:
                            await browser_ws.send_text(json.dumps({"type": "ping"}))
                        except Exception:
                            return
                except asyncio.CancelledError:
                    return

            tasks = [
                asyncio.create_task(from_browser()),
                asyncio.create_task(to_deepgram()),
                asyncio.create_task(from_deepgram()),
                asyncio.create_task(keepalive_dg()),
                asyncio.create_task(heartbeat_browser()),
            ]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

    except Exception as e:
        import traceback
        log.error(f"Deepgram setup error: {type(e).__name__} - {e}\n{traceback.format_exc()}")
        err = str(e)
        # Common case: bad API key → Deepgram returns 401
        if "401" in err or "403" in err or "InvalidStatus" in type(e).__name__:
            err = "Deepgram rejected the key (401/403). Check DEEPGRAM_API_KEY in backend/.env."
        try:
            await browser_ws.send_text(json.dumps({"type": "error", "message": err}))
        except Exception:
            pass


async def _handle_text(raw: str, browser_ws: WebSocket, buf: RollingBuffer):
    """Handle JSON control messages from the browser."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return

    if data.get("type") == "simulate_input":
        text = data.get("text", "").strip()
        if text:
            buf.push(text)
            if buf.session_id:
                asyncio.create_task(memory.save_turn(buf.session_id, "partner", text))
            await browser_ws.send_text(json.dumps({
                "type": "transcript",
                "text": text,
                "is_final": True,
                "simulated": True,
                "buffer": buf.to_dict(),
            }))

    elif data.get("type") == "generate":
        # STEP 2: Fusion Engine — generate candidate sentences from taps + context
        taps = data.get("taps", [])
        # Use the rolling buffer context (what was heard)
        context = buf.context()
        log.info(f"Generate request: taps={taps}, context='{context}'")

        result = await generate_candidates(taps, context)

        if "error" in result:
            await browser_ws.send_text(json.dumps({
                "type": "generate_error",
                "message": result["error"],
            }))
        else:
            await browser_ws.send_text(json.dumps({
                "type": "candidates",
                "candidates": result["candidates"],
                "taps": taps,
                "context": context,
            }))


async def _handle_deepgram_message(raw: str, browser_ws: WebSocket, buf: RollingBuffer):
    """
    Parse a Deepgram streaming response and forward transcript to the browser.

    NOTE: Deepgram response shape documented at:
    https://developers.deepgram.com/reference/streaming
    If the shape below stops matching, check the live docs.
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return

    msg_type = data.get("type", "")

    if msg_type == "Results":
        try:
            alt = data["channel"]["alternatives"][0]
            text = alt.get("transcript", "")
            is_final = data.get("is_final", False)
            speech_final = data.get("speech_final", False)

            if not text:
                return

            if is_final or speech_final:
                buf.push(text)
                if buf.session_id:
                    asyncio.create_task(memory.save_turn(buf.session_id, "partner", text))
            else:
                buf.set_interim(text)

            await browser_ws.send_text(json.dumps({
                "type": "transcript",
                "text": text,
                "is_final": is_final or speech_final,
                "buffer": buf.to_dict(),
            }))
        except (KeyError, IndexError) as e:
            log.warning(f"Unexpected Deepgram Results shape: {e} | raw: {raw[:300]}")

    elif msg_type == "UtteranceEnd":
        # Deepgram signals a long pause — commit any lingering interim as a turn
        if buf.interim:
            buf.push(buf.interim)

    elif msg_type == "Error":
        log.error(f"Deepgram error event: {data}")
        try:
            await browser_ws.send_text(json.dumps({
                "type": "error",
                "message": f"Deepgram error: {data.get('message', raw[:200])}",
            }))
        except Exception:
            pass

    # Ignore Metadata and SpeechStarted events


async def _simulate_only_loop(browser_ws: WebSocket, buf: RollingBuffer):
    """Fallback when no Deepgram key: only simulate_input works."""
    try:
        while True:
            msg = await browser_ws.receive()
            if "text" in msg and msg["text"]:
                await _handle_text(msg["text"], browser_ws, buf)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.error(f"simulate-only loop: {e}")


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
