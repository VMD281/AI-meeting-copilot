import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import "./Settings.css";
import { useRecorder } from "./useRecorder";
import { API_BASE, getApiKey, hasApiKey, suggestionsOverrides, chatOverrides } from "./api";
import { Settings } from "./Settings";

const CATEGORY_CONFIG = {
  ANSWER: { label: "ANSWER", color: "var(--tag-answer)" },
  "FACT-CHECK": { label: "FACT-CHECK", color: "var(--tag-fact)" },
  "QUESTION TO ASK": { label: "QUESTION TO ASK", color: "var(--tag-question)" },
  "TALKING POINT": { label: "TALKING POINT", color: "var(--tag-point)" },
};

async function fetchSuggestions({ transcript, batchId }) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No Groq API key set. Add one in Settings.");

  const res = await fetch(`${API_BASE}/suggestions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      transcript: transcript || "",
      ...suggestionsOverrides(),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Suggestions failed (${res.status}): ${detail.slice(0, 160)}`,
    );
  }

  const data = await res.json();
  return {
    id: batchId,
    timestamp: generateTimestamp(),
    cards: data.suggestions || [],
  };
}

const generateTimestamp = () => {
  const now = new Date();
  const hour = now.getHours();
  const minute = String(now.getMinutes()).padStart(2, "0");
  const second = String(now.getSeconds()).padStart(2, "0");
  const suffix = hour >= 12 ? "PM" : "AM";
  const normalizedHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(normalizedHour).padStart(2, "0")}:${minute}:${second} ${suffix}`;
};

const formatTimestamp = (date) => {
  const hour = date.getHours();
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  const suffix = hour >= 12 ? "PM" : "AM";
  const normalizedHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(normalizedHour).padStart(2, "0")}:${minute}:${second} ${suffix}`;
};

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [transcriptLines, setTranscriptLines] = useState([]);
  const [transcriptText, setTranscriptText] = useState("");
  const [batches, setBatches] = useState([]);
  const [countdown, setCountdown] = useState(30);
  const [chatMessages, setChatMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState(null);

  const transcriptRef = useRef(null);
  const chatRef = useRef(null);
  const nextBatchIdRef = useRef(1);
  const nextMessageIdRef = useRef(1);
  const transcriptTextRef = useRef("");
  const sessionStartRef = useRef(null);
  useEffect(() => {
    transcriptTextRef.current = transcriptText;
  }, [transcriptText]);

  const { error: micError } = useRecorder({
    isRecording,
    onTranscript: ({ chunkStartedAt, segments, fullText }) => {
      // Build one transcript line per segment with its real wall-clock time.
      const newLines = segments
        .filter((s) => s.text)
        .map((s) => {
          const wallClock = new Date(chunkStartedAt + s.start * 1000);
          return `${formatTimestamp(wallClock)} · ${s.text}`;
        });
      if (newLines.length > 0) {
        setTranscriptLines((prev) => [...prev, ...newLines]);
        setTranscriptText((prev) => (prev ? `${prev} ${fullText}` : fullText));
      }
    },
  });

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcriptLines]);

  // Auto-scroll chat
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const loadingRef = useRef(false);
  const loadNewBatchRef = useRef(null);

  const loadNewBatch = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setSuggestionsLoading(true);
    setSuggestionsError(null);
    try {
      const batch = await fetchSuggestions({
        transcript: transcriptTextRef.current,
        batchId: nextBatchIdRef.current++,
      });
      setBatches((current) => [batch, ...current].slice(0, 12));
      setCountdown(30);
    } catch (e) {
      setSuggestionsError(e.message);
    } finally {
      loadingRef.current = false;
      setSuggestionsLoading(false);
    }
  };

  useEffect(() => {
    loadNewBatchRef.current = loadNewBatch;
  });

  // Auto-refresh countdown — only runs while recording
  useEffect(() => {
    if (!isRecording) return undefined;

    const ticker = setInterval(() => {
      setCountdown((value) => {
        if (value <= 1) {
          // Schedule the fetch outside the updater — don't call it synchronously here.
          queueMicrotask(() => loadNewBatchRef.current?.());
          return 30;
        }
        return value - 1;
      });
    }, 1000);

    return () => clearInterval(ticker);
  }, [isRecording]);

  const handleToggleRecording = () => {
    if (!isRecording && !hasApiKey()) {
      setSettingsOpen(true);
      return;
    }
    setIsRecording((current) => {
      const next = !current;
      if (next) {
        if (!sessionStartRef.current) sessionStartRef.current = new Date();
        if (batches.length === 0) loadNewBatch();
      }
      return next;
    });
  };

  const handleExport = () => {
    const payload = {
      session: {
        started_at: sessionStartRef.current?.toISOString() ?? null,
        exported_at: new Date().toISOString(),
      },
      transcript: transcriptLines,
      suggestion_batches: batches,
      chat: chatMessages,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `meeting-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleReloadSuggestions = () => {
    if (!isRecording && batches.length === 0) return;
    loadNewBatch();
  };

  const streamAssistantResponse = async (
    assistantId,
    { message, source, cardCategory },
  ) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      setChatMessages((current) =>
        current.map((m) =>
          m.id === assistantId
            ? { ...m, text: "Error: No Groq API key set. Add one in Settings." }
            : m,
        ),
      );
      return;
    }

    // Build history from current chat, excluding the just-added empty assistant slot.
    const history = chatMessages
      .filter((m) => m.id !== assistantId && m.text.trim())
      .map((m) => ({
        role: m.sender === "YOU" ? "user" : "assistant",
        content: m.text,
      }));

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          message,
          transcript: transcriptTextRef.current,
          history,
          source,
          card_category: cardCategory || null,
          ...chatOverrides({ isCard: source === "card" }),
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Chat failed (${res.status}): ${detail.slice(0, 160)}`);
      }

      // Parse SSE stream.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by double newlines.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || ""; // last piece might be incomplete

        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            return;
          }
          try {
            const parsed = JSON.parse(payload);
            if (parsed.error) {
              accumulated += `\n\n[Error: ${parsed.error}]`;
            } else if (parsed.delta) {
              accumulated += parsed.delta;
            }
            setChatMessages((current) =>
              current.map((m) =>
                m.id === assistantId ? { ...m, text: accumulated } : m,
              ),
            );
          } catch {
            // Ignore malformed frames
          }
        }
      }
    } catch (e) {
      setChatMessages((current) =>
        current.map((m) =>
          m.id === assistantId ? { ...m, text: `Error: ${e.message}` } : m,
        ),
      );
    }
  };

  const handleSuggestionClick = (card) => {
    const userId = `u${nextMessageIdRef.current++}`;
    const assistantId = `a${nextMessageIdRef.current++}`;

    setChatMessages((current) => [
      ...current,
      { id: userId, sender: "YOU", category: card.category, text: card.text },
      { id: assistantId, sender: "ASSISTANT", category: "", text: "" },
    ]);

    streamAssistantResponse(assistantId, {
      message: card.text,
      source: "card",
      cardCategory: card.category,
    });
  };

  const handleSend = () => {
    if (!draft.trim()) return;

    const userId = `u${nextMessageIdRef.current++}`;
    const assistantId = `a${nextMessageIdRef.current++}`;
    const text = draft.trim();

    setChatMessages((current) => [
      ...current,
      { id: userId, sender: "YOU", category: "CUSTOM", text },
      { id: assistantId, sender: "ASSISTANT", category: "", text: "" },
    ]);
    setDraft("");

    streamAssistantResponse(assistantId, {
      message: text,
      source: "user",
    });
  };

  const chatBlocks = useMemo(() => chatMessages, [chatMessages]);

  return (
    <div className="app-shell">
      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <header className="top-bar">
        <div className="top-bar-brand">TwinMind</div>
        <div className="top-bar-actions">
          <button
            className="top-bar-btn"
            onClick={handleExport}
            disabled={
              transcriptLines.length === 0 &&
              chatMessages.length === 0 &&
              batches.length === 0
            }
            title="Download full session as JSON"
          >
            ⬇ Export
          </button>
          <button
            className="top-bar-btn"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
            title="Settings"
          >
            ⚙ Settings
          </button>
        </div>
      </header>

      <div className="app-main">
      {/* ---------- Column 1: Mic & Transcript ---------- */}
      <section className="panel left-panel">
        <div className="panel-head">
          <div className="panel-tag">1. MIC &amp; TRANSCRIPT</div>
          <span className={`pill ${isRecording ? "pill-live" : "pill-idle"}`}>
            {isRecording ? "RECORDING" : "IDLE"}
          </span>
        </div>

        <div className="mic-row">
          <button
            className={`mic-button ${isRecording ? "mic-active" : ""}`}
            onClick={handleToggleRecording}
            aria-label="Toggle recording"
          >
            <span className="mic-dot" />
          </button>
          <div className="mic-status">
            {isRecording
              ? "Recording… transcript appends every ~30s."
              : "Click mic to start. Transcript appends every ~30s."}
          </div>
          {micError && (
            <div
              className="info-card"
              style={{
                borderColor: "rgba(239, 68, 68, 0.4)",
                color: "#fca5a5",
              }}
            >
              {micError}
            </div>
          )}
        </div>

        <div className="info-card">
          Transcript appends a new chunk every ~30 seconds while recording.
          Use the Export button at the top to download the full session as JSON.
        </div>

        <div className="transcript-card" ref={transcriptRef}>
          {transcriptLines.length === 0 ? (
            <div className="empty-state">
              No transcript yet — start the mic.
            </div>
          ) : (
            <div className="transcript-list">
              {transcriptLines.map((line, index) => {
                const [time, text] = line.split(" · ");
                return (
                  <div className="transcript-line" key={`${time}-${index}`}>
                    <span className="timestamp">{time}</span>
                    <span className="line-text">{text}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ---------- Column 2: Live Suggestions ---------- */}
      <section className="panel middle-panel">
        <div className="panel-head">
          <div className="panel-tag">2. LIVE SUGGESTIONS</div>
          <span className="pill pill-muted">{batches.length} BATCHES</span>
        </div>

        <div className="control-row">
          <button
            className="reload-btn"
            onClick={handleReloadSuggestions}
            disabled={suggestionsLoading}
          >
            ⟲ Reload suggestions
          </button>
          <span className="countdown">
            {suggestionsLoading
              ? "generating…"
              : isRecording
                ? `auto-refresh in ${countdown}s`
                : "auto-refresh in 30s"}
          </span>
        </div>

        <div className="info-card">
          On reload (or auto every ~30s), generate{" "}
          <strong>3 fresh suggestions</strong> from recent transcript context.
          New batch appears at the top; older batches push down (faded). Each is
          a tappable card: a{" "}
          <span style={{ color: "var(--tag-question)" }}>question to ask</span>,{" "}
          a <span style={{ color: "var(--tag-point)" }}>talking point</span>, an{" "}
          <span style={{ color: "var(--tag-answer)" }}>answer</span>, or a{" "}
          <span style={{ color: "var(--tag-fact)" }}>fact-check</span>. The
          preview alone should already be useful.
        </div>

        {suggestionsError && (
          <div
            className="info-card"
            style={{ borderColor: "rgba(239, 68, 68, 0.4)", color: "#fca5a5" }}
          >
            {suggestionsError}
          </div>
        )}
        <div className="suggestions-list">
          {batches.length === 0 ? (
            <div className="empty-state">
              Suggestions appear here once recording starts.
            </div>
          ) : (
            batches.map((batch, index) => {
              const opacity = Math.max(0.25, 1 - index * 0.2);
              return (
                <div
                  className="suggestion-batch"
                  key={batch.id}
                  style={{ opacity }}
                >
                  {index > 0 && (
                    <div className="batch-divider">
                      — BATCH {batch.id} · {batch.timestamp} —
                    </div>
                  )}
                  {batch.cards.map((card, cardIndex) => (
                    <button
                      key={`${batch.id}-${cardIndex}`}
                      className="suggestion-card"
                      onClick={() => handleSuggestionClick(card)}
                    >
                      <span
                        className="badge"
                        style={{
                          background: CATEGORY_CONFIG[card.category].color,
                        }}
                      >
                        {CATEGORY_CONFIG[card.category].label}
                      </span>
                      <span className="card-text">{card.text}</span>
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* ---------- Column 3: Chat ---------- */}
      <section className="panel right-panel">
        <div className="panel-head">
          <div className="panel-tag">3. CHAT (DETAILED ANSWERS)</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="pill pill-muted">SESSION-ONLY</span>
            <button
              className="gear-button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Open settings"
              title="Settings"
            >
              ⚙
            </button>
          </div>
        </div>

        <div className="info-card">
          Clicking a suggestion adds it to this chat and streams a detailed
          answer (separate prompt, more context). User can also type questions
          directly. One continuous chat per session — no login, no persistence.
        </div>

        <div className="chat-area" ref={chatRef}>
          {chatBlocks.length === 0 ? (
            <div className="empty-state">
              Click a suggestion or type a question below.
            </div>
          ) : (
            chatBlocks.map((message) => (
              <div
                key={message.id}
                className={`chat-block ${message.sender === "YOU" ? "chat-user" : "chat-assistant"}`}
              >
                {message.sender === "YOU" && (
                  <div className="chat-meta">YOU · {message.category}</div>
                )}
                {message.sender === "ASSISTANT" && (
                  <div className="chat-meta">ASSISTANT</div>
                )}
                <div className="chat-message">
                  {message.text || "Streaming response…"}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="chat-input-row">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Ask anything…"
          />
          <button className="send-button" onClick={handleSend}>
            Send
          </button>
        </div>
      </section>
      </div>
    </div>
  );
}

export default App;
