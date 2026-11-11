// Wraps an async loader so only the most recently *started* call may apply its
// result. /api/jobs is polled from two places (FocusBoard's 10s discovery loop
// and SessionColumn's 3s live loop); without this, a slow response from an older
// request can land after a newer one and roll the list back to stale state.
export function latestOnly(load, apply) {
  let latest = 0;
  return async (...args) => {
    const id = ++latest;
    const result = await load(...args);
    if (id === latest) apply(result);
  };
}
