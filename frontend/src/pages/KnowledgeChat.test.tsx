import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeMessage, SseEvent } from "../types";

const api = vi.hoisted(() => ({
  streamKnowledgeChat: vi.fn(),
  listConversations: vi.fn(async () => [] as unknown[]),
  getConversationMessages: vi.fn(async () => [] as unknown[]),
  visualiseAnswer: vi.fn(async () => ({ status: "running", error: null, concepts: null })),
  getAnswerConcepts: vi.fn(),
  forkConversation: vi.fn(),
  renameConversation: vi.fn(), deleteConversation: vi.fn(), compactConversation: vi.fn(), repairAnswerConcept: vi.fn(),
  apiFetch: vi.fn(async () => []),
  apiUrl: (p: string) => `http://api${p}`,
}));
vi.mock("../api/client", () => api);
vi.mock("../contexts/SettingsContext", () => ({
  useAppSettings: () => ({ settings: { knowledgeChatUseWeb: false } }),
}));

import KnowledgeChat, { awaitSavedAnswer, toItems } from "./KnowledgeChat";

globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
Element.prototype.scrollTo ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const msg = (id: string, role: KnowledgeMessage["role"], content: string, extra: Partial<KnowledgeMessage> = {}): KnowledgeMessage =>
  ({ id, role, content, created_at: id, paper_refs: [], ...extra });

async function* events(list: SseEvent[], fail?: Error) {
  for (const e of list) yield e;
  if (fail) throw fail;
}

const ask = (text: string) => {
  const box = screen.getByLabelText("Question");
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
};

