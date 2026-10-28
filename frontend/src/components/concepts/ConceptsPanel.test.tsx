import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../../api/client";
import type { Concept } from "../../types";
import type { ConceptGeneration } from "../../types";
import ConceptsPanel from "./ConceptsPanel";
import { mergePolled } from "./mergePolled";

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual, detectConcepts: vi.fn(), generateConceptViz: vi.fn(), repairConceptViz: vi.fn(),
    generateAllConcepts: vi.fn(), listConcepts: vi.fn(),
  };
});

// jsdom has no ResizeObserver or canvas
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
HTMLCanvasElement.prototype.getContext = () => null;

const concept = (over: Partial<Concept>): Concept => ({
  id: "c1", page: 0, position: 0, label: "EDM loss", type: "formula", anchor: "the EDM loss",
  anchor_found: true, context: "The EDM training loss.", spec: null, spec_error: null, ...over,
});

const FORMULA = { type: "formula" as const, title: "EDM loss", caption: "Weighted denoising loss.", main_latex: "L", steps: [] };
const BAD_GRAPH = { type: "graph" as const, title: "Schedule", caption: "", chart_type: "lines" as const,
  x_label: "t", y_label: "σ", data_json: "{broken" };

function Harness({ initial, onActivate = () => {}, initialGeneration = null }: {
  initial: Concept[]; onActivate?: (c: Concept | null) => void; initialGeneration?: ConceptGeneration | null;
}) {
  const [concepts, setConcepts] = useState(initial);
  const [generation, setGeneration] = useState(initialGeneration);
  const [activeId, setActiveId] = useState<string | null>(null);
  return (
    <ConceptsPanel
      paperId="p1" hasPdf concepts={concepts} backend="claude-code" onConceptsChange={setConcepts}
      generation={generation} onGenerationChange={setGeneration}
      activeId={activeId} onActivate={(c) => { setActiveId(c?.id ?? null); onActivate(c); }}
    />
  );
}

