import { createContext, useContext, useState, type ReactNode } from "react";

export const DEFAULT_SUMMARY_INSTRUCTIONS = `You are a research assistant helping to summarize academic papers.

Given the following paper text, write a concise summary covering:
1. **Problem**: What problem does this paper address?
2. **Method**: What approach or method do they use?
3. **Key findings**: What are the main results or contributions?
4. **Relevance**: Who would benefit from reading this?
5. **Data**: Explain in great detail what exactly the input data is and what the output data is. In the context of the model.
6. **Training data**: What exactly was used as training data? How many point what kind of data from where?

Keep the summary under 500 words. Use plain language where possible.`;

export interface AppSettings {
  // Library
  defaultSort: "date_desc" | "date_asc" | "year_desc" | "year_asc" | "title_asc" | "rating_desc" | "citations_desc";
  showAbstractPreview: boolean;
  papersPerPage: 20 | 50 | 100 | 0; // 0 = all

  // Upload workflow
  showSourceStep: boolean;
  showSummaryPromptStep: boolean;
  autoSaveReferences: boolean;
  defaultSummaryInstructions: string;

  // Graph
  defaultGraphMode: "full" | "papers";
  graphNodeSize: number;
  graphShowNodeLabels: boolean;
  graphShowEdgeLabels: boolean;

  // Knowledge Chat
  knowledgeChatUseWeb: boolean;

  // Inference — upload-time enrichment
  autoExtractClaims: boolean;
  generateEmbeddingsOnUpload: boolean;

  // Debug
  debugMode: boolean;
}

export const SETTINGS_DEFAULTS: AppSettings = {
  defaultSort: "date_desc",
  showAbstractPreview: true,
  papersPerPage: 50,
  showSourceStep: true,
  showSummaryPromptStep: true,
  autoSaveReferences: false,
  defaultSummaryInstructions: DEFAULT_SUMMARY_INSTRUCTIONS,
  defaultGraphMode: "papers",
  graphNodeSize: 16,
  graphShowNodeLabels: true,
  graphShowEdgeLabels: true,
  knowledgeChatUseWeb: true,
  autoExtractClaims: true,
  generateEmbeddingsOnUpload: true,
  debugMode: false,
};

const STORAGE_KEY = "paperManager:settings";

function loadFromStorage(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return SETTINGS_DEFAULTS;
    const parsed = { ...SETTINGS_DEFAULTS, ...JSON.parse(raw) };
    return parsed;
  } catch {
    return SETTINGS_DEFAULTS;
  }
}

function saveToStorage(s: AppSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

interface SettingsContextValue {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  reset: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(loadFromStorage);

  const update = (patch: Partial<AppSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      saveToStorage(next);
      return next;
    });
  };

  const reset = () => {
    localStorage.removeItem(STORAGE_KEY);
    setSettings(SETTINGS_DEFAULTS);
  };

  return (
    <SettingsContext.Provider value={{ settings, update, reset }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useAppSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useAppSettings must be used inside SettingsProvider");
  return ctx;
}
