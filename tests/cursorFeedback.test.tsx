// E2E for the "interactive cursor feedback" behaviour (commit 066f3ba): the chatbox reads as one
// text field (cursor-text + click-anywhere-to-focus), while clickable controls read as clickable
// (cursor-pointer). Rendered into a real DOM (happy-dom, see tests/happydom.ts) so we exercise the
// actual mousedown → focus wiring and the emitted class names, not stringly-typed guesses.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatComposer } from "@/components/ChatComposer";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;

function mount(ui: React.ReactElement): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(ui);
  });
  return container;
}

function mouseDown(el: Element): MouseEvent {
  const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(ev);
  });
  return ev;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
});

const composer = (leading?: React.ReactNode) =>
  <ChatComposer onSubmit={async () => {}} leading={leading} />;

describe("chatbox behaves like one text field", () => {
  test("the wrapper carries cursor-text so the caret shows across the whole box", () => {
    const box = mount(composer()).querySelector<HTMLElement>("[class*='cursor-text']");
    expect(box).not.toBeNull();
    // the textarea lives inside that same cursor-text wrapper
    expect(box!.querySelector("textarea")).not.toBeNull();
  });

  test("clicking the chrome (padding/border, not a control) focuses the textarea", () => {
    const c = mount(composer());
    const wrapper = c.querySelector<HTMLElement>("[class*='cursor-text']")!;
    const textarea = c.querySelector("textarea")!;
    expect(document.activeElement).not.toBe(textarea);
    const ev = mouseDown(wrapper); // wrapper itself = chrome, no control under the cursor
    expect(document.activeElement).toBe(textarea);
    // preventDefault keeps any existing caret/selection intact instead of blurring
    expect(ev.defaultPrevented).toBe(true);
  });

  test("clicking the textarea itself is left alone (caret positioning preserved)", () => {
    // The guard skips textarea/button/input, so mousedown default is NOT prevented there — a
    // preventDefault here would stop the browser placing the caret where you clicked.
    const c = mount(composer());
    const ev = mouseDown(c.querySelector("textarea")!);
    expect(ev.defaultPrevented).toBe(false);
  });

  test("clicking a control (send button) does NOT steal focus into the textarea", () => {
    const c = mount(composer());
    const textarea = c.querySelector("textarea")!;
    const sendBtn = c.querySelector('button[title^="Send"]')!;
    mouseDown(sendBtn);
    expect(document.activeElement).not.toBe(textarea);
  });

  test("clicking the repo selector (role=combobox) does NOT steal focus into the textarea", () => {
    // The new-draft box passes a Select as `leading`; its trigger is role=combobox. The focus
    // guard must skip it, else picking a repo would yank the caret into the message field.
    const c = mount(composer(<button role="combobox">repo</button>));
    const textarea = c.querySelector("textarea")!;
    mouseDown(c.querySelector('[role="combobox"]')!);
    expect(document.activeElement).not.toBe(textarea);
  });
});

describe("controls read as clickable (cursor-pointer)", () => {
  test("base Button carries cursor-pointer", () => {
    const btn = mount(<Button>go</Button>).querySelector("button")!;
    expect(btn.className).toContain("cursor-pointer");
  });

  test("the chatbox's own send + attach buttons carry cursor-pointer", () => {
    const c = mount(composer());
    for (const b of c.querySelectorAll("button")) {
      expect(b.className).toContain("cursor-pointer");
    }
  });
});

describe("chatbox toolbar stays within its available width", () => {
  test("the leading controls can shrink while the action group cannot", () => {
    const c = mount(composer(<div>selectors</div>));
    expect(c.querySelector<HTMLElement>('[data-slot="chat-composer-toolbar"]')!.className).toContain("min-w-0");

    const leading = c.querySelector<HTMLElement>('[data-slot="chat-composer-leading"]')!;
    expect(leading.className).toContain("min-w-0");
    expect(leading.className).toContain("flex-1");
    expect(leading.className).toContain("overflow-hidden");

    const actions = c.querySelector<HTMLElement>('[data-slot="chat-composer-actions"]')!;
    expect(actions.className).toContain("shrink-0");
  });

  test("attach remains immediately beside send, including when cancel is present", () => {
    const c = mount(<ChatComposer onSubmit={async () => {}} onCancel={() => {}} />);
    const attach = c.querySelector<HTMLButtonElement>('button[title="Attach files"]')!;
    const send = c.querySelector<HTMLButtonElement>('button[title^="Send"]')!;
    expect(attach.parentElement).toBe(send.parentElement);
    expect(attach.nextElementSibling).toBe(send);
  });

  test("the small select variant truncates its value", () => {
    const c = mount(
      <Select defaultValue="a-long-repository-name">
        <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
      </Select>,
    );
    const trigger = c.querySelector<HTMLElement>('[data-slot="select-trigger"]')!;
    expect(trigger.className).toContain("h-7");
    expect(trigger.className).toContain("[&_[data-slot=select-value]]:truncate");
    expect(trigger.className).toContain("overflow-hidden");
  });
});
