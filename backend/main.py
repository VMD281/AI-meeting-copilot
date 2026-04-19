"""
Three endpoints:
  POST /transcribe  (Whisper Large V3)
  POST /suggestions (GPT-OSS 120B, JSON mode)
  POST /chat       (GPT-OSS 120B, SSE)
"""

from __future__ import annotations

import asyncio
import json
import logging
import tempfile
import os
from pathlib import Path
from typing import AsyncIterator, Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from groq import Groq, APIError, AuthenticationError, RateLimitError


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("twinmind")

TRANSCRIBE_MODEL = "whisper-large-v3"
LLM_MODEL = "openai/gpt-oss-120b"  

app = FastAPI(title="TwinMind Backend", version="1.0.0")


ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# Default prompts — frontend can override these via the Settings UI.

DEFAULT_SUGGESTIONS_PROMPT = """You are TwinMind, a real-time meeting copilot. You surface 3 suggestions that help the user sound smart, catch mistakes, and keep the conversation moving.

STEP 1 — Identify the conversation type from the recent transcript:
- ONE-SIDED (lecture, tutorial, monologue, presentation): one person is explaining/teaching, others are mostly listening.
- TWO-WAY DISCUSSION (interview, sales call, strategy meeting, brainstorm): people are exchanging ideas back and forth.
- DATA-HEAVY (financial review, metrics review, analysis): the conversation is anchored in specific numbers, claims, or decisions.

STEP 2 — Pick suggestion categories that fit the type:
- ONE-SIDED: lean heavily on QUESTION TO ASK (clarifying, scope, edge cases). At most one TALKING POINT (a comparable scenario). Rarely ANSWER. Almost never FACT-CHECK unless a clear error.
- TWO-WAY: full mix. Usually 1 QUESTION TO ASK, 1 TALKING POINT or ANSWER, and 1 of another type based on what's most useful.
- DATA-HEAVY: prioritize FACT-CHECK on numbers, QUESTION TO ASK that drills into missing data, and TALKING POINT that offers a comparable benchmark or case.

The 3 suggestions MUST be 3 different categories. (See STEP 4, category variety.)

STEP 3 — Categories defined:
- ANSWER: a direct, concrete answer to a question just asked in the transcript. Include a number, name, or specific fact.
- FACT-CHECK: flag a claim that is wrong, outdated, or imprecise. Only when you have high confidence. Include the correction.
- QUESTION TO ASK: a sharp question that moves the discussion forward, exposes an assumption, or gathers needed info. Prefix the preview with "Ask: " and quote the question.
- TALKING POINT: a specific, non-obvious observation, statistic, or comparable case the user can contribute. Not generic advice — something substantive with specifics.

STEP 4 — Rules for the `text` field (the card preview):
- Must be useful on its own, even if the user never clicks it.
- One sentence, max ~25 words.
- Include specifics: numbers, names, ratios, thresholds, named examples.
- Focus on the MOST RECENT part of the transcript — the last few turns.
- Avoid platitudes ("consider the risks," "align the team," "explore synergies").
- PREFIX CONVENTION: Only QUESTION TO ASK cards start with "Ask: " followed by the question. ANSWER, TALKING POINT, and FACT-CHECK cards start directly with the content — never prefix them with "Answer:", "Talking point:", or "Fact-check:". The category badge is shown separately in the UI.
- CATEGORY VARIETY: Across the 3 suggestions in a single batch, use 3 different categories. Do not return two of the same category in the same batch, even if multiple would fit.
SPECIAL CASE — Empty or very short transcript (< 50 words):
Return 3 generic openers appropriate for starting a meeting:
1. A conversational opener (QUESTION TO ASK or TALKING POINT — something to break the ice or set the frame).
2. A clarifying question about the meeting's goal or agenda.
3. A meta-question about format or expectations.

Output STRICT JSON, no prose, no markdown:
{
  "suggestions": [
    {"category": "...", "text": "..."},
    {"category": "...", "text": "..."},
    {"category": "...", "text": "..."}
  ]
}"""

