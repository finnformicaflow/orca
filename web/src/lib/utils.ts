import { createContext } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Where Radix popovers/menus portal to. Unset = the page's body; the orchestrator's Picture-in-Picture
 *  window sets its own body, or a menu opened there would appear back in the tab. */
export const PortalContainer = createContext<HTMLElement | undefined>(undefined);
