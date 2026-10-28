import { useSyncExternalStore } from "react";
import { getSession, isCloud, SESSION_EVENT } from "./cloud";

let generation = 0;
let lastCredential = isCloud ? getSession()?.token || "" : "local";
const listeners = new Set<() => void>();
export function authenticationGeneration() {
  const current = isCloud ? getSession()?.token || "" : "local";
  if (current !== lastCredential) {
    lastCredential = current;
    generation++;
  }
  return generation;
}
function changed() {
  authenticationGeneration();
  generation++;
  for (const notify of listeners) notify();
}
window.addEventListener(SESSION_EVENT, changed);
window.addEventListener("storage", changed);
export function assertAuthentication(expected: number) {
  if (expected !== authenticationGeneration())
    throw new Error(
      "認証が変わりました。原音は保持しています。同じアカウントで開き直してください。",
    );
}
export function useAuthenticationGeneration() {
  return useSyncExternalStore((notify) => {
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
    };
  }, authenticationGeneration);
}
