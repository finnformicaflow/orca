// E2E for multi-format attachments: the chatbox takes ANY file (xml, docx, csv…), not just images,
// by drop or paste, previews non-images as a named chip (no broken <img>), and hands the real File
// objects to onSubmit — which is what store.ts uploads to /api/attachments for the agent to Read.
// Rendered into a real DOM (happy-dom, see tests/happydom.ts) so the drop/paste wiring is exercised.
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatComposer } from "@/components/ChatComposer";
import { withAttachments } from "@/workstream";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
});

function mount(ui: React.ReactElement): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(ui);
  });
  return container;
}

/** Fire a native event carrying an arbitrary payload property (dataTransfer / clipboardData). */
function fire(el: Element, type: string, prop: string, value: unknown) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, prop, { value });
  act(() => { el.dispatchEvent(ev); });
  return ev;
}

test("any file type can be attached, previewed and submitted", async () => {
  const sent: File[][] = [];
  const c = mount(<ChatComposer onSubmit={async (_t, files) => { sent.push(files); }} />);
  const box = c.querySelector<HTMLElement>('[data-slot="chat-composer-toolbar"]')!.parentElement!;

  // Drop a .docx — previously filtered out because its type isn't image/*.
  const docx = new File(["PK"], "spec.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  const dropped = fire(box, "drop", "dataTransfer", { files: [docx] });
  expect(dropped.defaultPrevented).toBe(true);

  // Paste an .xml (clipboard files arrive via items/getAsFile).
  const xml = new File(["<a/>"], "feed.xml", { type: "text/xml" });
  fire(c.querySelector("textarea")!, "paste", "clipboardData", { items: [{ kind: "file", getAsFile: () => xml }] });

  // Non-images render as a named chip, not an <img> that would fail to load.
  const chips = [...c.querySelectorAll('[data-slot="chat-composer-file"]')].map((e) => e.textContent);
  expect(chips).toEqual(["spec.docx", "feed.xml"]);
  expect(c.querySelector("img")).toBeNull();

  const send = c.querySelector<HTMLButtonElement>('button[title^="Send"]')!;
  expect(send.disabled).toBe(false); // files alone are enough to send
  await act(async () => { send.click(); });
  expect(sent[0]?.map((f) => f.name)).toEqual(["spec.docx", "feed.xml"]);

  // …and the launched prompt points the agent at the uploaded paths, whatever the extension.
  expect(withAttachments("go", ["/tmp/x/spec.docx"])).toContain("/tmp/x/spec.docx");
});

test("images still preview as thumbnails", () => {
  const c = mount(<ChatComposer onSubmit={async () => {}} />);
  const box = c.querySelector<HTMLElement>('[data-slot="chat-composer-toolbar"]')!.parentElement!;
  fire(box, "drop", "dataTransfer", { files: [new File(["x"], "shot.png", { type: "image/png" })] });
  expect(c.querySelector("img")?.getAttribute("alt")).toBe("shot.png");
  expect(c.querySelector('[data-slot="chat-composer-file"]')).toBeNull();
});
