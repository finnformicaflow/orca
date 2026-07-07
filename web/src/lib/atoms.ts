import { atomWithStorage } from "jotai/utils";

// New-draft composer's selected repo, persisted. The prompt + attachments are persisted by
// ChatComposer itself (see lib/composerDraft), so a reload never loses an in-progress draft.
export const draftRepoAtom = atomWithStorage("orca.draftRepo", "");

// Board repo filter ("all" or a repo name), persisted. Scopes the board + the Done-lane copy.
export const repoFilterAtom = atomWithStorage("orca.repoFilter", "all");

// Board display: side-by-side kanban columns ("board") or lanes stacked as lists ("list"). Persisted.
export const boardViewAtom = atomWithStorage<"board" | "list">("orca.boardView", "board");
