import { atomWithStorage } from "jotai/utils";

// New-draft composer state, persisted to localStorage so a reload never loses an in-progress prompt.
export const draftPromptAtom = atomWithStorage("orca.draftPrompt", "");
export const draftRepoAtom = atomWithStorage("orca.draftRepo", "");

// Board repo filter ("all" or a repo name), persisted. Scopes the board + the Done-lane copy.
export const repoFilterAtom = atomWithStorage("orca.repoFilter", "all");
