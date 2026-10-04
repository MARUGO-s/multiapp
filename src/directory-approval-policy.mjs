// An uncertain response must reuse the same request ID, even after other items succeed.
export function changeOutcome(error) {
  return error?.status >= 400 && error.status < 500 ? "rejected" : "unknown";
}
export function canBatch(rows, action) {
  return (
    rows.length > 0 &&
    rows.length <= 20 &&
    rows.every((row) => row.control?.actions.includes(action))
  );
}