const ANSWER = "## Objective\nThe loss is $\\|x\\|^2$, see [AlphaFold 3](/paper/c7d9ec3d-0df1-4c18-970f-7f6dc34e5e3e).";

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe("KnowledgeChat page", () => {
  it("shows the welcome with starters that fill the composer", () => {
    render(<MemoryRouter><KnowledgeChat /></MemoryRouter>);
    expect(screen.getByText("Ask your library anything.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Explain the maths"));
    expect((screen.getByLabelText("Question") as HTMLTextAreaElement).value).toMatch(/score-matching/);
  });

  it("streams an answer with its steps, citation chips and context, then offers Visualise", async () => {
    api.streamKnowledgeChat.mockReturnValue(events([
      { type: "step", kind: "search", description: "Find diffusion papers", count: 3, papers: [{ id: "p1", title: "DDPM" }] },
      { type: "context", papers: [{ id: "p1", title: "DDPM", tokens: 100, color: "#000" }],
        token_totals: { system: 10, papers: 100, history: 0, question: 5, total: 115, limit: 200000 } },
      { type: "conversation", conversation_id: "c1", user_message_id: "u1" },
      { type: "token", text: ANSWER.slice(0, 20) },
      { type: "token", text: ANSWER.slice(20) },
      { type: "done", conversation_id: "c1", message_id: "a1" },
    ]));
    render(<MemoryRouter><KnowledgeChat /></MemoryRouter>);
    ask("Explain the loss");
    expect(await screen.findByText("✦ Visualise")).toBeInTheDocument();
    expect(screen.getByText("Explain the loss")).toHaveClass("user-text");
    expect(screen.getByText("Find diffusion papers")).toBeInTheDocument();
    expect(document.querySelectorAll(".kc-cite")).toHaveLength(1);
    expect(screen.getByText("Cited")).toBeInTheDocument();
    expect(screen.getByText("1 in context ▸")).toBeInTheDocument();
    expect(api.streamKnowledgeChat.mock.calls[0][0]).toMatchObject({ question: "Explain the loss", history: [], use_web: false, paper_ids: [] });

    fireEvent.click(screen.getByText("✦ Visualise"));
    expect(api.visualiseAnswer).toHaveBeenCalledWith("a1");
    expect(await screen.findByText(/Making concept cards from this answer/)).toBeInTheDocument();
  });

  it("shows an estimate against the 1M window, then Claude's reported size", async () => {
    api.streamKnowledgeChat.mockReturnValue(events([
      { type: "context", papers: [{ id: "p1", title: "Thesis", tokens: 20000, color: "#000" }],
        token_totals: { system: 2000, papers: 20000, history: 0, question: 100, total: 22100, limit: 1_000_000 } },
      { type: "conversation", conversation_id: "c1", user_message_id: "u1" },
      { type: "token", text: "Answer." },
      { type: "context_used", tokens: 190_000, window: 1_000_000, model: "claude-opus-5-5" },
      { type: "done", conversation_id: "c1", message_id: "a1" },
    ]));
    render(<MemoryRouter><KnowledgeChat /></MemoryRouter>);
    ask("What does chapter 4 find?");
    await screen.findByText("✦ Visualise");
    const num = document.querySelector(".kc-context-num")!;
    expect(num.textContent).toMatch(/^190\.0k \/ 1M · 19\.0%$/);  // real figure, no "≈"
    expect(num.getAttribute("title")).toMatch(/claude-opus-5-5/);
    fireEvent.click(num);
    expect(screen.getByText("Read during answer")).toBeInTheDocument();
  });

  it("opens a cited paper in the preview pane", async () => {
    api.streamKnowledgeChat.mockReturnValue(events([{ type: "token", text: ANSWER }, { type: "done", conversation_id: "c1", message_id: "a1" }]));
    render(<MemoryRouter><KnowledgeChat /></MemoryRouter>);
    ask("q");
    fireEvent.click(await screen.findByText("AlphaFold 3", { selector: "a" }));
    expect(await screen.findByLabelText("Preview")).toBeInTheDocument();
    expect(api.apiFetch).toHaveBeenCalledWith("/papers/c7d9ec3d-0df1-4c18-970f-7f6dc34e5e3e");
  });

  it("recovers the saved answer after the connection drops mid-answer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.streamKnowledgeChat.mockReturnValue(events([
      { type: "conversation", conversation_id: "c1", user_message_id: "u1" },
      { type: "token", text: "partial" },
    ], new TypeError("network error")));
    api.getConversationMessages
      .mockResolvedValueOnce([msg("u1", "user", "q")])          // first poll: still being written
      .mockResolvedValue([msg("u1", "user", "q"), msg("a1", "assistant", "The whole saved answer.")]);
    render(<MemoryRouter><KnowledgeChat /></MemoryRouter>);
    ask("q");
    expect(await screen.findByText(/connection lost/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(await screen.findByText("The whole saved answer.")).toBeInTheDocument();
    expect(screen.queryByText(/connection lost/)).toBeNull();
    vi.useRealTimers();
  });

  it("shows a backend error in place of the answer", async () => {
    api.streamKnowledgeChat.mockReturnValue(events([{ type: "error", message: "model unavailable" }]));
    render(<MemoryRouter><KnowledgeChat /></MemoryRouter>);
    ask("q");
    expect(await screen.findByText("model unavailable")).toBeInTheDocument();
  });

  it("forks a strand after an answer and opens it", async () => {
    const parent = { id: "c1", title: "Parent", created_at: "1", updated_at: "1", compacted: false, message_count: 2 };
    const fork = { ...parent, id: "c2", parent_id: "c1", fork_at: 1, fork_kind: "strand" };
    api.listConversations.mockResolvedValue([parent, fork]);
    api.getConversationMessages.mockResolvedValue([msg("u1", "user", "First question"), msg("a1", "assistant", "First answer")]);
    api.forkConversation.mockResolvedValue(fork);
    render(<MemoryRouter><KnowledgeChat /></MemoryRouter>);
    fireEvent.click(await screen.findByText("Parent"));
    fireEvent.click(await screen.findByTitle(/Spin a new strand off/));
    await waitFor(() => expect(api.forkConversation).toHaveBeenCalledWith("c1", 1, "strand"));
    expect(await screen.findByText("↑ Parent")).toBeInTheDocument();
  });
});

describe("toItems / awaitSavedAnswer", () => {
  it("turns stored messages into items, with a failed question's error in place of its answer", () => {
    const items = toItems([
      msg("s", "system", "summary"),
      msg("u1", "user", "q1"), msg("a1", "assistant", "a1", { concepts: [], concepts_status: "done" }),
      msg("u2", "user", "q2", { answer_error: "boom" }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["system", "user", "assistant", "user", "assistant"]);
    expect(items[4]).toMatchObject({ error: "boom", id: undefined });
    expect(items[2]).toMatchObject({ id: "a1", conceptsStatus: "done" });
  });

  it("returns the answer once saved, or the saved error", async () => {
    api.getConversationMessages
      .mockResolvedValueOnce([msg("u1", "user", "q")])
      .mockResolvedValueOnce([msg("u1", "user", "q"), msg("a1", "assistant", "done")]);
    const got = await awaitSavedAnswer("c1", "u1", { every: 1 });
    expect(got).toMatchObject({ id: "a1", content: "done" });
    api.getConversationMessages.mockResolvedValueOnce([msg("u1", "user", "q", { answer_error: "boom" })]);
    expect(await awaitSavedAnswer("c1", "u1", { every: 1 })).toEqual({ error: "boom" });
  });

  it("gives up after its timeout", async () => {
    api.getConversationMessages.mockResolvedValue([msg("u1", "user", "q")]);
    const got = await awaitSavedAnswer("c1", "u1", { every: 1, timeout: 20 });
    expect(got).toHaveProperty("error");
  });
});
