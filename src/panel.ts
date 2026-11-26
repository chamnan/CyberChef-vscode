import * as crypto from "crypto";
import * as vscode from "vscode";
import { CyberChefServer } from "./server";

export const VIEW_TYPE = "cyberchef";
const TAG = "__cyberchefVscode";

/** Messages exchanged with the CyberChef bridge (media/bridge.js). */
export type ToCyberChef =
    | { type: "setInput"; value: string }
    | { type: "loadFile"; name: string; data: Uint8Array; mime?: string }
    | { type: "setRecipe"; recipe: string; theme?: string }
    | { type: "setTheme"; theme: string }
    | { type: "bake" }
    | { type: "getOutput"; requestId: number }
    | { type: "reload" };

type FromCyberChef =
    | { type: "loading" }
    | { type: "ready" }
    | { type: "output"; requestId: number; value?: string; error?: string }
    | { type: "saveFile"; name: string; data: unknown }
    | { type: "openExternal"; url: string }
    | { type: "state"; hash: string }
    | { type: "clipboardRead"; requestId: number }
    | { type: "clipboardWrite"; text: string }
    | { type: "error"; message: string };

interface PanelState {
    hash?: string;
}

export class CyberChefPanel {
    private static current: CyberChefPanel | undefined;

    private readonly disposables: vscode.Disposable[] = [];
    private ready = false;
    private readyWaiters: Array<() => void> = [];
    private nextRequestId = 1;
    private readonly pendingOutput = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();

    static get instance(): CyberChefPanel | undefined {
        return CyberChefPanel.current;
    }

