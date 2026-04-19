export const API_BASE =
  import.meta.env?.VITE_API_BASE || "http://localhost:8000";

// All localStorage keys in one place
const LS_KEYS = {
  apiKey: "groq_api_key",
  suggestionsPrompt: "tm_suggestions_prompt",
  detailPrompt: "tm_detail_prompt",
  chatPrompt: "tm_chat_prompt",
  suggestionsContextChars: "tm_suggestions_context_chars",
  detailContextChars: "tm_detail_context_chars",
  chatContextChars: "tm_chat_context_chars",
};

export const getApiKey = () => localStorage.getItem(LS_KEYS.apiKey) || "";
export const setApiKey = (key) => {
  if (key && key.trim()) localStorage.setItem(LS_KEYS.apiKey, key.trim());
  else localStorage.removeItem(LS_KEYS.apiKey);
};
export const hasApiKey = () => getApiKey().length > 0;

export function getSettings() {
  return {
    suggestionsPrompt: localStorage.getItem(LS_KEYS.suggestionsPrompt) || "",
    detailPrompt: localStorage.getItem(LS_KEYS.detailPrompt) || "",
    chatPrompt: localStorage.getItem(LS_KEYS.chatPrompt) || "",
    suggestionsContextChars:
      Number(localStorage.getItem(LS_KEYS.suggestionsContextChars)) || 0,
    detailContextChars:
      Number(localStorage.getItem(LS_KEYS.detailContextChars)) || 0,
    chatContextChars:
      Number(localStorage.getItem(LS_KEYS.chatContextChars)) || 0,
  };
}

export function saveSettings(s) {
  const write = (key, value) => {
    // remove the key entirely if blank so the backend falls back to its default
    if (value && String(value).trim()) {
      localStorage.setItem(key, String(value).trim());
    } else {
      localStorage.removeItem(key);
    }
  };
  write(LS_KEYS.suggestionsPrompt, s.suggestionsPrompt);
  write(LS_KEYS.detailPrompt, s.detailPrompt);
  write(LS_KEYS.chatPrompt, s.chatPrompt);
  write(LS_KEYS.suggestionsContextChars, s.suggestionsContextChars || 0);
  write(LS_KEYS.detailContextChars, s.detailContextChars || 0);
  write(LS_KEYS.chatContextChars, s.chatContextChars || 0);
}

export function suggestionsOverrides() {
  const s = getSettings();
  const out = {};
  if (s.suggestionsPrompt) out.system_prompt = s.suggestionsPrompt;
  if (s.suggestionsContextChars > 0)
    out.context_chars = s.suggestionsContextChars;
  return out;
}

export function chatOverrides({ isCard }) {
  const s = getSettings();
  const out = {};
  const prompt = isCard ? s.detailPrompt : s.chatPrompt;
  const chars = isCard ? s.detailContextChars : s.chatContextChars;
  if (prompt) out.system_prompt = prompt;
  if (chars > 0) out.context_chars = chars;
  return out;
}
