import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { AddressInfo } from "net";

const MIME_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".ttf": "font/ttf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".fnt": "text/plain; charset=utf-8",
    ".gz": "application/gzip",
};

/** Marker that lets the bridge script be injected right before CyberChef's own scripts. */
const BRIDGE_TAG = `<script src="vscode-bridge.js"></script>`;

export interface CyberChefServerOptions {
    /** Directory containing the unpacked CyberChef build (index.html, assets/, modules/...). */
    root: string;
    /** Path of the bridge script injected into index.html. */
    bridgeScript: string;
    /** Preferred port. 0 = random. Falls back to a random port if busy. */
    port: number;
    /**
     * Answers window.prompt() calls made by CyberChef. Webviews block modal dialogs, so the
     * bridge forwards them here with a synchronous request. Resolve null for "cancel".
     */
    onPrompt?: (message: string, defaultValue: string) => Promise<string | null>;
}

/**
 * A tiny static file server bound to the loopback interface only.
 * Serving CyberChef over http (rather than straight from the webview's resource
 * scheme) keeps it same-origin with its web workers and dynamically loaded modules,
 * so it behaves exactly like https://gchq.github.io/CyberChef/ — but fully offline.
 */
export class CyberChefServer {
    private server: http.Server | undefined;
    private startPromise: Promise<number> | undefined;
    private indexHtml: Buffer | undefined;
    /** Per-session secret so only our own CyberChef page can call the prompt endpoint. */
    private readonly token = crypto.randomBytes(24).toString("hex");

    constructor(private readonly options: CyberChefServerOptions) {}

    get port(): number | undefined {
        const addr = this.server?.address() as AddressInfo | null | undefined;
        return addr ? addr.port : undefined;
    }

    start(): Promise<number> {
        if (!this.startPromise) {
            this.startPromise = this.listen().catch((err) => {
                this.startPromise = undefined;
                throw err;
            });
        }
        return this.startPromise;
    }

    async stop(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        this.startPromise = undefined;
        if (server) {
            server.closeAllConnections?.();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }

    private async listen(): Promise<number> {
        if (!fs.existsSync(path.join(this.options.root, "index.html"))) {
            throw new Error(
                `CyberChef build not found in ${this.options.root}. ` +
                    "If you are running from source, run `npm run fetch-cyberchef` first."
            );
        }
        const server = http.createServer((req, res) => this.handle(req, res));
        server.keepAliveTimeout = 5000;
        const tryListen = (port: number) =>
            new Promise<void>((resolve, reject) => {
                const onError = (err: Error) => {
                    server.off("listening", onListening);
                    reject(err);
                };
                const onListening = () => {
                    server.off("error", onError);
                    resolve();
                };
                server.once("error", onError);
                server.once("listening", onListening);
                server.listen(port, "127.0.0.1");
            });
        try {
            await tryListen(this.options.port);
        } catch (err) {
            if (this.options.port === 0) throw err;
            await tryListen(0);
        }
        this.server = server;
        return this.port!;
    }

    private getIndexHtml(): Buffer {
        if (!this.indexHtml) {
            let html = fs.readFileSync(path.join(this.options.root, "index.html"), "utf8");
            // Inject the bridge before any CyberChef script so it can hook downloads early.
            const tags = `<script>window.__cyberchefVscodeToken=${JSON.stringify(this.token)};</script>` + BRIDGE_TAG;
            const firstScript = html.search(/<script\b/i);
            html =
                firstScript >= 0
                    ? html.slice(0, firstScript) + tags + html.slice(firstScript)
                    : html.replace(/<\/head>/i, tags + "</head>");
            this.indexHtml = Buffer.from(html, "utf8");
        }
        return this.indexHtml;
    }

    private handlePrompt(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        const reply = (status: number, value: string | null) => {
            res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ value }));
        };
        const given = Buffer.from(url.searchParams.get("token") || "");
        const expected = Buffer.from(this.token);
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
            return reply(403, null);
        }
        const message = (url.searchParams.get("message") || "").slice(0, 1000);
        const defaultValue = (url.searchParams.get("default") || "").slice(0, 10000);
        if (!this.options.onPrompt) return reply(200, defaultValue);
        this.options.onPrompt(message, defaultValue).then(
            (value) => reply(200, value),
            () => reply(200, null)
        );
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const send = (status: number, body: string) => {
            res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(req.method === "HEAD" ? undefined : body);
        };

        if (req.method !== "GET" && req.method !== "HEAD") {
            res.setHeader("Allow", "GET, HEAD");
            return send(405, "Method Not Allowed");
        }

        let pathname: string;
        try {
            pathname = decodeURIComponent(new URL(req.url || "/", "http://127.0.0.1").pathname);
        } catch {
            return send(400, "Bad Request");
        }

        if (pathname === "/__vscode/prompt") {
            return this.handlePrompt(req, res);
        }

        const common = {
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
        };

        if (pathname === "/" || pathname === "/index.html") {
            const body = this.getIndexHtml();
            res.writeHead(200, { ...common, "Content-Type": MIME_TYPES[".html"], "Content-Length": body.length });
            res.end(req.method === "HEAD" ? undefined : body);
            return;
        }

        let filePath: string;
        if (pathname === "/vscode-bridge.js") {
            filePath = this.options.bridgeScript;
        } else {
            const root = path.resolve(this.options.root);
            filePath = path.resolve(root, "." + pathname);
            if (filePath !== root && !filePath.startsWith(root + path.sep)) {
                return send(403, "Forbidden");
            }
        }

        fs.stat(filePath, (err, stat) => {
            if (err || !stat.isFile()) return send(404, "Not Found");

            const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
            const headers: http.OutgoingHttpHeaders = {
                ...common,
                ETag: etag,
                "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
            };
            if (req.headers["if-none-match"] === etag) {
                res.writeHead(304, headers);
                res.end();
                return;
            }
            headers["Content-Length"] = stat.size;
            res.writeHead(200, headers);
            if (req.method === "HEAD") {
                res.end();
                return;
            }
            const stream = fs.createReadStream(filePath);
            stream.on("error", () => res.destroy());
            stream.pipe(res);
        });
    }
}
