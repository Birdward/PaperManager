import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatLinksContext, Markdown } from "./Markdown";

// The 3D viewer itself is covered in StructureView.test.tsx; here only the routing of the block.
vi.mock("./structure/StructureView", () => ({
  StructureView: ({ spec }: { spec: { models: { pdb?: string }[]; title?: string } }) => (
    <div data-testid="structure">{spec.title ?? spec.models.map((m) => m.pdb).join(",")}</div>
  ),
}));

const ID = "c7d9ec3d-0df1-4c18-970f-7f6dc34e5e3e";

function renderMd(text: string, links = { openPaper: vi.fn(), openFigure: vi.fn() }, streaming = false) {
  const r = render(<ChatLinksContext.Provider value={links}><Markdown text={text} streaming={streaming} /></ChatLinksContext.Provider>);
  return { ...r, links };
}

describe("Markdown: maths", () => {
  it("renders inline and display maths with KaTeX, including \\( \\) and \\[ \\]", () => {
    const { container } = renderMd("Inline $x^2$ and \\(y\\).\n\n$$\n\\frac{a}{b}\n$$\n\n\\[ z \\]");
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(4);
    expect(container.querySelectorAll(".katex-display").length).toBe(2);
  });

  it("shows broken LaTeX instead of throwing", () => {
    const { container } = renderMd("$\\frac{a$");
    expect(container.textContent).toContain("frac");
  });
});

describe("Markdown: code, tables, links", () => {
  it("highlights fenced code by language", () => {
    const { container } = renderMd("```python\ndef f(x):\n    return 1\n```");
    expect(container.querySelector("code.hljs, code.language-python")).not.toBeNull();
    expect(container.querySelector(".hljs-keyword")?.textContent).toBe("def");
  });

  it("renders GFM tables", () => {
    const { container } = renderMd("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  it("opens library citations beside the chat with their title", () => {
    const { links } = renderMd(`See [**RFdiffusion**](/paper/${ID}).`);
    fireEvent.click(screen.getByText("RFdiffusion"));
    expect(links.openPaper).toHaveBeenCalledWith(ID, "RFdiffusion");
  });

  it("sends other links to a new tab", () => {
    renderMd("[docs](https://example.org/x)");
    const a = screen.getByText("docs");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noreferrer");
  });

  it("does not turn look-alike paths into citations", () => {
    const { container } = renderMd("[x](/paper/not-a-uuid)");
    expect(container.querySelector("a.kc-cite")).toBeNull();
  });
});

describe("Markdown: figures", () => {
  it("renders library figures and opens them in the preview", () => {
    const { links } = renderMd(`![Figure 2: overview](/papers/${ID}/figures/f1/image)`);
    const img = screen.getByAltText("Figure 2: overview");
    expect(img.getAttribute("src")).toMatch(new RegExp(`/papers/${ID}/figures/f1/image$`));
    fireEvent.click(img);
    expect(links.openFigure).toHaveBeenCalledWith(img.getAttribute("src"), "Figure 2: overview");
  });

  it("refuses images from other paths and says so", () => {
    renderMd("![secret](/auth/me)");
    expect(screen.getByText("figure not shown")).toBeInTheDocument();
    expect(screen.queryByAltText("secret")).toBeNull();
  });

  it("swaps an image that fails to load for a note", () => {
    renderMd("![remote](https://example.org/missing.png)");
    fireEvent.error(screen.getByAltText("remote"));
    expect(screen.getByText("figure not shown")).toBeInTheDocument();
  });
});

describe("Markdown: concept and structure blocks", () => {
  it("renders a concept block as a card", () => {
    renderMd('```concept\n{"type": "formula", "title": "Pythagoras", "main_latex": "a^2+b^2=c^2", "steps": [{"latex": "c", "explanation": "the hypotenuse"}]}\n```');
    expect(screen.getByText("Pythagoras")).toBeInTheDocument();
    expect(screen.getByText("the hypotenuse")).toBeInTheDocument();
  });

  it.each([
    ['{"type": "formula", "main_'],
    ['{"type": "3d", "code": "x"}'],
    ["not json at all"],
    ["[]"],
  ])("keeps a malformed concept block as a placeholder while streaming: %s", (src) => {
    const { container } = renderMd("```concept\n" + src + "\n```\nAfter.", undefined, true);
    expect(container.querySelector(".kc-card-pending")?.textContent).toContain("concept");
    expect(screen.getByText("After.")).toBeInTheDocument();
  });

  it("shows a cut-off concept block with its text once the answer has finished", () => {
    const { container } = renderMd('```concept\n{"type": "formula", "main_\n```');
    expect(container.querySelector(".kc-card-pending")).toBeNull();
    expect(container.querySelector(".kc-card-broken")?.textContent).toContain("concept card cut off");
    expect(container.querySelector(".kc-card-broken pre")?.textContent).toContain('"main_');
  });

  it("renders a structure block (PDB id and JSON spec)", async () => {
    renderMd("```structure\n6VXX\n```\n\n```structure\n{\"title\": \"Spike\", \"models\": [{\"pdb\": \"6VXX\"}]}\n```");
    expect(await screen.findByText("6VXX")).toBeInTheDocument();
    expect(await screen.findByText("Spike")).toBeInTheDocument();
  });

  it.each([['{"models": ['], ["just words"], ['{"title": "no models"}']])(
    "keeps a malformed structure block as a placeholder while streaming: %s", async (src) => {
      const { container } = renderMd("```structure\n" + src + "\n```\nAfter.", undefined, true);
      expect(await screen.findByText("After.")).toBeInTheDocument();
      expect(container.querySelector('[data-testid="structure"]')).toBeNull();
      expect(container.querySelector(".kc-card-pending")?.textContent).toContain("structure");
    },
  );

  it("shows an unclosed structure block and the text swallowed by it once the answer has finished", async () => {
    // A reply stopped mid-card leaves the fence open, so everything after it lands inside.
    const { container } = renderMd('```structure\n{"models": [{"pdb": "5C5P", "color": "viol\n\nThe answer was stopped.');
    await screen.findByText(/structure card cut off/);
    expect(container.querySelector('[data-testid="structure"]')).toBeNull();
    expect(container.querySelector(".kc-card-broken pre")?.textContent).toContain("The answer was stopped.");
  });

  it("leaves other fenced blocks as code", () => {
    const { container } = renderMd("```json\n{\"type\": \"formula\"}\n```");
    expect(container.querySelector("pre code")).not.toBeNull();
    expect(container.querySelector(".kc-card")).toBeNull();
  });
});
