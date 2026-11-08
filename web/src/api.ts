/** Returns true when the server answers the health check. */
export async function checkHealth(fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchFn('/api/v1/health')
    return res.ok
  } catch {
    return false
  }
}
