import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer, type Entities } from "./Composer";

const ENT: Entities = {
  tags: ["deep-learning"], topics: ["Protein Folding", "Diffusion Models"], projects: ["Thesis"], people: ["Yann LeCun"], users: ["alice"],
  papers: [{ id: "p1", title: "Accurate structure prediction with AlphaFold 3", year: 2024 }, { id: "p2", title: "RFdiffusion", year: 2023 }],
};

function setup(over: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const props = {
    entities: ENT, attached: [], onAttach: vi.fn(), onDetach: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), running: false,
    useWeb: true, onUseWeb: vi.fn(), autoConcepts: false, onAutoConcepts: vi.fn(), ...over,
  };
  render(<Composer {...(props as React.ComponentProps<typeof Composer>)} />);
  return { props, box: screen.getByLabelText("Question") as HTMLTextAreaElement };
}

const type = (el: HTMLTextAreaElement, value: string) => {
  fireEvent.change(el, { target: { value, selectionStart: value.length } });
};

describe("Composer", () => {
  it("sends on Enter, keeps Shift+Enter for a newline, and clears", () => {
    const { props, box } = setup();
    type(box, "What is a diffusion model?");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(props.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(props.onSend).toHaveBeenCalledWith("What is a diffusion model?");
    expect(box.value).toBe("");
  });

  it("does not send empty text", () => {
    const { props, box } = setup();
    type(box, "   ");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(props.onSend).not.toHaveBeenCalled();
    expect(screen.getByText("Send")).toBeDisabled();
  });

  it("suggests scopes after @ and inserts the chosen one quoted", () => {
    const { box } = setup();
    type(box, "Compare @topic:prot");
    expect(screen.getByText("Protein Folding")).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe('Compare @topic:"Protein Folding" ');
    expect(screen.getByTitle("papers about the topic")).toHaveTextContent("topicProtein Folding");
  });

  it("walks the suggestions with the arrow keys and closes them on Escape", () => {
    const { box } = setup();
    type(box, "@");
    const options = screen.getAllByRole("button").filter((b) => b.closest(".kc-suggest"));
    expect(options.length).toBeGreaterThan(2);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(options[1]).toHaveClass("on");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(document.querySelector(".kc-suggest")).toBeNull();
  });

  it("attaches a paper picked from the suggestions instead of writing a mention", () => {
    const { props, box } = setup();
    type(box, "Explain @paper:alphafold");
    fireEvent.mouseDown(screen.getByText("Accurate structure prediction with AlphaFold 3"));
    expect(props.onAttach).toHaveBeenCalledWith(ENT.papers[0]);
    expect(box.value).toBe("Explain ");
  });

  it("removes a scope chip from the text", () => {
    const { box } = setup();
    type(box, "@tag:deep-learning what changed?");
    fireEvent.click(screen.getByLabelText("Remove scope"));
    expect(box.value).toBe("what changed?");
  });

  it("attaches papers from the picker and shows them as chips", () => {
    const { props } = setup({ attached: [{ id: "p2", title: "RFdiffusion", year: 2023 }] });
    expect(screen.getByText("RFdiffusion · 2023")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Detach paper"));
    expect(props.onDetach).toHaveBeenCalledWith("p2");
    fireEvent.click(screen.getByText("+ paper"));
    fireEvent.change(screen.getByLabelText("Find a paper"), { target: { value: "alpha" } });
    fireEvent.click(screen.getByText("Accurate structure prediction with AlphaFold 3"));
    expect(props.onAttach).toHaveBeenCalledWith(ENT.papers[0]);
  });

  it("toggles web and concepts", () => {
    const { props } = setup();
    fireEvent.click(screen.getByText("web"));
    expect(props.onUseWeb).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByText("concepts"));
    expect(props.onAutoConcepts).toHaveBeenCalledWith(true);
  });

  it("offers Stop while an answer is running", () => {
    const { props } = setup({ running: true });
    fireEvent.click(screen.getByText("■ Stop"));
    expect(props.onStop).toHaveBeenCalled();
    expect(screen.queryByText("Send")).toBeNull();
  });

  it("takes a draft from outside (an edited question, a starter)", () => {
    const { box } = setup({ draft: { text: "Re-ask this", n: 1 } });
    expect(box.value).toBe("Re-ask this");
  });
});
