"""
Cadence backend — Step 1: Live Listening Proof

Flow:
  browser mic (PCM16) → WebSocket → here → Deepgram raw WS → transcripts → back to browser

Using the raw Deepgram WebSocket API rather than their SDK so we know exactly what
we're calling. Verify current params at:
https://developers.deepgram.com/reference/streaming
"""

import asyncio
import json
import logging
import os
from collections import deque

import uvicorn
import websockets as ws_lib
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

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


class RollingBuffer:
    """Keeps the last 3 finalized partner utterances for the Generator (Step 2+)."""
    def __init__(self, max_turns: int = 3):
        self.turns: deque[str] = deque(maxlen=max_turns)
        self.interim: str = ""

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


@app.get("/health")
async def health():
    return {"status": "ok", "deepgram_key_set": bool(DEEPGRAM_API_KEY)}


@app.websocket("/ws/listen")
async def ws_listen(browser_ws: WebSocket):
    await browser_ws.accept()
    buf = RollingBuffer()

    await browser_ws.send_text(json.dumps({
        "type": "connected",
        "message": "WebSocket open. Waiting for init message.",
    }))

    # -- Step 1: receive init message (contains browser sample_rate) ---------
    sample_rate = 16000
    try:
        raw = await asyncio.wait_for(browser_ws.receive_text(), timeout=10.0)
        msg = json.loads(raw)
        if msg.get("type") == "init":
            sample_rate = int(msg.get("sample_rate", 16000))
            log.info(f"Browser sample_rate={sample_rate}")
    except asyncio.TimeoutError:
        log.warning("No init received in 10s, using sample_rate=16000")
    except Exception as e:
        log.warning(f"init parse error: {e}")

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
        async with ws_lib.connect(url, additional_headers=headers) as dg_ws:
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
                except WebSocketDisconnect:
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

            # Run all three; when the first exits, cancel the rest
            tasks = [
                asyncio.create_task(from_browser()),
                asyncio.create_task(to_deepgram()),
                asyncio.create_task(from_deepgram()),
            ]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

    except Exception as e:
        err = str(e)
        # Common case: bad API key → Deepgram returns 401
        if "401" in err or "403" in err or "InvalidStatus" in type(e).__name__:
            err = "Deepgram rejected the key (401/403). Check DEEPGRAM_API_KEY in backend/.env."
        log.error(f"Deepgram setup error: {e}")
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
        # Standing Rule #5: fake-input test path — feeds text as if it were heard
        text = data.get("text", "").strip()
        if text:
            buf.push(text)
            await browser_ws.send_text(json.dumps({
                "type": "transcript",
                "text": text,
                "is_final": True,
                "simulated": True,
                "buffer": buf.to_dict(),
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
