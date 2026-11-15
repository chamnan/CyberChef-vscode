import * as path from "path";
import * as vscode from "vscode";
import { CyberChefPanel, VIEW_TYPE } from "./panel";
import { extractRecipe } from "./recipe";
import { CyberChefServer } from "./server";

let server: CyberChefServer | undefined;
let lastEditor: vscode.TextEditor | undefined;

/** Max size for "Send File to Input" — CyberChef runs in the webview, so keep it sane. */
const MAX_FILE_BYTES = 500 * 1024 * 1024;

/** Small API returned from activate(), handy for other extensions and integration tests. */
export interface CyberChefApi {
    open(): Promise<void>;
    setInput(value: string): Promise<void>;
    setRecipe(recipe: string): Promise<void>;
    getOutput(): Promise<string>;
}

export function activate(context: vscode.ExtensionContext): CyberChefApi {
    const port = vscode.workspace.getConfiguration("cyberchef").get<number>("server.port", 47817);
    server = new CyberChefServer({
        root: path.join(context.extensionPath, "cyberchef"),
        bridgeScript: path.join(context.extensionPath, "media", "bridge.js"),
        port,
        onPrompt: async (message, defaultValue) => {
            const value = await vscode.window.showInputBox({ title: "CyberChef", prompt: message, value: defaultValue });
            return value === undefined ? null : value;
        },
    });
    const srv = server;

    lastEditor = vscode.window.activeTextEditor;
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((e) => {
            if (e) lastEditor = e;
        }),
        { dispose: () => void srv.stop() }
    );

    const open = (preserveFocus = false) => CyberChefPanel.show(context, srv, preserveFocus);

    const register = (id: string, fn: (...args: any[]) => unknown) =>
        context.subscriptions.push(
            vscode.commands.registerCommand(id, async (...args: any[]) => {
                try {
                    await fn(...args);
                } catch (err) {
                    void vscode.window.showErrorMessage(`CyberChef: ${err instanceof Error ? err.message : String(err)}`);
                }
            })
        );

    register("cyberchef.open", () => open());

    register("cyberchef.sendSelection", async () => {
        const editor = vscode.window.activeTextEditor ?? lastEditor;
        if (!editor) {
            void vscode.window.showWarningMessage("CyberChef: open a text editor first.");
            return;
        }
        const doc = editor.document;
        const selected = editor.selections.filter((s) => !s.isEmpty);
        const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
        const text = selected.length ? selected.map((s) => doc.getText(s)).join(eol) : doc.getText();
        const panel = await open(true);
        await panel.post({ type: "setInput", value: text });
        panel.panel.reveal(undefined, false);
    });

    register("cyberchef.sendFile", async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        let targets = uris && uris.length ? uris : uri ? [uri] : [];
        if (!targets.length) {
            const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Send to CyberChef" });
            if (!picked) return;
            targets = picked;
        }
        const panel = await open(true);
        for (const target of targets) {
            const stat = await vscode.workspace.fs.stat(target);
            if (stat.type & vscode.FileType.Directory) continue;
            if (stat.size > MAX_FILE_BYTES) {
                void vscode.window.showWarningMessage(`CyberChef: ${path.basename(target.path)} is too large to load.`);
                continue;
            }
            const data = await vscode.workspace.fs.readFile(target);
            await panel.post({ type: "loadFile", name: path.posix.basename(target.path), data });
        }
        panel.panel.reveal(undefined, false);
    });

    const requireOutput = async (): Promise<string> => {
        const panel = CyberChefPanel.instance;
        if (!panel) throw new Error("CyberChef is not open.");
        return panel.getOutput();
    };

    register("cyberchef.insertOutput", async () => {
        const output = await requireOutput();
        const editor = vscode.window.activeTextEditor ?? lastEditor;
        if (!editor || editor.document.isClosed) {
            await openInNewEditor(output);
            return;
        }
        const selections = editor.selections;
        const shown = await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
        const ok = await shown.edit((b) => selections.forEach((sel) => b.replace(sel, output)));
        if (!ok) throw new Error("Could not edit the document.");
    });

    register("cyberchef.openOutput", async () => openInNewEditor(await requireOutput()));

    register("cyberchef.copyOutput", async () => {
        const output = await requireOutput();
        await vscode.env.clipboard.writeText(output);
        vscode.window.setStatusBarMessage("$(check) CyberChef output copied", 2500);
    });

    register("cyberchef.loadRecipe", async (recipeArg?: string) => {
        const recipe =
            typeof recipeArg === "string"
                ? recipeArg
                : await vscode.window.showInputBox({
                      title: "Load CyberChef Recipe",
                      prompt: "Paste a recipe in Chef format (e.g. From_Base64('A-Za-z0-9+/=',true)) or JSON, or a CyberChef URL containing #recipe=",
                      ignoreFocusOut: true,
                  });
        if (!recipe) return;
        const panel = await open();
        await panel.post({ type: "setRecipe", recipe: extractRecipe(recipe) });
    });

    register("cyberchef.reload", () => CyberChefPanel.instance?.reload());

    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
                await CyberChefPanel.revive(context, srv, panel, (state as { hash?: string }) || undefined);
            },
        })
    );

    return {
        open: async () => {
            await (await open()).whenReady();
        },
        setInput: async (value) => (await open(true)).post({ type: "setInput", value }),
        setRecipe: async (recipe) => (await open(true)).post({ type: "setRecipe", recipe: extractRecipe(recipe) }),
        getOutput: requireOutput,
    };
}

export async function deactivate(): Promise<void> {
    await server?.stop();
    server = undefined;
}

async function openInNewEditor(content: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ content });
    await vscode.window.showTextDocument(doc, { preview: false });
}
