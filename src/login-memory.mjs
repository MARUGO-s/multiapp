// 「IDとパスワードを記録する」: the app keeps only the login ID. The password
// is handed to the browser's password manager (iCloud Keychain, Chrome,
// Edge), which stores it encrypted and fills it in; it is never written to
// localStorage, where any script on the page could read it.
export const LOGIN_MEMORY_KEY = "marugo-remembered-login";
const MAX_ID_LENGTH = 200;
const NONE = Object.freeze({ remember: false, loginId: "" });

/** @returns {{ remember: boolean, loginId: string }} */
export function rememberedLogin(storage) {
  try {
    const value = JSON.parse(storage?.getItem(LOGIN_MEMORY_KEY) ?? "null");
    if (
      value?.v !== 1 ||
      typeof value.loginId !== "string" ||
      !value.loginId ||
      value.loginId.length > MAX_ID_LENGTH
    )
      return { ...NONE };
    return { remember: true, loginId: value.loginId };
  } catch {
    return { ...NONE };
  }
}

export function rememberLogin(storage, loginId) {
  const id = String(loginId ?? "").trim();
  try {
    if (!id || id.length > MAX_ID_LENGTH) storage?.removeItem(LOGIN_MEMORY_KEY);
    else storage?.setItem(LOGIN_MEMORY_KEY, JSON.stringify({ v: 1, loginId: id }));
  } catch {
    /* Storage blocked: login still works, the ID is just not remembered. */
  }
}

export function forgetLogin(storage) {
  try {
    storage?.removeItem(LOGIN_MEMORY_KEY);
  } catch {
    /* Storage blocked: nothing was remembered. */
  }
}

// Chrome/Edge/Android: offer the browser's own "save password" for this
// site. Safari has no API for this; it offers to save from the form itself.
export async function storeBrowserPassword(nav, win, loginId, password) {
  const Credential = win?.PasswordCredential;
  if (!Credential || !nav?.credentials?.store) return false;
  try {
    await nav.credentials.store(new Credential({ id: loginId, password, name: loginId }));
    return true;
  } catch {
    return false;
  }
}

// Fill the saved password without a prompt when the browser allows it.
export async function browserPassword(nav, win) {
  if (!win?.PasswordCredential || !nav?.credentials?.get) return null;
  try {
    const credential = await nav.credentials.get({ password: true, mediation: "optional" });
    return credential?.type === "password" && typeof credential.password === "string"
      ? { loginId: credential.id, password: credential.password }
      : null;
  } catch {
    return null;
  }
}
