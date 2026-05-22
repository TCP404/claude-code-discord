/** @module system/cdp-sso — AWS SSO login automation via Chrome CDP. */

const CDP_BASE = "http://127.0.0.1:9222";

interface CdpTab {
  id: string;
  webSocketDebuggerUrl: string;
  url: string;
}

let msgId = 0;

async function cdpSend(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 30000);
    const handler = (ev: MessageEvent) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        ws.removeEventListener("message", handler);
        clearTimeout(timeout);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function closeTab(tabId: string): Promise<void> {
  await fetch(`${CDP_BASE}/json/close/${tabId}`, { method: "PUT" });
}

function connectWs(wsUrl: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", (e) => reject(new Error(`WebSocket error: ${e}`)));
  });
}

/**
 * Open a new Chrome tab and navigate to the URL via CDP Page.navigate.
 * Using Page.navigate instead of /json/new?url= avoids URL encoding issues.
 */
async function openAndNavigate(url: string): Promise<{ tab: CdpTab; ws: WebSocket }> {
  const resp = await fetch(`${CDP_BASE}/json/new?url=${encodeURIComponent("about:blank")}`, {
    method: "PUT",
  });
  if (!resp.ok) throw new Error(`Failed to open tab: ${resp.status}`);
  const tab = await resp.json() as CdpTab;
  const ws = await connectWs(tab.webSocketDebuggerUrl);
  await cdpSend(ws, "Page.enable");
  await cdpSend(ws, "Page.navigate", { url });
  return { tab, ws };
}

/**
 * Perform AWS SSO login by automating the browser via CDP.
 *
 * Flow:
 * 1. `aws sso login --no-browser` outputs an auth URL and starts a local callback server
 * 2. We open the URL in Chrome — AWS SSO auto-redirects (if already authenticated via Google)
 *    back to the local callback, completing the OAuth flow
 * 3. If a consent button appears, we click it
 * 4. The aws process exits successfully once the callback is received
 */
export async function refreshBedrockViaCdp(profile = "enterprise-ai"): Promise<string> {
  const cmd = new Deno.Command("aws", {
    args: ["sso", "login", "--no-browser", "--profile", profile],
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let authUrl = "";

  const startTime = Date.now();
  while (Date.now() - startTime < 10000) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const urlMatch = buffer.match(/https?:\/\/\S+/);
    if (urlMatch) {
      authUrl = urlMatch[0];
      break;
    }
  }
  reader.releaseLock();

  if (!authUrl) {
    child.kill();
    await child.status;
    throw new Error(`Could not extract auth URL. Output: ${buffer.slice(0, 200)}`);
  }

  let tab: CdpTab | null = null;
  let ws: WebSocket | null = null;
  try {
    const result = await openAndNavigate(authUrl);
    tab = result.tab;
    ws = result.ws;

    // Poll for consent buttons that might appear (e.g. "Allow access")
    // AWS SSO may auto-redirect if session is active, or show a consent page
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));

      const evalResult = await cdpSend(ws, "Runtime.evaluate", {
        expression: `(function() {
          const loc = window.location.href;
          // If redirected to the local callback (success) or error page, we're done
          if (loc.startsWith('http://127.0.0.1')) return 'callback_reached';
          if (loc.startsWith('chrome-error://')) return 'callback_reached';

          // Try to click any consent/allow button
          const selectors = [
            '#cli_login_button',
            '#cli_verification_btn',
            'button[type="submit"]',
            'input[type="submit"]',
            'button[data-testid="allow-access-button"]',
          ];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && !el.disabled && el.offsetParent !== null) {
              el.click();
              return 'clicked:' + sel;
            }
          }
          const buttons = [...document.querySelectorAll('button')];
          for (const btn of buttons) {
            const text = (btn.textContent || '').toLowerCase();
            if (text.includes('allow') || text.includes('confirm') || text.includes('approve')) {
              btn.click();
              return 'clicked:text';
            }
          }
          return 'waiting:' + loc.substring(0, 80);
        })()`,
        returnByValue: true,
      }) as { result?: { value?: string } };

      const value = evalResult?.result?.value ?? "";
      if (value === "callback_reached" || value.startsWith("clicked:")) {
        break;
      }
    }

    // Wait for the aws process to complete (callback should have been received)
    const status = await child.status;
    if (!status.success) {
      const stderrReader = child.stderr.getReader();
      const { value: errBytes } = await stderrReader.read();
      stderrReader.releaseLock();
      const stderr = errBytes ? decoder.decode(errBytes) : "unknown error";
      throw new Error(`AWS SSO login failed: ${stderr}`);
    }

    return "AWS SSO login completed via CDP — Bedrock credentials refreshed.";
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    if (tab) await closeTab(tab.id).catch(() => {});
  }
}