DEFAULT_CHAT_PROMPT = """You are TwinMind, a meeting copilot answering the user's typed question in real time. They are in an active meeting and need to act on your answer in the next 30 seconds.

CONTEXT YOU HAVE:
- The full meeting transcript up to now (live and updating).
- The full prior conversation in this chat session — both typed questions you have answered and previously clicked suggestion cards with your expanded answers.

When the user's question is a follow-up to something you answered earlier in this session, build on that answer rather than repeating it. When it references "earlier" or "what she said" or "that point," use the transcript to locate the reference. Treat everything you have said so far as still true — don't contradict yourself across turns.

HARD FORMATTING CONSTRAINTS:
- 80-150 words. Stop when you hit 150. Only go longer if the question genuinely requires steps or a list, and even then stay under 200.
- PLAIN PROSE. No markdown headers, no **bold**, no tables. Short numbered lists (max 3 items) are okay only when the user literally asks for steps or a list.
- Lead with the answer in sentence 1. No throat-clearing, no "Great question", no "Based on the transcript...".

CONTENT RULES:
- Use specifics from the transcript: numbers, names, exact phrases the speaker used. If the user said "we missed Q4 by 12%," cite that number back when relevant.
- When referring back to the transcript, say "when you said X earlier" or "you mentioned Y" — make it feel grounded in what was actually discussed.
- If you are extrapolating beyond the transcript (general knowledge, industry norms), say so: "Typically..." or "In most cases..." rather than asserting as fact.
- If you genuinely don't know something or the transcript doesn't contain the needed info, say so in one sentence. Don't fabricate."""


DEFAULT_DETAIL_PROMPT = """You are TwinMind. The user just clicked a suggestion card from the live-suggestions panel and they are in an active meeting. Give them the expanded answer they can skim in 5-10 seconds and act on immediately.

CONTEXT YOU HAVE:
- The full meeting transcript up to now.
- The full prior chat in this session. If the user has already asked related questions or clicked related cards, connect your expansion to those — don't repeat what was already said. Assume they remember the earlier answer.

HARD FORMATTING CONSTRAINTS (these override any other instinct):
- 80-120 words total. Count them. Stop when you hit 120.
- PLAIN PROSE ONLY. No markdown headers (no #, no **bold**). No tables. No numbered lists. No section labels like "Why this matters" or "Next step".
- 2-3 short paragraphs separated by blank lines, OR one tight paragraph. That is the entire allowed structure.
- No preamble, no "Great question", no restating the card text back to the user.

CONTENT BY CATEGORY:
- FACT-CHECK: State the correction in sentence 1, with the correct number or fact. Sentence 2-3: why the difference matters in this meeting. Done.
- QUESTION TO ASK: Sentence 1: why to ask this now, given what was just said. Sentence 2-3: what different answers would imply and which direction the user should push.
- ANSWER: Sentence 1: the direct answer with specifics. Sentence 2-3: the reasoning, and one follow-up consideration the user should think about.
- TALKING POINT: Sentence 1-2: the substantive content with numbers/names/examples so the user can say it convincingly. Sentence 3 (optional): one caveat or related angle.

Ground everything in the actual transcript. If the user just said X, reference X. Never invent statistics or cite sources you are not confident about — say "roughly," "commonly," or "anecdotally" if you are extrapolating."""

# Context-window defaults (in characters of transcript). The frontend can
# override these per request. Transcript is trimmed to the last N chars.
DEFAULT_SUGGESTIONS_CONTEXT_CHARS = 4000   # ~last ~800 words
DEFAULT_DETAIL_CONTEXT_CHARS = 12000       # more context for deeper answers
DEFAULT_CHAT_CONTEXT_CHARS = 12000


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def _get_client(api_key: str) -> Groq:
    if not api_key or not api_key.strip():
        raise HTTPException(status_code=401, detail="Groq API key is required.")
    return Groq(api_key=api_key.strip())


def _trim_transcript(transcript: str, max_chars: int) -> str:
    """Keep the tail of the transcript — most-recent context is most relevant."""
    if len(transcript) <= max_chars:
        return transcript
    return "…" + transcript[-max_chars:]


