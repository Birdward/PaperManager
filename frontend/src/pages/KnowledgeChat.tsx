/**
 * Knowledge Chat: a chat over the whole library, laid out like the thesis desk.
 *
 * Conversations on the left (newest first, forks nested), a reading-width
 * transcript with the branch lane beside it, a composer with scope chips and
 * attached papers at the foot, and a preview pane on the right for a cited
 * paper or a figure. Answers render maths, code, tables, library figures,
 * paper citations, concept cards (generated from the answer by the concept
 * pipeline, or written inline by the model) and 3D structures.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiFetch, compactConversation, deleteConversation, forkConversation, getAnswerConcepts,
  getConversationMessages, listConversations, renameConversation, repairAnswerConcept,
  streamKnowledgeChat, visualiseAnswer,
} from "../api/client";
import { BranchLane, type Branch } from "../components/kchat/BranchLane";
import { Composer, type AttachedPaper, type Entities } from "../components/kchat/Composer";
import ConceptCard from "../components/kchat/ConceptCard";
import { ConversationList } from "../components/kchat/ConversationList";
import { ChatLinksContext, Markdown, type ChatLinks } from "../components/kchat/Markdown";
import { PreviewPane, type Preview } from "../components/kchat/PreviewPane";
import { citedPapers, splitSections } from "../components/kchat/sections";
import "../components/kchat/kchat.css";
import { useAppSettings } from "../contexts/SettingsContext";
import { CHAT_MODEL_LABELS, useChatModels, type ChatModel } from "../lib/chatModels";
import type {
  ChatConcept, ChatConceptsState, ContextPaper, Conversation, KnowledgeMessage, MessagePaper,
  StepKind, TokenTotals,
} from "../types";

// ── Transcript items ─────────────────────────────────────────────────────────

type Step = { kind?: StepKind; description: string; cypher?: string | null; count?: number | null; papers?: MessagePaper[] };
type UserItem = { kind: "user"; key: string; id?: string; text: string };
type AnswerItem = {
  kind: "assistant"; key: string; id?: string; text: string; steps: Step[];
  streaming?: boolean; error?: string; stopped?: boolean; reconnecting?: boolean;
  papers: MessagePaper[];
  concepts: ChatConcept[] | null; conceptsStatus: ChatConceptsState["status"]; conceptsError: string | null;
};
type SystemItem = { kind: "system"; key: string; text: string };
type Item = UserItem | AnswerItem | SystemItem;

let keySeq = 0;
const nextKey = () => `k${++keySeq}`;

const answerOf = (m: KnowledgeMessage): AnswerItem => ({
  kind: "assistant", key: m.id, id: m.id, text: m.content, steps: [], papers: m.papers ?? [],
  concepts: m.concepts ?? null, conceptsStatus: m.concepts_status ?? null, conceptsError: m.concepts_error ?? null,
});

export function toItems(msgs: KnowledgeMessage[]): Item[] {
  return msgs.flatMap((m, i): Item[] => {
    if (m.role === "system") return [{ kind: "system", key: m.id, text: m.content }];
    if (m.role === "assistant") return [answerOf(m)];
    const user: Item = { kind: "user", key: m.id, id: m.id, text: m.content };
    // A question whose answer failed shows the failure in place of the answer.
    if (m.answer_error && msgs[i + 1]?.role !== "assistant") {
      return [user, { ...answerOf({ ...m, content: "" }), key: `${m.id}-err`, id: undefined, error: m.answer_error }];
    }
    return [user];
  });
}

/**
 * After a dropped stream the backend still finishes and saves the answer:
 * poll the conversation until the answer to `userMessageId` (or its error) is there.
 */
export async function awaitSavedAnswer(
  conversationId: string, userMessageId: string,
  opts: { every?: number; timeout?: number; signal?: { stopped: boolean } } = {},
): Promise<KnowledgeMessage | { error: string }> {
  const every = opts.every ?? 4000, deadline = Date.now() + (opts.timeout ?? 20 * 60_000);
  while (Date.now() < deadline && !opts.signal?.stopped) {
    const msgs = await getConversationMessages(conversationId).catch(() => null);
    const i = msgs ? msgs.findIndex((m) => m.id === userMessageId) : -1;
    if (msgs && i >= 0) {
      if (msgs[i + 1]?.role === "assistant") return msgs[i + 1];
      if (msgs[i].answer_error) return { error: msgs[i].answer_error! };
    }
    await new Promise((r) => setTimeout(r, every));
  }
  return { error: "The connection was lost and the answer did not arrive." };
}

