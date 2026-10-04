import { isTrackingNavigation } from "./qr-routing.mjs";
import { isAccountNavigation } from "./qr-account-routing.mjs";
import {
  isDirectoryNavigation,
  directoryIntentKey,
} from "./directory-routing.mjs";

const initialHash = location.hash;
const accountNavigation = isAccountNavigation(location.search, initialHash);
let directoryIntent = "";
try {
  directoryIntent = sessionStorage.getItem(directoryIntentKey) || "";
} catch {
  /* No storage: use the explicit URL. */
}
window.addEventListener("hashchange", () => {
  if (
    !isAccountNavigation(location.search, location.hash) &&
    (isTrackingNavigation(location.hash) ||
      (!accountNavigation && isTrackingNavigation(initialHash)))
  ) {
    location.reload();
  }
});

// A tracking link must not load the workspace or require a shared login.
if (isDirectoryNavigation(location.search, directoryIntent)) {
  for (const [name, content] of [
    ["robots", "noindex, nofollow"],
    ["referrer", "no-referrer"],
  ]) {
    const meta = document.createElement("meta");
    meta.name = name;
    meta.content = content;
    document.head.append(meta);
  }
  void import("./DirectoryEntry");
} else if (accountNavigation) {
  for (const [name, content] of [
    ["robots", "noindex, nofollow"],
    ["referrer", "no-referrer"],
  ]) {
    const meta = document.createElement("meta");
    meta.name = name;
    meta.content = content;
    document.head.append(meta);
  }
  void import("./Workspace");
} else if (isTrackingNavigation(location.hash)) {
  document.title = "MARUGO QR — サイトへ移動";
  for (const [name, content] of [
    ["robots", "noindex, nofollow"],
    ["referrer", "no-referrer"],
  ]) {
    const meta = document.createElement("meta");
    meta.name = name;
    meta.content = content;
    document.head.append(meta);
  }
  document.getElementById("root")!.innerHTML = `<main class="tracking-screen">
    <section><small>MARUGO QR</small><h1 id="heading">サイトへ移動しています</h1>
    <p id="status" role="status">アクセスを記録しています。少しお待ちください。</p>
    <button id="retry" type="button" hidden>もう一度試す</button></section></main>`;
  void import("./tracking.css");
  const script = document.createElement("script");
  script.type = "module";
  script.src = `${import.meta.env.BASE_URL}marugo/redirect.js`;
  script.onerror = () => {
    document.getElementById("status")!.textContent =
      "転送処理を読み込めませんでした。接続を確認して、ページを再読み込みしてください。";
  };
  document.body.append(script);
} else if (new URLSearchParams(location.search).has("file")) {
  document.title = "MARUGO QR — 公開ファイル";
  for (const [name, content] of [
    ["robots", "noindex, nofollow"],
    ["referrer", "no-referrer"],
  ]) {
    const meta = document.createElement("meta");
    meta.name = name;
    meta.content = content;
    document.head.append(meta);
  }
  void import("./PublicQrFile");
} else {
  void import("./Workspace");
}
