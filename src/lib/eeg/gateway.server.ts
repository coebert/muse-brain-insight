/**
 * Shared Lovable AI Gateway streaming helper for server functions: posts a
 * responses-API request and returns the concatenated output text.
 */
export async function streamGatewayText(body: unknown, apiKey: string): Promise<string> {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": apiKey,
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify(body),
    // A hung gateway must not hold the bedside request open indefinitely.
    signal: AbortSignal.timeout(90_000),
  });

  if (res.status === 429) throw new Error("AI rate limit reached — please try again shortly.");
  if (res.status === 402)
    throw new Error("AI credits exhausted. Add credits in Settings → Plans & credits.");
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`AI analysis failed (${res.status}). ${detail.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload) as {
          type?: string;
          delta?: string;
          response?: { output_text?: string };
        };
        if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
          text += evt.delta;
        } else if (evt.type === "response.completed" && evt.response?.output_text && !text) {
          text = evt.response.output_text;
        }
      } catch {
        // ignore keep-alive / non-JSON frames
      }
    }
  }
  return text;
}
