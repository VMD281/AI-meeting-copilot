import { useEffect, useState } from "react";
import { getApiKey, setApiKey, getSettings, saveSettings } from "./api";
import {
  DEFAULT_SUGGESTIONS_PROMPT,
  DEFAULT_DETAIL_PROMPT,
  DEFAULT_CHAT_PROMPT,
  DEFAULT_SUGGESTIONS_CONTEXT_CHARS,
  DEFAULT_DETAIL_CONTEXT_CHARS,
  DEFAULT_CHAT_CONTEXT_CHARS,
} from "./defaults";

export function Settings({ open, onClose }) {
  const [apiKey, setApiKeyState] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [suggestionsPrompt, setSuggestionsPrompt] = useState("");
  const [detailPrompt, setDetailPrompt] = useState("");
  const [chatPrompt, setChatPrompt] = useState("");
  const [suggestionsChars, setSuggestionsChars] = useState("");
  const [detailChars, setDetailChars] = useState("");
  const [chatChars, setChatChars] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    const apiKey = getApiKey();
    const settings = getSettings();
    setApiKeyState(apiKey);
    setSuggestionsPrompt(settings.suggestionsPrompt);
    setDetailPrompt(settings.detailPrompt);
    setChatPrompt(settings.chatPrompt);
    setSuggestionsChars(settings.suggestionsContextChars || "");
    setDetailChars(settings.detailContextChars || "");
    setChatChars(settings.chatContextChars || "");
    setSaved(false);
    setRevealKey(false);
  }, [open]);

  if (!open) return null;

  const handleSave = () => {
    setApiKey(apiKey);
    saveSettings({
      suggestionsPrompt,
      detailPrompt,
      chatPrompt,
      suggestionsContextChars: Number(suggestionsChars) || 0,
      detailContextChars: Number(detailChars) || 0,
      chatContextChars: Number(chatChars) || 0,
    });
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      onClose();
    }, 600);
  };

  const resetAll = () => {
    setSuggestionsPrompt("");
    setDetailPrompt("");
    setChatPrompt("");
    setSuggestionsChars("");
    setDetailChars("");
    setChatChars("");
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="settings-head">
          <h2>Settings</h2>
          <button
            className="settings-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="settings-body">
          {/* API Key */}
          <section className="settings-section">
            <label className="settings-label">
              Groq API key
              <span className="settings-hint">
                Get one free at console.groq.com. Stored only in your browser.
              </span>
            </label>
            <div className="settings-key-row">
              <input
                type={revealKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKeyState(e.target.value)}
                placeholder="gsk_..."
                className="settings-input"
              />
              <button
                className="settings-reveal"
                onClick={() => setRevealKey((v) => !v)}
                type="button"
              >
                {revealKey ? "Hide" : "Show"}
              </button>
            </div>
          </section>

          {/* Prompts */}
          <PromptField
            label="Live suggestions prompt"
            hint="System prompt used when generating the 3 cards."
            value={suggestionsPrompt}
            onChange={setSuggestionsPrompt}
            defaultValue={DEFAULT_SUGGESTIONS_PROMPT}
          />
          <PromptField
            label="Detailed answer prompt (on card click)"
            hint="System prompt used when expanding a clicked suggestion."
            value={detailPrompt}
            onChange={setDetailPrompt}
            defaultValue={DEFAULT_DETAIL_PROMPT}
          />
          <PromptField
            label="Chat prompt (typed questions)"
            hint="System prompt used when the user types a question directly."
            value={chatPrompt}
            onChange={setChatPrompt}
            defaultValue={DEFAULT_CHAT_PROMPT}
          />

          {/* Context sizes */}
          <section className="settings-section">
            <label className="settings-label">
              Context window (chars of transcript)
            </label>
            <div className="settings-grid">
              <NumberField
                label="Suggestions"
                value={suggestionsChars}
                onChange={setSuggestionsChars}
                placeholder={`${DEFAULT_SUGGESTIONS_CONTEXT_CHARS}`}
              />
              <NumberField
                label="Detail (on click)"
                value={detailChars}
                onChange={setDetailChars}
                placeholder={`${DEFAULT_DETAIL_CONTEXT_CHARS}`}
              />
              <NumberField
                label="Chat"
                value={chatChars}
                onChange={setChatChars}
                placeholder={`${DEFAULT_CHAT_CONTEXT_CHARS}`}
              />
            </div>
            <span className="settings-hint">
              Empty means use default. Larger = more context, slower + more
              tokens.
            </span>
          </section>
        </div>

        <div className="settings-foot">
          <button className="settings-reset" onClick={resetAll}>
            Reset all to defaults
          </button>
          <div className="settings-actions">
            <button className="settings-cancel" onClick={onClose}>
              Cancel
            </button>
            <button className="settings-save" onClick={handleSave}>
              {saved ? "Saved ✓" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PromptField({ label, hint, value, onChange, defaultValue }) {
  const [showDefault, setShowDefault] = useState(false);
  return (
    <section className="settings-section">
      <label className="settings-label">
        {label}
        <span className="settings-hint">{hint}</span>
      </label>
      <textarea
        className="settings-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="(using default — leave blank to keep it, or type a custom prompt)"
        rows={6}
      />
      <div className="settings-row-actions">
        <button
          className="settings-inline"
          type="button"
          onClick={() => setShowDefault((v) => !v)}
        >
          {showDefault ? "Hide default" : "View default"}
        </button>
        <button
          className="settings-inline"
          type="button"
          onClick={() => onChange(defaultValue)}
        >
          Copy default into editor
        </button>
        {value && (
          <button
            className="settings-inline"
            type="button"
            onClick={() => onChange("")}
          >
            Clear override
          </button>
        )}
      </div>
      {showDefault && (
        <pre className="settings-default-block">{defaultValue}</pre>
      )}
    </section>
  );
}

function NumberField({ label, value, onChange, placeholder }) {
  return (
    <div className="settings-number-field">
      <span className="settings-number-label">{label}</span>
      <input
        type="number"
        className="settings-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        min={0}
        step={500}
      />
    </div>
  );
}
