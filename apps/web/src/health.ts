export async function checkHealth(
  signal?: AbortSignal,
  url = "/api/health",
): Promise<void> {
  const response = await fetch(url, {
    signal: signal ?? AbortSignal.timeout(5000),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("status" in body) ||
    body.status !== "ok"
  ) {
    throw new Error("Unexpected health response");
  }
}