def _translate_groq_error(exc: Exception) -> HTTPException:
    """Turn Groq exceptions into clean HTTP responses the frontend can display."""
    if isinstance(exc, AuthenticationError):
        return HTTPException(status_code=401, detail="Invalid Groq API key.")
    if isinstance(exc, RateLimitError):
        return HTTPException(status_code=429, detail="Groq rate limit hit. Try again shortly.")
    if isinstance(exc, APIError):
        return HTTPException(status_code=502, detail=f"Groq API error: {exc}")
    log.exception("Unexpected error")
    return HTTPException(status_code=500, detail=f"Server error: {exc}")


# --------------------------------------------------------------------------- #
# Health
# --------------------------------------------------------------------------- #

@app.get("/")
async def health():
    return {"status": "ok", "service": "twinmind-backend"}


# --------------------------------------------------------------------------- #
# /transcribe 
# --------------------------------------------------------------------------- #

@app.post("/transcribe")
async def transcribe(
    audio_file: UploadFile = File(...),
    api_key: str = Form(...),
):
    """
    Accept an audio chunk (webm/opus/mp3/wav/m4a), return the transcribed text.
    Stateless: the frontend accumulates the full transcript.
    """
    client = _get_client(api_key)

    # Preserve the original extension so Whisper can infer the codec.
    suffix = Path(audio_file.filename or "chunk.webm").suffix or ".webm"
    audio_bytes = await audio_file.read()

    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio file.")

    # Use a unique temp file so concurrent requests don't clobber each other.
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        # Groq SDK is sync; offload to a thread so we don't block the event loop.
        def _do_transcribe():
            with open(tmp_path, "rb") as f:
                return client.audio.transcriptions.create(
                    file=(os.path.basename(tmp_path), f.read()),
                    model=TRANSCRIBE_MODEL,
                    response_format="verbose_json",
                    timestamp_granularities=["segment"],
                )

        result = await asyncio.to_thread(_do_transcribe)
        text = (result.text or "").strip()
        segments = []
        for seg in (getattr(result, "segments", None) or []):
            segments.append({
                "start": getattr(seg, "start", 0) if not isinstance(seg, dict) else seg.get("start", 0),
                "end": getattr(seg, "end", 0) if not isinstance(seg, dict) else seg.get("end", 0),
                "text": (getattr(seg, "text", "") if not isinstance(seg, dict) else seg.get("text", "")).strip(),
            })
        return {"text": text, "segments": segments}
    except Exception as exc:
        raise _translate_groq_error(exc)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# /suggestions 
# --------------------------------------------------------------------------- #

class SuggestionsRequest(BaseModel):
    api_key: str
    transcript: str = ""
    system_prompt: Optional[str] = None  # user override from Settings
    context_chars: int = DEFAULT_SUGGESTIONS_CONTEXT_CHARS
    temperature: float = Field(0.6, ge=0.0, le=2.0)


@app.post("/suggestions")
async def suggestions(req: SuggestionsRequest):
    """
    Generate exactly 3 categorized suggestions from the recent transcript.
    Uses Groq's JSON mode for reliable parsing.
    """
    client = _get_client(req.api_key)
    system = (req.system_prompt or DEFAULT_SUGGESTIONS_PROMPT).strip()
    context = _trim_transcript(req.transcript, req.context_chars)

    user_msg = (
        "Recent transcript (most recent at the bottom):\n"
        "-------------------------------------------\n"
        f"{context if context else '(no transcript yet — generate 3 high-quality generic openers)'}\n"
        "-------------------------------------------\n\n"
        "Return the JSON object with exactly 3 suggestions."
    )

    def _do_call():
        return client.chat.completions.create(
            model=LLM_MODEL,
            temperature=req.temperature,
            response_format={"type": "json_object"},  # guarantees valid JSON
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_msg},
            ],
        )

    try:
        completion = await asyncio.to_thread(_do_call)
        raw = completion.choices[0].message.content or "{}"
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            log.warning("Model returned non-JSON despite json_object mode: %s", raw[:200])
            raise HTTPException(status_code=502, detail="Model returned invalid JSON.")

        cards = parsed.get("suggestions", [])
        if not isinstance(cards, list):
            cards = []
        valid_categories = {"ANSWER", "FACT-CHECK", "QUESTION TO ASK", "TALKING POINT"}
        clean = []
        for c in cards[:3]:
            # Defensive: model sometimes returns strings instead of dicts when prompts drift.
            if isinstance(c, str):
                text = c.strip()
                cat = "TALKING POINT"
            elif isinstance(c, dict):
                cat = (c.get("category") or "").strip().upper()
                if cat not in valid_categories:
                    cat = "TALKING POINT"
                text = (c.get("text") or "").strip()
            else:
                continue
            if text:
                clean.append({"category": cat, "text": text})

        if len(clean) < 3:
            raise HTTPException(status_code=502, detail="Model returned fewer than 3 suggestions.")

        return {"suggestions": clean}

    except HTTPException:
        raise
    except Exception as exc:
        raise _translate_groq_error(exc)