describe("ConceptsPanel", () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

  it("lists concepts by page and names the model", () => {
    render(<Harness initial={[concept({}), concept({ id: "c2", page: 4, label: "PF ODE", type: "2d-anim" })]} />);
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(screen.getByText("Page 5")).toBeInTheDocument();
    expect(screen.getByText("anim")).toBeInTheDocument();
    expect(screen.getByText(/Claude Opus \(subscription\)/)).toBeInTheDocument();
  });

  it("scans the PDF when asked", async () => {
    vi.mocked(client.detectConcepts).mockResolvedValue({
      concepts: [concept({})], backend: "claude-code", generation: null, pages_total: 120, pages_scanned: 80,
    });
    render(<Harness initial={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Find concepts" }));
    expect(await screen.findByText("EDM loss")).toBeInTheDocument();
    expect(screen.getByText("Scanned the first 80 of 120 pages.")).toBeInTheDocument();
  });

  it("generates a visualisation the first time a concept is opened", async () => {
    vi.mocked(client.generateConceptViz).mockResolvedValue(concept({ spec: FORMULA }));
    const onActivate = vi.fn();
    render(<Harness initial={[concept({})]} onActivate={onActivate} />);
    await userEvent.click(screen.getByText("EDM loss"));
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: "c1", page: 0 }));
    expect(await screen.findByText("Weighted denoising loss.")).toBeInTheDocument();
    expect(client.generateConceptViz).toHaveBeenCalledWith("p1", "c1");
  });

  it("does not regenerate a concept that already has a spec", async () => {
    render(<Harness initial={[concept({ spec: FORMULA })]} />);
    await userEvent.click(screen.getByText("EDM loss"));
    expect(await screen.findByText("Weighted denoising loss.")).toBeInTheDocument();
    expect(client.generateConceptViz).not.toHaveBeenCalled();
  });

  it("repairs a visualisation that fails to render, then gives up", async () => {
    // Every repair returns another broken graph.
    vi.mocked(client.repairConceptViz).mockImplementation(async () =>
      concept({ type: "graph", spec: { ...BAD_GRAPH, data_json: `{broken ${Math.random()}` } }),
    );
    render(<Harness initial={[concept({ type: "graph", label: "Schedule", spec: BAD_GRAPH })]} />);
    await userEvent.click(screen.getByText("Schedule"));
    await waitFor(() => expect(screen.getByText(/gave up after 2 repair attempts/)).toBeInTheDocument());
    expect(client.repairConceptViz).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.repairConceptViz).mock.calls[0][2]).toMatch(/Could not parse graph data_json/);
  });

  it("asks for every visualisation with the scan by default, and remembers opting out", async () => {
    vi.mocked(client.detectConcepts).mockResolvedValue({
      concepts: [concept({})], backend: "claude-code", generation: null, pages_total: 3, pages_scanned: 3,
    });
    const { unmount } = render(<Harness initial={[]} />);
    const box = screen.getByRole("checkbox", { name: /Generate all visualisations/ });
    expect(box).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Find concepts" }));
    expect(client.detectConcepts).toHaveBeenLastCalledWith("p1", true);
    await userEvent.click(box);
    unmount();
    render(<Harness initial={[]} />);
    expect(screen.getByRole("checkbox", { name: /Generate all visualisations/ })).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Find concepts" }));
    expect(client.detectConcepts).toHaveBeenLastCalledWith("p1", false);
  });

  it("shows progress and picks up finished visualisations while the job runs", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(client.listConcepts).mockResolvedValue({
        concepts: [concept({ spec: FORMULA }), concept({ id: "c2", label: "PF ODE" })],
        backend: "claude-code", generation: { total: 2, done: 2, failed: 0, running: false },
      });
      render(<Harness initial={[concept({}), concept({ id: "c2", label: "PF ODE" })]}
                      initialGeneration={{ total: 2, done: 0, failed: 0, running: true }} />);
      expect(screen.getByText(/Generating visualisations: 0 of 2/)).toBeInTheDocument();
      expect(screen.queryByTitle("Visualisation ready")).toBeNull();
      await vi.advanceTimersByTimeAsync(3100);
      await waitFor(() => expect(screen.getAllByTitle("Visualisation ready")).toHaveLength(1));
      expect(screen.queryByText(/Generating visualisations/)).toBeNull();
      // The job is over; one concept is still missing, so the manual button appears.
      expect(screen.getByRole("button", { name: "Generate all (1 missing)" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the job for the missing visualisations on request", async () => {
    vi.mocked(client.generateAllConcepts).mockResolvedValue({
      concepts: [concept({})], backend: "claude-code", generation: { total: 1, done: 0, failed: 0, running: true },
    });
    vi.mocked(client.listConcepts).mockResolvedValue({ concepts: [concept({})], backend: "claude-code", generation: null });
    render(<Harness initial={[concept({})]} />);
    await userEvent.click(screen.getByRole("button", { name: "Generate all (1 missing)" }));
    expect(client.generateAllConcepts).toHaveBeenCalledWith("p1");
    expect(await screen.findByText(/Generating visualisations: 0 of 1/)).toBeInTheDocument();
  });

  it("marks a concept whose generation failed", () => {
    render(<Harness initial={[concept({ spec_error: "bad spec" })]} />);
    expect(screen.getByTitle("Generation failed: bad spec")).toBeInTheDocument();
  });
});

describe("mergePolled", () => {
  it("keeps unchanged concepts as the same objects so animations keep running", () => {
    const a = concept({ id: "a", spec: FORMULA });
    const b = concept({ id: "b" });
    const polled = [concept({ id: "a", spec: { ...FORMULA } }), concept({ id: "b", spec: FORMULA })];
    const merged = mergePolled([a, b], polled);
    expect(merged[0]).toBe(a);
    expect(merged[1]).toBe(polled[1]);
  });

  it("takes the server's list when the set of concepts changed", () => {
    const polled = [concept({ id: "x" })];
    expect(mergePolled([concept({ id: "a" })], polled)).toBe(polled);
  });
});
