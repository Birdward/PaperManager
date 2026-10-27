import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, it, expect, beforeEach } from "vitest";
import ChatPanel from "./ChatPanel";
import * as client from "../api/client";

vi.mock("../api/client", () => ({
  listPaperConversations: vi.fn().mockResolvedValue([]),
  getPaperConversationMessages: vi.fn().mockResolvedValue([]),
  renamePaperConversation: vi.fn(),
  compactPaperConversation: vi.fn(),
  deletePaperConversation: vi.fn(),
  chatWithPaper: vi.fn(),
  getMyAiKeyStatus: vi.fn().mockResolvedValue({}),
}));

// As the server does: once a new conversation exists, its saved messages are reloaded.
function serverSaves(answer: string) {
  vi.mocked(client.getPaperConversationMessages).mockResolvedValue([
    { id: "m1", role: "user", content: "q", created_at: "", paper_refs: [] },
    { id: "m2", role: "assistant", content: answer, created_at: "", paper_refs: [] },
  ]);
}

async function ask(question: string) {
  render(<ChatPanel paperId="p1" />);
  await userEvent.type(await screen.findByPlaceholderText(/Ask a new question/), `${question}{Enter}`);
}

describe("ChatPanel: long-paper coverage flag", () => {
  beforeEach(() => {
    vi.mocked(client.chatWithPaper).mockReset();
    Element.prototype.scrollIntoView = vi.fn();  // not implemented in jsdom
  });

  it("warns when the answer used only part of a long paper", async () => {
    vi.mocked(client.chatWithPaper).mockResolvedValue({
      answer: "Chapter 4 finds…", conversation_id: "c1",
      coverage: { total_pages: 177, pages_read: "1-46, 59-78", complete: false },
    });
    serverSaves("Chapter 4 finds…");
    await ask("Summarise chapter 4");
    await screen.findByText("Chapter 4 finds…");
    expect(screen.getByText(/Long paper: this answer used PDF pages 1-46, 59-78 of 177/)).toBeInTheDocument();
  });

  it("says nothing when the whole paper was read", async () => {
    vi.mocked(client.chatWithPaper).mockResolvedValue({
      answer: "It introduces Syndirella.", conversation_id: "c2",
      coverage: { total_pages: 51, pages_read: "1-51", complete: true },
    });
    serverSaves("It introduces Syndirella.");
    await ask("What does it do?");
    await screen.findByText("It introduces Syndirella.");
    await waitFor(() => expect(screen.queryByText(/Long paper/)).not.toBeInTheDocument());
  });
});
