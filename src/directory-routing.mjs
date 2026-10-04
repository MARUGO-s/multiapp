export const directoryIntentKey = "marugo-directory-return";
export function isDirectoryNavigation(search, intent) {
  const params = new URLSearchParams(search);
  return (
    params.get("admin") === "users" ||
    (params.get("account") === "google" && intent === "users")
  );
}
