import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, Loader2, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";

// The one chat input, shared by the new-draft box and the follow-up box. A single bordered
// "chatbox" (à la Claude/ChatGPT) wrapping image thumbnails, the textarea, and a bottom toolbar
// with the repo selector (via `leading`) on the left and an icon send button on the right.
// Accepts images by paste, drag-drop, or the paperclip picker; ⌘/Ctrl+Enter sends.
export function ChatComposer({
  value, onChange, onSubmit, placeholder, leading, footer, onCancel, autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string, images: File[]) => Promise<void>;
  placeholder?: string;
  leading?: ReactNode; // e.g. the repo selector, sits bottom-left inside the box
  footer?: ReactNode; // transient line below the box, e.g. a "Sent · Undo" affordance
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [images, setImages] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const addImages = (files: Iterable<File>) => {
    const imgs = [...files].filter((f) => f.type.startsWith("image/"));
    if (imgs.length) setImages((prev) => [...prev, ...imgs]);
  };
  const onPaste = (e: ClipboardEvent) => {
    // Pasted screenshots often arrive only via `items` (getAsFile), not `.files`.
    const files = [...e.clipboardData.items]
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => Boolean(f));
    if (files.some((f) => f.type.startsWith("image/"))) { e.preventDefault(); addImages(files); }
  };
  const onDrop = (e: DragEvent) => {
    if ([...e.dataTransfer.files].some((f) => f.type.startsWith("image/"))) { e.preventDefault(); addImages(e.dataTransfer.files); }
  };

  const canSubmit = Boolean(value.trim() || images.length) && !busy;
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value.trim(), images);
      onChange("");
      setImages([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void submit(); }
  };

  return (
    <div>
      <div
        className="bg-card focus-within:border-ring focus-within:ring-ring/50 rounded-md border shadow-sm transition-[color,box-shadow] focus-within:ring-[3px]"
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 p-2 pb-0">
            {images.map((f, i) => <Thumb key={i} file={f} onRemove={() => setImages((p) => p.filter((_, j) => j !== i))} />)}
          </div>
        )}
        <textarea
          autoFocus={autoFocus}
          rows={2}
          className="placeholder:text-muted-foreground field-sizing-content max-h-48 w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
        />
        <div className="flex items-center gap-1 p-2 pt-0">
          {leading}
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addImages(e.target.files ?? []); e.target.value = ""; }} />
          <Button type="button" size="icon" variant="ghost" className="text-muted-foreground size-8" title="Attach images" onClick={() => fileRef.current?.click()}>
            <Paperclip className="size-4" />
          </Button>
          <div className="ml-auto flex items-center gap-1">
            {onCancel && <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
            <Button type="button" size="icon" className="size-8" disabled={!canSubmit} title="Send (⌘+Enter)" onClick={() => void submit()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
            </Button>
          </div>
        </div>
      </div>
      {error && <p className="text-destructive mt-1 px-1 text-xs break-words">{error}</p>}
      {footer}
    </div>
  );
}

function Thumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  // Create + revoke the object URL inside the effect so StrictMode's dev remount doesn't leave a
  // revoked (blank) src behind — the effect re-runs and mints a fresh URL.
  const [url, setUrl] = useState("");
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <div className="group relative size-14 overflow-hidden rounded-md border">
      <img src={url} alt={file.name} className="size-full object-cover" />
      <button
        type="button"
        onClick={onRemove}
        title="Remove"
        className="bg-background/80 text-foreground hover:bg-background absolute top-0.5 right-0.5 rounded-full p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