# --------------------------------------------------------------------------- #
# /chat 
# --------------------------------------------------------------------------- #

class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class ChatRequest(BaseModel):
    api_key: str
    message: str
    transcript: str = ""
    history: list[ChatMessage] = Field(default_factory=list)
    # "card" if the user clicked a suggestion, "user" if they typed.
    source: str = "user"
    card_category: Optional[str] = None  # only when source == "card"
    system_prompt: Optional[str] = None
    context_chars: int = DEFAULT_CHAT_CONTEXT_CHARS
    temperature: float = Field(0.5, ge=0.0, le=2.0)


@app.post("/chat")
async def chat(req: ChatRequest):
    """
    Streamed response. Frontend reads Server-Sent Events to render tokens as
    they arrive — this is what wins the 'time to first token' latency metric.
    """
    client = _get_client(req.api_key)

    # Pick prompt based on whether the question came from a card click.
    if req.source == "card":
        system = (req.system_prompt or DEFAULT_DETAIL_PROMPT).strip()
    else:
        system = (req.system_prompt or DEFAULT_CHAT_PROMPT).strip()

    context = _trim_transcript(req.transcript, req.context_chars)

    # Build the message list: system, then transcript context, then prior chat,
    # then the current user message.
    messages = [{"role": "system", "content": system}]
    if context:
        messages.append({
            "role": "system",
            "content": f"Full meeting transcript for context:\n---\n{context}\n---"
        })
    for m in req.history[-20:]:  # cap at 20 turns to keep context reasonable
        if m.role in ("user", "assistant") and m.content.strip():
            messages.append({"role": m.role, "content": m.content})

    # Frame the current message with the card category if applicable.
    if req.source == "card" and req.card_category:
        user_content = (
            f"The user clicked a suggestion card of category {req.card_category}:\n"
            f'"{req.message}"\n\n'
            "Expand this into a full detailed answer per your instructions."
        )
    else:
        user_content = req.message

    messages.append({"role": "user", "content": user_content})

    def _stream_iter() -> AsyncIterator[bytes]:
        """Bridge Groq's sync stream -> async generator of SSE frames."""
        return _groq_sse(client, messages, req.temperature)

    return StreamingResponse(_stream_iter(), media_type="text/event-stream")


async def _groq_sse(client: Groq, messages: list, temperature: float) -> AsyncIterator[bytes]:
    """
    Call Groq with stream=True on a worker thread, yield SSE-formatted frames.
    SSE format: each frame is `data: <json>\\n\\n`. Final frame is `data: [DONE]\\n\\n`.
    """
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def _producer():
        try:
            stream = client.chat.completions.create(
                model=LLM_MODEL,
                temperature=temperature,
                stream=True,
                messages=messages,
            )
            for chunk in stream:
                delta = chunk.choices[0].delta.content or ""
                if delta:
                    asyncio.run_coroutine_threadsafe(
                        queue.put(("token", delta)), loop
                    )
            asyncio.run_coroutine_threadsafe(queue.put(("done", None)), loop)
        except Exception as exc:
            asyncio.run_coroutine_threadsafe(queue.put(("error", str(exc))), loop)

    asyncio.create_task(asyncio.to_thread(_producer))

    while True:
        kind, payload = await queue.get()
        if kind == "token":
            yield f"data: {json.dumps({'delta': payload})}\n\n".encode("utf-8")
        elif kind == "error":
            yield f"data: {json.dumps({'error': payload})}\n\n".encode("utf-8")
            break
        elif kind == "done":
            yield b"data: [DONE]\n\n"
            break