/** What the backend gets as history: the transcript as role/content pairs (a compaction summary as a user turn). */
function historyOf(items: Item[]) {
  return items.flatMap((it) => {
    if (it.kind === "user") return [{ role: "user", content: it.text }];
    if (it.kind === "system") return [{ role: "user", content: `[Summary of the earlier conversation]\n${it.text}` }];
    return it.text && !it.error ? [{ role: "assistant", content: it.text }] : [];
  });
}

const AUTO_KEY = "knowledgeChat.autoConcepts";
const readAuto = () => { try { return localStorage.getItem(AUTO_KEY) === "1"; } catch { return false; } };

const STARTERS = [
  { label: "Compare methods", text: "How does AlphaFold 3 differ from AlphaFold 2 in architecture and training? Cite the papers." },
  { label: "Explain the maths", text: "Explain the denoising score-matching objective behind diffusion models, with the derivation." },
  { label: "Show a structure", text: "Show me a protein designed with RFdiffusion in 3D and explain what the design achieved." },
  { label: "Map the library", text: "Which research topics are best covered in my library, and which recent papers stand out in each?" },
];

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// ── Small pieces ─────────────────────────────────────────────────────────────

const STEP_LABEL: Record<StepKind, string> = {
  cypher: "Graph", search: "Search", fulltext: "Read", figures: "Figures", web: "Web", attach: "Attach", notes: "Notes",
};

