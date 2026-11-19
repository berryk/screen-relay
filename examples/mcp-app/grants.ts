import { z } from "zod";
import { isLoopback } from "../../dist/protocol/index.js";

const grantId = z.string().regex(/^[1-9][0-9]{0,19}$/).refine((id) => id.length < 20 || (id.length === 20 && id <= "18446744073709551615"));
const grantResponse = z.object({
  id: grantId,
  token: z.string().regex(/^[0-9a-f]{64}$/),
  scope: z.enum(["watch", "control"]),
  expires_in: z.number().int().min(1).max(3600),
});

export async function mintGrant(origin: URL, owner: string, scope: "watch" | "control") {
  if (origin.protocol !== "https:" && !isLoopback(origin.hostname)) throw new Error("The relay must use HTTPS outside loopback.");
  const requestedAt = Date.now();
  const response = await fetch(new URL(`/grants/${scope}`, origin), {
    method: "POST",
    headers: { Authorization: `Bearer ${owner}` },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Could not issue a viewer grant (HTTP ${response.status}).`);
  const body: unknown = await response.json();
  const id = grantId.safeParse((body as { id?: unknown } | null)?.id);
  try {
    const grant = grantResponse.parse(body);
    if (grant.scope !== scope || grant.token === owner) throw new Error("The relay returned an invalid viewer grant.");
    const expiresAt = requestedAt + grant.expires_in * 1000;
    if (expiresAt <= Date.now()) throw new Error("The viewer grant expired before it could be used. Call open_desktop again.");
    const refreshAt = expiresAt - Math.min(30_000, grant.expires_in * 100);
    return { id: grant.id, token: grant.token, scope: grant.scope, expiresAt, refreshAt, revokeUntil: Date.now() + grant.expires_in * 1000 };
  } catch (error) {
    if (id.success) await revokeGrant(origin, owner, id.data);
    throw error;
  }
}

export async function revokeGrant(origin: URL, owner: string, id: string): Promise<void> {
  try {
    await fetch(new URL(`/grants/${id}`, origin), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${owner}` },
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}
