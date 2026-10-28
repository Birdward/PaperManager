// PaperManager has one model: Claude through Claude Code on the owner's subscription ("opus" is
// the newest Opus, currently Opus 5.5). The backend still accepts Niklas's other model names
// ("claude", "claude-work", "litellm"), but nothing in the UI offers them.
export const CHAT_MODEL = "claude-code";
export const CHAT_MODEL_LABEL = "Claude Opus";
