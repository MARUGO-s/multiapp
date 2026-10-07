// These are counts of observed anonymous browser IDs, never people or devices.
// Positive accesses with no observed IDs must not look like zero visitors.
export function browserReferenceCount(uniqueCount, accessCount) {
  return uniqueCount > 0 || accessCount === 0 ? uniqueCount : null;
}

export function formatBrowserReference(uniqueCount, accessCount) {
  const count = browserReferenceCount(uniqueCount, accessCount);
  return count === null ? "未計測・対象外" : `${count.toLocaleString()}件`;
}
