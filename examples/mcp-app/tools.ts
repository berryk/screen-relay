import type { McpServer } from "@modelcontextprotocol/server";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { createClient } from "../../dist/sdk/index.js";
import { originOf, ownerToken, VIEWER_SCOPE } from "./config.ts";
import { mintGrant, revokeGrant } from "./grants.ts";
import { runInSandbox } from "./sandbox.ts";
import { RESOURCE_URI } from "./viewer.ts";

/** Registers the desktop, screenshot, and automation tools on a server. */
export function registerTools(server: McpServer): () => Promise<void> {
  let sessionUrl: string | undefined;
  let grant: Awaited<ReturnType<typeof mintGrant>> | undefined;
  let pendingGrant: ReturnType<typeof mintGrant> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  const owned = new Map<string, { origin: URL; owner: string; revokeUntil: number }>();

  registerAppTool(
    server,
    "open_desktop",
    {
      title: "Open desktop",
      description: "Request a screen-relay viewer in the chat. The viewer reports its own connection status.",
      inputSchema: z.object({
        url: z.string().describe("screen-relay viewer URL, for example http://localhost:18080/"),
      }),
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ url }) => {
      if (closed) throw new Error("The MCP session is closed.");
      const viewer = originOf(url);
      if (!grant || grant.refreshAt <= Date.now()) {
        const owner = ownerToken();
        const pending = pendingGrant ??= mintGrant(viewer, owner, VIEWER_SCOPE).then((issued) => {
          for (const [id, item] of owned) if (item.revokeUntil <= Date.now()) owned.delete(id);
          owned.set(issued.id, { origin: viewer, owner, revokeUntil: issued.revokeUntil });
          return issued;
        });
        try {
          grant = await pending;
        } finally {
          if (pendingGrant === pending) pendingGrant = undefined;
        }
      }
      if (closed) throw new Error("The MCP session is closed.");
      sessionUrl = viewer.href;
      return {
        content: [{ type: "text", text: "Viewer access is ready. The inline viewer still needs to connect. Look for Live in the viewer, or use desktop_screenshot for a still image." }],
        _meta: { "relay/viewer": { url: viewer.href, token: grant.token, scope: grant.scope, expiresAt: grant.expiresAt } },
      };
    },
  );

  server.registerTool(
    "desktop_screenshot",
    {
      title: "Desktop screenshot",
      description: "Capture the desktop from the last open_desktop session.",
    },
    async () => {
      if (!sessionUrl) throw new Error("Call open_desktop first");
      const png = await createClient({ url: sessionUrl, token: ownerToken() }).screenshot();
      return {
        content: [{ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" }],
      };
    },
  );

  server.registerTool(
    "desktop_action",
    {
      title: "Desktop action",
      description: "Run an agent-desktop command against the screen-relay desktop, for example [\"snapshot\"].",
      inputSchema: z.object({
        args: z.array(z.string()).describe("Arguments for agent-desktop"),
      }),
    },
    async ({ args }) => runInSandbox("agent-desktop", args),
  );

  server.registerTool(
    "browser_action",
    {
      title: "Browser action",
      description: "Run an agent-browser command inside the screen-relay sandbox, for example [\"open\", \"https://example.com\"].",
      inputSchema: z.object({
        args: z.array(z.string()).describe("Arguments for agent-browser"),
      }),
    },
    async ({ args }) => runInSandbox("/vercel/relay/node_modules/.bin/agent-browser", args),
  );

  return () => {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      await pendingGrant?.catch(() => {});
      await Promise.all([...owned].map(([id, item]) => revokeGrant(item.origin, item.owner, id)));
      owned.clear();
      grant = undefined;
    })();
    return closing;
  };
}
