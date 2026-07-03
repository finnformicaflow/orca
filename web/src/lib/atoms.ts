import { atomWithStorage } from "jotai/utils";

// New-draft composer state, persisted to localStorage so a reload never loses an in-progress prompt.
export const draftPromptAtom = atomWithStorage("orca.draftPrompt", "");
export const draftRepoAtom = atomWithStorage("orca.draftRepo", "");
