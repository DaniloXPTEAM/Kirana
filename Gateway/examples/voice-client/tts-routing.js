export async function playWithTtsFallback({ usePrimary, primary, fallback, onPrimaryFailure = () => {} }) {
  if (!usePrimary) return fallback();
  try {
    return await primary();
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    onPrimaryFailure(error);
    return fallback(error);
  }
}
