# AI Live Suggestions Meeting Copilot

A real-time meeting assistant that listens to live audio, transcribes it, and surfaces 3 context-aware suggestions every ~30 seconds. Click a suggestion for an expanded answer, or ask follow-up questions in chat. All powered by Groq (Whisper Large V3 for transcription, GPT-OSS 120B for everything else).

**Live demo:** https://ai-meeting-copilot-peach.vercel.app/
**Backend:** https://your-ai-meeting-copilot.onrender.com

## Quick start (local)

You need Python 3.11+, Node 20+, and a free [Groq API key](https://console.groq.com).

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env              # optional, adjust ALLOWED_ORIGINS if needed
uvicorn main:app --reload
```

Backend runs on `http://localhost:8000`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on `http://localhost:5173`.

Open the frontend, click **⚙ Settings** in the top bar, paste your Groq API key, save, and click the mic to start recording.

## What it does

Three columns, following the prototype.

**Mic and transcript (left).** Captures audio in 30-second chunks via the browser's `MediaRecorder`. Each chunk is sent to the backend, transcribed with Whisper Large V3, and appended to a scrolling transcript. Uses Whisper's segment-level timestamps so each transcript line gets an accurate wall-clock time, not a bucketed one.

**Live suggestions (middle).** Every 30 seconds (or on manual reload), the accumulated transcript is sent to GPT-OSS 120B, which returns exactly 3 categorized suggestions: ANSWER, FACT-CHECK, QUESTION TO ASK, or TALKING POINT. New batches appear at the top. Older batches stay visible (faded) for comparison.

**Chat (right).** Clicking a suggestion card or typing a question opens a streaming response from the same model. Responses stream token-by-token via Server-Sent Events so the first token shows up fast. Card clicks use a different system prompt tuned for expanding a preview into something you can skim in 5-10 seconds. Typed questions use a conversational prompt that can build on earlier chat history and the transcript.

**Export.** The top-bar export button downloads the full session as JSON. Transcript with timestamps, every suggestion batch, and the full chat history with whether each user message was a typed question or a card click.

**Settings.** All three prompts and all three context window sizes are editable from the UI. Overrides persist in `localStorage`. The Groq API key lives there too, nothing is hardcoded, and nothing is sent anywhere except to Groq via the backend.

## Stack

| Layer         | Choice                               | Why                                                                                                                                                                   |
| ------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend      | React + Vite                         | Fast dev loop, minimal setup.                                                                                                                                         |
| Backend       | FastAPI                              | Native async, clean SSE streaming via `StreamingResponse`, ergonomic Pydantic validation.                                                                             |
| Transcription | Whisper Large V3 on Groq             | Assignment spec. Using `verbose_json` with `segment` granularity for per-segment timestamps, which Groq docs confirm adds no extra latency.                           |
| LLM           | GPT-OSS 120B on Groq                 | Assignment spec. JSON mode for suggestions (guarantees parseable output), streaming for chat.                                                                         |
| State         | React hooks + `localStorage`         | No database, no session state on the backend. The frontend owns transcript, chat history, and settings. The backend is stateless and trivially horizontally scalable. |
| Deploy        | Vercel (frontend) + Render (backend) | Both free. Render's free tier spins down after 15 min idle and cold-starts take ~30s                                                                                  |

## Prompt strategy

The assignment explicitly grades prompt quality, so each of the three prompts does a different job and is tuned differently.

### Suggestions prompt: context-aware category mixing

The naive approach is "give me 3 suggestions, one of each type." That produces thin, generic output because it ignores the shape of the conversation. A fact-check card in a tutorial lecture is pointless. A talking point in a rapid-fire Q&A is usually redundant.

What I actually want: different suggestion mixes for different scenarios. If I'm being lectured at, I really only need good clarifying questions, maybe a fact-check if something sounds wrong. If I'm in a two-way conversation or a sales call, I need the full mix: a question to ask, something smart to say, an answer to a question someone just tossed at me. If I'm in a business review with numbers flying around, I want fact-checks on the numbers, drill-down questions, and comparable-case talking points.

So the prompt forces the model to first identify the conversation type (ONE-SIDED, TWO-WAY, DATA-HEAVY) and then pick a category mix that fits. This step-by-step reasoning gave noticeably better suggestions on real test audio than a flat "return 3 varied suggestions" prompt. When I ran a audio - Microsoft Teams tutorial through it, the model correctly identified one-sided content and gave me mostly clarifying questions. When I ran another audio - Q4 revenue review through it, I got a fact-check on a math error (I said 12% but it was actually 12.5%), a drill-down question on close rate by deal size, and a talking point with actual pipeline math.

A few other things baked into this prompt:

- **JSON mode enforced.** Groq's `response_format={"type": "json_object"}` guarantees parseable output. No prose wrappers, no drift.
- **Anti-platitude rules.** Explicit blocklist of phrases like "consider the risks," "align the team," "explore synergies." Every card has to include numbers, names, or thresholds. Something specific.
- **Most-recent focus.** The model is told to focus on the last few turns, not what was said 10 minutes ago, unless it's unresolved.
- **"Ask:" prefix for questions.** Small UI convention that makes questions visually distinct from statements at a glance. Only QUESTION TO ASK cards get this prefix, and the model is explicitly told not to prefix the other three categories with their names (the category badge is already in the UI).
- **Category variety rule.** The model was sometimes returning two QUESTION TO ASK cards in the same batch. Added an explicit rule to force 3 different categories per batch unless context really won't support it.
- **Empty-transcript fallback.** If transcript is under 50 words, return 3 generic meeting openers instead of making something up.

### Detail prompt (card click): tight prose only

The click-to-expand path has its own problem. The first version of this prompt said "Under ~200 words, tight scannable prose." The model read `~200` as flexible and produced 300-400 word consulting deliverables with markdown tables and bold section headers. Not useful when you're in a live meeting and have 10 seconds to act.

The fix was hard formatting constraints. "80-120 words. Count them. Stop when you hit 120." "PLAIN PROSE ONLY. No markdown headers. No tables. No numbered lists. No section labels like 'Why this matters' or 'Next step.'" Plus per-category content guidance structured as "Sentence 1: X, Sentence 2-3: Y" which tells the model the shape of the output rather than just the ingredients.

### Chat prompt (typed questions): transcript-grounded, session-aware

This one has to handle a tricky case: user clicks a suggestion, reads the expanded answer, uses the idea in the meeting, gets a follow-up question from a colleague, and types that into the chat. The model has to stitch all of that together.

The fix was telling the model explicitly what context it has (the full transcript, all prior chat in the session including previously clicked cards) and what to do with it: build on earlier answers instead of repeating them, use the transcript to resolve references like "what she said earlier," and flag extrapolation with words like "typically" or "roughly" instead of asserting general knowledge as fact.

Same formatting discipline as the detail prompt. 80-150 words, plain prose, no markdown artifacts.

### Context windows

Defaults are 4000 chars for suggestions (about the last 800 words, enough for recent context without drowning the model in old stuff) and 12000 chars for detail and chat (about 2400 words, more room when depth matters). All three are editable in Settings if the user wants to tune.

## Engineering notes

### Audio chunking: stop and restart every 30 seconds

`MediaRecorder` emits one valid, self-contained file per `.stop()` call. If you call `requestData()` mid-stream instead, you get fragments that aren't valid standalone audio files and Whisper rejects them. So every 30 seconds, I fully stop the current recorder and immediately start a new one on the same persistent `MediaStream`. The audio gap is tens of milliseconds, which is inaudible for meetings. Mic permission stays granted across rotations because the underlying stream is reused.

### SSE streaming: fetch + ReadableStream

The browser's built-in `EventSource` handles SSE cleanly but only supports GET. Chat needs to POST a big payload (transcript, history, prompt overrides), so the frontend reads `response.body` as a `ReadableStream`, decodes with `TextDecoder`, and parses `data: ...\n\n` frames manually. About 40 lines of code, handles token streaming, error frames, and the `[DONE]` terminator.

### React 18 StrictMode double-invoke

In dev, StrictMode runs every effect twice. Two places needed explicit guards against duplicate fetches:

- `loadNewBatch` uses a `loadingRef` (not state) because refs update synchronously. The second invocation sees the guard before the first has even re-rendered.
- The countdown ticker uses `queueMicrotask(() => loadNewBatchRef.current?.())` to defer the fetch outside the state updater. Calling async functions inside state updaters is an anti-pattern because React may run the updater multiple times during concurrent rendering.

### Defensive suggestions parser

GPT-OSS 120B sometimes returns a mix of dicts and plain strings in the suggestions array when the user has customized the prompt in a way that drifts from the default JSON schema. The backend parser handles both, normalizing strings into TALKING POINTs rather than crashing.

### Stateless backend

No sessions, no database, no auth. Every request carries everything it needs: API key, transcript, history, prompts, context sizes. The frontend is the source of truth. The backend is a thin Groq proxy that adds prompt orchestration and streaming glue. Any request can hit any backend instance.

### Export format

JSON with four top-level keys. `session` has metadata (start time, export time, counts). `transcript` is an array of `{timestamp, text}`. `suggestion_batches` is chronological with all cards. `chat` has user and assistant turns with `source: "card" | "typed"` and an optional `card_category`. Readable enough to skim, structured enough to diff.

## Tradeoffs and things I consciously didn't build

**Word-level timestamps.** Whisper supports them but they add latency per Groq docs. Segment-level is accurate enough and costs nothing extra.

**Streaming transcription UX.** Whisper is a batch model, there are no partial results while you talk. Dropping chunk size below 30s would feel more real-time but costs transcription quality (mid-word cuts) and 3 to 6 times the API calls. The spec explicitly says "roughly every 30 seconds".

**Conversation-type detection as a separate model call.** The prompt asks the model to identify the type and pick a category mix in one call. A two-call version (classify then generate) would be cleaner but doubles suggestion latency.

**Things I'd add next if I kept working on it:** prompt presets by meeting type (interview, sales call, standup), token/cost telemetry so users can tune context windows against price, inline transcript editing (Whisper is good but not perfect, bad transcription means bad suggestions), speaker diarization (who said what matters a lot for suggestion relevance but isn't available in Groq's Whisper currently), and persistent sessions with a "resume last session" button.

## File layout

```
backend/
  main.py              FastAPI app with /transcribe, /suggestions, /chat
  requirements.txt
  .env.example         ALLOWED_ORIGINS config

frontend/
  src/
    App.jsx            Main UI, 3-column layout, top bar, state orchestration
    App.css            Layout and panel styles
    Settings.jsx       Settings modal
    Settings.css
    useRecorder.js     Custom hook: getUserMedia + 30s chunk rotation + upload
    api.js             Backend config, localStorage helpers, override builders
    defaults.js        Default prompts and context sizes (mirrors backend)
    main.jsx
    index.css
  package.json
  vite.config.js

README.md
```