    /** Opens (or reveals) the single CyberChef panel. */
    static async show(context: vscode.ExtensionContext, server: CyberChefServer, preserveFocus = false): Promise<CyberChefPanel> {
        const existing = CyberChefPanel.current;
        if (existing) {
            existing.panel.reveal(undefined, preserveFocus);
            return existing;
        }
        const beside = vscode.workspace.getConfiguration("cyberchef").get<boolean>("openBeside", false);
        const panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            "CyberChef",
            { viewColumn: beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, preserveFocus },
            CyberChefPanel.webviewOptions()
        );
        return CyberChefPanel.attach(context, server, panel, undefined);
    }

    /** Used by the serializer to restore the panel after a window reload. */
    static async revive(context: vscode.ExtensionContext, server: CyberChefServer, panel: vscode.WebviewPanel, state: PanelState | undefined) {
        panel.webview.options = { enableScripts: true, localResourceRoots: [] };
        await CyberChefPanel.attach(context, server, panel, state);
    }

    static webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
        return { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] };
    }

    private static async attach(
        context: vscode.ExtensionContext,
        server: CyberChefServer,
        panel: vscode.WebviewPanel,
        state: PanelState | undefined
    ): Promise<CyberChefPanel> {
        const instance = new CyberChefPanel(context, panel);
        CyberChefPanel.current = instance;
        void vscode.commands.executeCommand("setContext", "cyberchef.panelOpen", true);
        try {
            const port = await server.start();
            const local = vscode.Uri.parse(`http://127.0.0.1:${port}/`);
            const external = await vscode.env.asExternalUri(local);
            panel.webview.html = instance.getHtml(external.toString(true), state?.hash || "");
        } catch (err) {
            panel.webview.html = instance.getErrorHtml(err instanceof Error ? err.message : String(err));
        }
        return instance;
    }

    private constructor(private readonly context: vscode.ExtensionContext, readonly panel: vscode.WebviewPanel) {
        panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
        panel.onDidDispose(() => this.dispose(), null, this.disposables);
        panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
        vscode.workspace.onDidChangeConfiguration(
            (e) => {
                if (e.affectsConfiguration("cyberchef.theme")) this.syncTheme();
            },
            null,
            this.disposables
        );
        vscode.window.onDidChangeActiveColorTheme(() => this.syncTheme(), null, this.disposables);
    }

    // ----------------------------------------------------------------------------------
    // Public API used by commands
    // ----------------------------------------------------------------------------------

    async post(msg: ToCyberChef): Promise<void> {
        await this.whenReady();
        await this.panel.webview.postMessage({ ...msg, [TAG]: true });
    }

    async getOutput(): Promise<string> {
        await this.whenReady();
        const requestId = this.nextRequestId++;
        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingOutput.delete(requestId);
                reject(new Error("Timed out waiting for CyberChef output."));
            }, 30000);
            this.pendingOutput.set(requestId, {
                resolve: (v) => {
                    clearTimeout(timer);
                    resolve(v);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            });
            void this.panel.webview.postMessage({ type: "getOutput", requestId, [TAG]: true });
        });
    }

    reload(): void {
        this.ready = false;
        void this.panel.webview.postMessage({ type: "reload", [TAG]: true });
    }

    /** Resolves when CyberChef has finished loading inside the panel. */
    whenReady(timeoutMs = 60000): Promise<void> {
        if (this.ready) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("CyberChef did not finish loading.")), timeoutMs);
            this.readyWaiters.push(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    // ----------------------------------------------------------------------------------

    static themeSetting(): string {
        const setting = vscode.workspace.getConfiguration("cyberchef").get<string>("theme", "auto");
        if (setting !== "auto") return setting;
        const kind = vscode.window.activeColorTheme.kind;
        return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast ? "dark" : "classic";
    }

    private syncTheme(): void {
        if (!this.ready) return;
        void this.post({ type: "setTheme", theme: CyberChefPanel.themeSetting() });
    }

    private async onMessage(msg: FromCyberChef): Promise<void> {
        if (!msg || typeof msg !== "object") return;
        switch (msg.type) {
            case "loading":
                this.ready = false;
                break;
            case "ready": {
                this.ready = true;
                this.syncTheme();
                const waiters = this.readyWaiters;
                this.readyWaiters = [];
                waiters.forEach((w) => w());
                break;
            }
            case "output": {
                const pending = this.pendingOutput.get(msg.requestId);
                if (!pending) return;
                this.pendingOutput.delete(msg.requestId);
                if (msg.error !== undefined) pending.reject(new Error(msg.error));
                else pending.resolve(msg.value ?? "");
                break;
            }
            case "saveFile":
                await this.saveFile(msg.name, toBytes(msg.data));
                break;
            case "clipboardRead": {
                let text: string | null = null;
                try {
                    text = await vscode.env.clipboard.readText();
                } catch {
                    text = null;
                }
                void this.panel.webview.postMessage({ type: "clipboardText", requestId: msg.requestId, text, [TAG]: true });
                break;
            }
            case "clipboardWrite":
                if (typeof msg.text === "string") await vscode.env.clipboard.writeText(msg.text);
                break;
            case "openExternal":
                if (/^(https?|mailto):/i.test(msg.url)) {
                    void vscode.env.openExternal(vscode.Uri.parse(msg.url, true));
                }
                break;
            case "error":
                void vscode.window.showErrorMessage(`CyberChef: ${msg.message}`);
                break;
        }
    }

    private async saveFile(name: string, data: Uint8Array): Promise<void> {
        const safeName = (name || "download").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        const defaultUri = folder ? vscode.Uri.joinPath(folder, safeName) : vscode.Uri.file(safeName);
        const target = await vscode.window.showSaveDialog({ defaultUri, saveLabel: "Save", title: "Save CyberChef file" });
        if (!target) return;
        try {
            await vscode.workspace.fs.writeFile(target, data);
            const action = await vscode.window.showInformationMessage(`Saved ${vscode.workspace.asRelativePath(target)}`, "Open");
            if (action === "Open") await vscode.commands.executeCommand("vscode.open", target);
        } catch (err) {
            void vscode.window.showErrorMessage(`Could not save file: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private dispose(): void {
        CyberChefPanel.current = undefined;
        void vscode.commands.executeCommand("setContext", "cyberchef.panelOpen", false);
        this.pendingOutput.forEach((p) => p.reject(new Error("CyberChef panel was closed.")));
        this.pendingOutput.clear();
        while (this.disposables.length) this.disposables.pop()?.dispose();
    }

    private getHtml(baseUrl: string, hash: string): string {
        const nonce = crypto.randomBytes(16).toString("base64");
        const origin = new URL(baseUrl).origin;
        const theme = CyberChefPanel.themeSetting();
        // Pass the theme through CyberChef's own URI parameter so the first paint is right.
        const initialHash = hash || (theme !== "cyberchef" ? `#theme=${encodeURIComponent(theme)}` : "");
        const src = baseUrl + initialHash;
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CyberChef</title>
<style nonce="${nonce}">
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #fff; }
  iframe { border: 0; width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
<iframe id="cyberchef" src="${escapeAttr(src)}" title="CyberChef"
  allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const TAG = ${JSON.stringify(TAG)};
  const ORIGIN = ${JSON.stringify(origin)};
  const BASE = ${JSON.stringify(baseUrl)};
  const frame = document.getElementById("cyberchef");

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (!msg || msg[TAG] !== true) return;

    if (e.source === frame.contentWindow) {
      if (e.origin !== ORIGIN) return;
      if (msg.type === "state") {
        vscode.setState({ hash: msg.hash });
        return;
      }
      if (msg.type === "saveFile" && msg.data instanceof ArrayBuffer) {
        msg.data = new Uint8Array(msg.data);
      }
      vscode.postMessage(msg);
      return;
    }

    // Message from the extension.
    if (msg.type === "reload") {
      const hash = (vscode.getState() || {}).hash || "";
      frame.src = "about:blank";
      setTimeout(() => { frame.src = BASE + hash; }, 0);
      return;
    }
    const transfer = [];
    if (msg.type === "loadFile" && msg.data && msg.data.buffer) {
      const copy = new Uint8Array(msg.data);
      msg.data = copy.buffer;
      transfer.push(copy.buffer);
    }
    frame.contentWindow.postMessage(msg, ORIGIN, transfer);
  });

  // VS Code runs Edit > Copy/Cut/Paste (menu, Command Palette, some key paths) on this
  // document, not inside the CyberChef iframe. Relay them to the bridge.
  const toFrame = (msg) => frame.contentWindow.postMessage(Object.assign({ [TAG]: true }, msg), ORIGIN);
  document.addEventListener("paste", (e) => {
    const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    e.preventDefault();
    if (text) toFrame({ type: "pasteText", text });
  });
  document.addEventListener("copy", (e) => { e.preventDefault(); toFrame({ type: "copyRequest", cut: false }); });
  document.addEventListener("cut", (e) => { e.preventDefault(); toFrame({ type: "copyRequest", cut: true }); });

  frame.addEventListener("load", () => { try { frame.focus(); } catch (_) {} });
})();
</script>
</body>
</html>`;
    }

    private getErrorHtml(message: string): string {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"></head>
<body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 2em;">
<h2>CyberChef could not be started</h2><pre style="white-space: pre-wrap;">${escapeHtml(message)}</pre>
</body></html>`;
    }
}

function toBytes(data: unknown): Uint8Array {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (Array.isArray(data)) return Uint8Array.from(data);
    if (data && typeof data === "object") {
        // Defensive: structured clones that arrive as {0: n, 1: n, ...}
        const values = Object.values(data as Record<string, number>);
        return Uint8Array.from(values);
    }
    return new Uint8Array();
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function escapeAttr(s: string): string {
    return escapeHtml(s);
}
