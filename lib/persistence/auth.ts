export function authenticatedUserId(request: Request): string | null {
  const userId = request.headers.get("oai-authenticated-user-id");
  if (userId) return userId;
  try {
    const hostname = new URL(request.url).hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return "local-development-user";
  } catch {
    return null;
  }
  return null;
}