function StepRow({ step, onPaper }: { step: Step; onPaper: (p: MessagePaper) => void }) {
  const [open, setOpen] = useState(false);
  const detail = !!step.cypher || !!step.papers?.length;
  return (
    <div className={`kc-step ${open ? "open" : ""}`}>
      <button type="button" className="kc-step-head" onClick={() => detail && setOpen((o) => !o)} aria-expanded={open}>
        <span className="kc-step-dot" />
        <span className="kc-step-kind">{step.kind ? STEP_LABEL[step.kind] : "Library"}</span>
        <span className="kc-step-desc">{step.description}</span>
        {step.count != null && <span className="kc-step-count">{step.count}</span>}
        {detail && <span className="kc-chev">{open ? "▾" : "▸"}</span>}
      </button>
      {open && (
        <div className="kc-step-body">
          {step.cypher && !step.cypher.startsWith("[vector search]") && <pre><code>{step.cypher}</code></pre>}
          {!!step.papers?.length && (
            <div className="kc-src-list">
              {step.papers.map((p) => (
                <button type="button" key={p.id} className="kc-src-chip" onClick={() => onPaper(p)}>{p.title}{p.year ? ` · ${p.year}` : ""}</button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ContextStrip({ totals, papers, answerTokens, onPaper }: {
  totals: TokenTotals | null; papers: ContextPaper[]; answerTokens: number; onPaper: (p: MessagePaper) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!totals) return null;
  const limit = totals.limit || 200_000;
  const used = totals.total + answerTokens;
  const segs = [
    { label: "System prompt", tokens: totals.system, color: "#c4b5fd" },
    { label: `${papers.length} papers`, tokens: totals.papers, color: "#7c3aed" },
    { label: "Conversation", tokens: totals.history, color: "#38bdf8" },
    { label: "Question", tokens: totals.question, color: "#34d399" },
    { label: "Answer", tokens: answerTokens, color: "#fbbf24" },
  ].filter((s) => s.tokens > 0);
  return (
    <div className="kc-context">
      <button type="button" className="kc-context-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        title="What fills the model's context window">
        <span className="kc-kicker">Context</span>
        <span className="kc-context-bar">
          {segs.map((s) => <i key={s.label} style={{ width: `${Math.max(0.4, (100 * s.tokens) / limit)}%`, background: s.color }} />)}
        </span>
        <span className="kc-context-num">{fmtK(used)} / {fmtK(limit)} · {((100 * used) / limit).toFixed(1)}%</span>
        <span className="kc-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="kc-context-legend">
          <div className="kc-context-keys">
            {segs.map((s) => <span key={s.label}><i style={{ background: s.color }} />{s.label} <b>{fmtK(s.tokens)}</b></span>)}
          </div>
          <div className="kc-src-list">
            {papers.map((p) => (
              <button type="button" key={p.id} className={`kc-src-chip ${p.attached ? "attached" : ""}`} onClick={() => onPaper(p)}
                title={`${p.tokens.toLocaleString()} tokens`}>
                {p.title}{p.year ? ` · ${p.year}` : ""}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const ForkIcon = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
    <circle cx="3" cy="2.2" r="1.3" /><circle cx="3" cy="9.8" r="1.3" /><circle cx="9" cy="4.2" r="1.3" />
    <path d="M3 3.5v5M9 5.5c0 2.2-6 1.4-6 3" />
  </svg>
);

/** An answer: its library steps, its sections with their concept cards, and a footer of sources and actions. */
function Answer({ item, onPaper, onVisualise, onRepair }: {
  item: AnswerItem;
  onPaper: (p: MessagePaper) => void;
  onVisualise: (item: AnswerItem) => void;
  onRepair: (item: AnswerItem, index: number, error: string) => void;
}) {
  const [showContext, setShowContext] = useState(false);
  const [copied, setCopied] = useState(false);
  const [crashed, setCrashed] = useState<Record<number, string>>({});
  const sections = useMemo(() => splitSections(item.text), [item.text]);
  const cited = useMemo(() => citedPapers(item.text), [item.text]);
  const cards = (item.concepts ?? []).map((c, i) => ({ c, i }));
  const placed = (s: number) => cards.filter(({ c }) => Math.min(c.section, sections.length - 1) === s);
  const failed = cards.filter(({ c }) => !c.spec);
  const running = item.conceptsStatus === "running";

  const copy = async () => {
    try { await navigator.clipboard.writeText(item.text); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* no clipboard */ }
  };

  return (
    <div className="msg assistant">
      {item.steps.length > 0 && <div className="kc-steps">{item.steps.map((s, i) => <StepRow key={i} step={s} onPaper={onPaper} />)}</div>}
      {sections.map((sec, s) => (
        <div key={s} className="kc-section">
          {sec.trim() && <Markdown text={sec} streaming={item.streaming} />}
          {placed(s).filter(({ c }) => c.spec).map(({ c, i }) => (
            <ConceptCard key={`${i}-${JSON.stringify(c.spec).length}`} spec={c.spec!} label={c.label}
              onRuntimeError={(m) => setCrashed((x) => ({ ...x, [i]: m }))}
              actions={crashed[i] && item.id ? (
                <button type="button" className="kc-btn" title="Ask the model to fix this card, telling it the error"
                  onClick={() => { onRepair(item, i, crashed[i]); setCrashed((x) => { const y = { ...x }; delete y[i]; return y; }); }}>fix</button>
              ) : undefined}
              footnote="made from this answer" />
          ))}
        </div>
      ))}
      {item.streaming && !item.text && <div className="kc-working"><span className="kc-spinner" /> thinking…</div>}
      {item.reconnecting && (
        <div className="kc-working"><span className="kc-spinner" /> connection lost; the answer is still being written and will appear here…</div>
      )}
      {item.error && <div className="kc-note error">{item.error}</div>}
      {item.stopped && <div className="kc-note">stopped</div>}
      {running && (
        <div className="kc-card kc-card-pending kc-visualising">
          <span className="kc-spinner" /> Making concept cards from this answer… formulas and graphs take about a minute, animations a few.
        </div>
      )}
      {item.conceptsStatus === "failed" && <div className="kc-note error">Concept cards failed: {item.conceptsError}</div>}
      {item.conceptsStatus === "done" && !cards.length && <div className="kc-note">No idea in this answer called for a concept card.</div>}
      {failed.length > 0 && (
        <div className="kc-note">{failed.length} card{failed.length > 1 ? "s" : ""} could not be made ({failed.map(({ c }) => c.label).join(", ")}).</div>
      )}
      {!item.streaming && !item.reconnecting && item.text && (
        <div className="kc-answer-foot">
          {cited.length > 0 && <span className="kc-kicker">Cited</span>}
          {cited.map((p) => (
            <button type="button" key={p.id} className="kc-src-chip k-paper" onClick={() => onPaper(p)} title={p.title}><span>{p.title}</span></button>
          ))}
          {item.papers.length > 0 && (
            <button type="button" className="kc-src-more" onClick={() => setShowContext((v) => !v)}>
              {item.papers.length} in context {showContext ? "▾" : "▸"}
            </button>
          )}
          <span className="kc-spacer" />
          {item.id && (
            <button type="button" className="kc-mini" disabled={running} onClick={() => onVisualise(item)}
              title="Find the ideas in this answer a picture would explain and make interactive cards for them">
              {running ? "visualising…" : item.concepts?.length ? "↻ visualise again" : "✦ Visualise"}
            </button>
          )}
          <button type="button" className="kc-mini" onClick={copy}>{copied ? "copied" : "copy"}</button>
        </div>
      )}
      {showContext && (
        <div className="kc-src-list kc-context-papers">
          {item.papers.map((p) => (
            <button type="button" key={p.id} className="kc-src-chip" onClick={() => onPaper(p)}>{p.title}{p.year ? ` · ${p.year}` : ""}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function KnowledgeChat() {
  const { settings } = useAppSettings();
  const models = useChatModels();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [model, setModel] = useState<ChatModel>(
    settings.knowledgeChatDefaultModel === "ollama" ? "litellm" : settings.knowledgeChatDefaultModel as ChatModel,
  );
  const [useWeb, setUseWeb] = useState<boolean>(settings.knowledgeChatUseWeb);
  const [autoConcepts, setAutoConceptsState] = useState(readAuto);
  const [attached, setAttached] = useState<AttachedPaper[]>([]);
  const [draft, setDraft] = useState<{ text: string; n: number } | undefined>();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [totals, setTotals] = useState<TokenTotals | null>(null);
  const [contextPapers, setContextPapers] = useState<ContextPaper[]>([]);
  const [answerTokens, setAnswerTokens] = useState(0);
  const [compacting, setCompacting] = useState(false);
  const [entities, setEntities] = useState<Entities>({ tags: [], topics: [], projects: [], people: [], users: [], papers: [] });
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const setAutoConcepts = (v: boolean) => {
    setAutoConceptsState(v);
    try { localStorage.setItem(AUTO_KEY, v ? "1" : "0"); } catch { /* private mode */ }
  };

  const refreshList = useCallback(() => listConversations().then(setConversations).catch(() => {}), []);

  useEffect(() => {
    refreshList();
    const names = <T extends { name: string }>(path: string) => apiFetch<T[]>(path).then((r) => r.map((x) => x.name)).catch(() => [] as string[]);
    Promise.all([
      names("/tags"), names("/topics"), names("/projects"), names("/people"), names("/users"),
      apiFetch<{ id: string; title: string; year?: number | null }[]>("/papers").catch(() => []),
    ]).then(([tags, topics, projects, people, users, papers]) => setEntities({
      tags, topics, projects, people: ["known-personally", ...people], users,
      papers: papers.map((p) => ({ id: p.id, title: p.title, year: p.year })),
    }));
  }, [refreshList]);

  // Keep the end of the chat in view while it grows, unless the reader scrolled up.
  useEffect(() => { if (stick.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [items]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const patchAnswer = (match: (it: AnswerItem) => boolean, patch: (it: AnswerItem) => Partial<AnswerItem>) =>
    setItems((xs) => xs.map((it) => (it.kind === "assistant" && match(it) ? { ...it, ...patch(it) } : it)));

  // Poll the answers whose concept cards are being made.
  const pending = items.filter((it): it is AnswerItem => it.kind === "assistant" && it.conceptsStatus === "running" && !!it.id).map((it) => it.id!).join(",");
  useEffect(() => {
    if (!pending) return;
    const ids = pending.split(",");
    const timer = window.setInterval(() => {
      ids.forEach((id) => getAnswerConcepts(id).then((st) => {
        if (st.status !== "running") {
          patchAnswer((it) => it.id === id, () => ({ concepts: st.concepts, conceptsStatus: st.status, conceptsError: st.error }));
        }
      }).catch(() => {}));
    }, 3000);
    return () => window.clearInterval(timer);
  }, [pending]);

  const visualise = (item: AnswerItem) => {
    if (!item.id) return;
    const id = item.id;
    patchAnswer((it) => it.id === id, () => ({ conceptsStatus: "running", conceptsError: null }));
    visualiseAnswer(id).catch((e: Error) =>
      patchAnswer((it) => it.id === id, () => ({ conceptsStatus: "failed", conceptsError: e.message })));
  };

  const repair = (item: AnswerItem, index: number, error: string) => {
    if (!item.id) return;
    const id = item.id;
    repairAnswerConcept(id, index, error)
      .then((st) => patchAnswer((it) => it.id === id, () => ({ concepts: st.concepts })))
      .catch(() => {});
  };

  const resetView = () => { setTotals(null); setContextPapers([]); setAnswerTokens(0); setStatus(""); };

  const openConversation = async (c: Conversation) => {
    if (running) return;
    setActiveId(c.id);
    setItems([]);
    resetView();
    stick.current = true;
    try {
      setItems(toItems(await getConversationMessages(c.id)));
    } catch {
      setItems([{ kind: "system", key: nextKey(), text: "Could not load this conversation." }]);
    }
  };

  const newConversation = () => {
    if (running) return;
    setActiveId(null);
    setItems([]);
    setAttached([]);
    resetView();
  };

  const askTeammate = async (question: string, userName: string) => {
    const stripped = question.replace(/@user:\S+\s*/gi, "").trim() || question;
    const key = nextKey();
    setItems((xs) => [...xs, { kind: "user", key: nextKey(), text: question },
      { kind: "assistant", key, text: "", steps: [], papers: [], streaming: true, concepts: null, conceptsStatus: null, conceptsError: null }]);
    setRunning(true);
    try {
      const data = await apiFetch<{ message_count: number; answer: string }>(`/users/${encodeURIComponent(userName)}/ask`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: stripped }),
      });
      patchAnswer((it) => it.key === key, () => ({ streaming: false, text: `*Based on ${data.message_count} messages from **${userName}**'s conversations:*\n\n${data.answer}` }));
    } catch (e) {
      patchAnswer((it) => it.key === key, () => ({ streaming: false, error: `Could not ask ${userName}: ${(e as Error).message}` }));
    } finally {
      setRunning(false);
    }
  };

  const send = async (question: string) => {
    if (running) return;
    const teammate = question.match(/@user:(\S+)/i);
    if (teammate) return askTeammate(question, teammate[1]);

    const history = historyOf(items);
    const key = nextKey();
    stick.current = true;
    setItems((xs) => [...xs, { kind: "user", key: nextKey(), text: question },
      { kind: "assistant", key, text: "", steps: [], papers: [], streaming: true, concepts: null, conceptsStatus: null, conceptsError: null }]);
    setRunning(true);
    setAnswerTokens(0);
    const ctl = new AbortController();
    abort.current = ctl;
    let text = "";
    let messageId: string | undefined;
    let convId = activeId;
    let userMessageId: string | undefined;
    let lost = false;
    try {
      for await (const ev of streamKnowledgeChat({
        question, history, model, conversation_id: activeId ?? undefined, use_web: useWeb,
        paper_ids: attached.map((p) => p.id),
      }, ctl.signal)) {
        if (ev.type === "status") setStatus(ev.text);
        else if (ev.type === "step") {
          if (ev.description === "Sending to Claude…" || ev.description.startsWith("Parsing @mentions")) continue;
          const step: Step = { kind: ev.kind, description: ev.description, cypher: ev.cypher, count: ev.count, papers: ev.papers };
          patchAnswer((it) => it.key === key, (it) => ({ steps: [...it.steps, step] }));
        } else if (ev.type === "context") {
          setTotals(ev.token_totals);
          setContextPapers(ev.papers);
          patchAnswer((it) => it.key === key, () => ({ papers: ev.papers.map((p) => ({ id: p.id, title: p.title, year: p.year })) }));
        } else if (ev.type === "conversation") {
          convId = ev.conversation_id;
          userMessageId = ev.user_message_id;
          if (!activeId) { setActiveId(ev.conversation_id); refreshList(); }
        } else if (ev.type === "token") {
          text += ev.text;
          setAnswerTokens(Math.ceil(text.length / 4));
          const now = text;
          patchAnswer((it) => it.key === key, () => ({ text: now }));
        } else if (ev.type === "done") {
          messageId = ev.message_id;
          setActiveId(ev.conversation_id);
          patchAnswer((it) => it.key === key, () => ({ id: ev.message_id, streaming: false }));
        } else if (ev.type === "error") {
          patchAnswer((it) => it.key === key, () => ({ error: ev.message, streaming: false }));
        }
      }
    } catch (e) {
      if (ctl.signal.aborted) patchAnswer((it) => it.key === key, () => ({ stopped: true }));
      else if (convId && userMessageId) lost = true;
      else patchAnswer((it) => it.key === key, () => ({ error: (e as Error).message || "Chat failed" }));
    } finally {
      patchAnswer((it) => it.key === key, () => ({ streaming: false }));
      setRunning(false);
      setStatus("");
      abort.current = null;
      refreshList();
    }
    if (lost && convId && userMessageId) {
      // The connection dropped mid-answer; the server keeps going and saves it.
      patchAnswer((it) => it.key === key, () => ({ reconnecting: true }));
      setRunning(true);
      const saved = await awaitSavedAnswer(convId, userMessageId);
      setRunning(false);
      if ("error" in saved) {
        patchAnswer((it) => it.key === key, () => ({ reconnecting: false, error: saved.error }));
      } else {
        messageId = saved.id;
        text = saved.content;
        patchAnswer((it) => it.key === key, (it) => ({ ...answerOf(saved), key, steps: it.steps, reconnecting: false }));
      }
      refreshList();
    }
    if (messageId && autoConcepts && text.length > 400) {
      const id = messageId;
      patchAnswer((it) => it.id === id, () => ({ conceptsStatus: "running" }));
      visualiseAnswer(id).catch((e: Error) => patchAnswer((it) => it.id === id, () => ({ conceptsStatus: "failed", conceptsError: e.message })));
    }
  };

  const stop = () => abort.current?.abort();

  // ── Forks ──
  const active = conversations.find((c) => c.id === activeId) ?? null;
  const fork = async (keep: number, kind: "strand" | "edit", text?: string) => {
    if (!activeId || running) return;
    try {
      const c = await forkConversation(activeId, keep, kind);
      await refreshList();
      await openConversation(c);
      if (text != null) setDraft({ text, n: Date.now() });
    } catch { /* stays on the current chat */ }
  };
  const asBranch = (c: Conversation): Branch => ({ id: c.id, at: c.fork_at ?? 0, label: c.branch_label ?? "", kind: c.fork_kind === "edit" ? "edit" : "strand" });
  const children = conversations.filter((c) => c.parent_id && c.parent_id === activeId).map(asBranch);
  const self = active?.parent_id ? asBranch(active) : undefined;
  const parent = active?.parent_id ? conversations.find((c) => c.id === active.parent_id) : undefined;
  const openById = (id: string) => { const c = conversations.find((x) => x.id === id); if (c) openConversation(c); };

  const compact = async () => {
    if (!activeId) return;
    setCompacting(true);
    try {
      await compactConversation(activeId);
      setItems(toItems(await getConversationMessages(activeId)));
      refreshList();
    } finally {
      setCompacting(false);
    }
  };

  const links: ChatLinks = useMemo(() => ({
    openPaper: (id, title) => setPreview({ kind: "paper", id, title }),
    openFigure: (src, caption) => setPreview({ kind: "figure", src, caption }),
  }), []);
  const openPaper = (p: MessagePaper) => setPreview({ kind: "paper", id: p.id, title: p.title ?? "" });

  let turn = 0;
  const questions = items.filter((it) => it.kind === "user").length;

  return (
    <ChatLinksContext.Provider value={links}>
      <div className={`kchat ${preview ? "with-preview" : ""}`}>
        <aside className="kc-rail">
          <div className="kc-brand"><span className="kc-brand-mark" />Knowledge Chat</div>
          <ConversationList
            conversations={conversations}
            current={activeId}
            onPick={openConversation}
            onNew={newConversation}
            onRename={(c, title) => renameConversation(c.id, title).then(refreshList).catch(() => {})}
            onDelete={(c) => deleteConversation(c.id).then(() => { if (c.id === activeId) newConversation(); refreshList(); }).catch(() => {})}
          />
        </aside>

        <main className="kc-main">
          <header className="kc-topbar">
            <div className="kc-title">
              {parent && (
                <button type="button" className="kc-crumb" onClick={() => openById(parent.id)} title="Back to the conversation this strand came from">
                  ↑ {parent.title}
                </button>
              )}
              <h1>{active ? (active.parent_id ? active.branch_label || "New strand" : active.title) : "New conversation"}</h1>
            </div>
            {activeId && (
              <button type="button" className="kc-mini" onClick={compact} disabled={compacting || running}
                title="Summarise older turns into working memory to free up context">
                {compacting ? "compacting…" : "compact"}
              </button>
            )}
            <span className="kc-model-pill" title="Model of the next answer">{CHAT_MODEL_LABELS[model]}</span>
          </header>
          <ContextStrip totals={totals} papers={contextPapers} answerTokens={answerTokens} onPaper={openPaper} />

          <div className="kc-scroll" ref={scroller} onScroll={onScroll}>
            <div className={`thread ${items.length ? "with-lane" : ""}`} ref={thread}>
              {items.length > 0 && (
                <BranchLane thread={thread} version={items} turns={questions} running={running} self={self}
                  parentTitle={parent?.title} children={children} onOpen={(b) => openById(b.id)}
                  onOpenParent={() => parent && openById(parent.id)} />
              )}
              {!items.length && (
                <div className="kc-hero">
                  <span className="kc-kicker accent">Knowledge Chat</span>
                  <h2>Ask your library anything.</h2>
                  <p>
                    Answers draw on your papers, notes and the knowledge graph, cite the papers they use, and can show
                    formulas, graphs and animations as interactive concept cards, and molecules in 3D. Scope a question
                    with <code>@project:</code>, <code>@topic:</code>, <code>@tag:</code>, <code>@paper:</code> or{" "}
                    <code>@person:</code>, ask a teammate with <code>@user:</code>, or attach papers with <b>+ paper</b>.
                  </p>
                  <div className="kc-starters">
                    {STARTERS.map((s) => (
                      <button type="button" key={s.label} onClick={() => setDraft({ text: s.text, n: Date.now() })}>
                        <span className="kc-kicker">{s.label}</span>
                        <span>{s.text}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {items.map((it) => {
                if (it.kind === "system") {
                  return <div key={it.key} className="kc-note kc-compacted">Earlier turns compacted into working memory.</div>;
                }
                if (it.kind === "user") {
                  const k = turn++;
                  return (
                    <div key={it.key} className="msg user" data-turn={k}>
                      <div className="bubble-row">
                        {activeId && !running && (
                          <span className="turn-tools">
                            <button type="button" className="kc-mini" onClick={() => fork(k, "edit", it.text)}
                              title="Fork just before this question and edit it; this conversation stays as it is"><ForkIcon /> edit</button>
                            <button type="button" className="kc-mini" onClick={() => fork(k + 1, "strand")}
                              title="Spin a new strand off after this answer and continue there"><ForkIcon /> strand</button>
                          </span>
                        )}
                        <div className="user-text">{it.text}</div>
                      </div>
                    </div>
                  );
                }
                return <Answer key={it.key} item={it} onPaper={openPaper} onVisualise={visualise} onRepair={repair} />;
              })}
              {running && status && <div className="kc-working"><span className="kc-spinner" /> {status}</div>}
            </div>
          </div>

          <Composer
            entities={entities}
            attached={attached}
            onAttach={(p) => setAttached((xs) => (xs.some((x) => x.id === p.id) ? xs : [...xs, p]))}
            onDetach={(id) => setAttached((xs) => xs.filter((x) => x.id !== id))}
            onSend={send}
            onStop={stop}
            running={running}
            models={models}
            model={model}
            onModel={setModel}
            useWeb={useWeb}
            onUseWeb={setUseWeb}
            autoConcepts={autoConcepts}
            onAutoConcepts={setAutoConcepts}
            draft={draft}
          />
        </main>

        {preview && <PreviewPane preview={preview} onClose={() => setPreview(null)} onOpen={setPreview} />}
      </div>
    </ChatLinksContext.Provider>
  );
}
