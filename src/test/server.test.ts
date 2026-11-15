/**
 * Plain Node tests (no VS Code needed): `npm test`.
 * Requires the CyberChef build in ./cyberchef (`npm run fetch-cyberchef`).
 */
import * as assert from "assert";
import * as http from "http";
import * as net from "net";
import * as path from "path";
import { extractRecipe } from "../recipe";
import { CyberChefServer } from "../server";

const root = path.resolve(__dirname, "..", "..");

function get(port: number, p: string, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
        // Raw path (no URL normalisation) so traversal attempts reach the server as-is.
        const req = http.request({ host: "127.0.0.1", port, path: p, headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on("error", reject);
        req.end();
    });
}

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

test("extractRecipe handles raw recipes, URLs and hashes", () => {
    assert.strictEqual(extractRecipe("To_Base64('A-Za-z0-9+/=')"), "To_Base64('A-Za-z0-9+/=')");
    assert.strictEqual(
        extractRecipe("https://gchq.github.io/CyberChef/#recipe=From_Base64('A-Za-z0-9%2B/%3D',true)&input=SGVsbG8"),
        "From_Base64('A-Za-z0-9+/=',true)"
    );
    assert.strictEqual(extractRecipe("#recipe=To_Hex('Space',0)"), "To_Hex('Space',0)");
    assert.strictEqual(extractRecipe("Regular_expression('User defined','#\\\\d+')"), "Regular_expression('User defined','#\\\\d+')");
    assert.strictEqual(extractRecipe('  [{"op":"To Hex","args":["Space",0]}]  '), '[{"op":"To Hex","args":["Space",0]}]');
});

test("serves index.html with the bridge injected before CyberChef scripts", async () => {
    const server = new CyberChefServer({ root: path.join(root, "cyberchef"), bridgeScript: path.join(root, "media", "bridge.js"), port: 0 });
    const port = await server.start();
    try {
        for (const p of ["/", "/index.html"]) {
            const res = await get(port, p);
            assert.strictEqual(res.status, 200);
            assert.match(String(res.headers["content-type"]), /text\/html/);
            const html = res.body.toString("utf8");
            const bridge = html.indexOf('<script src="vscode-bridge.js"></script>');
            const firstOther = html.indexOf("<script type=application/javascript>");
            assert.ok(firstOther > 0, "CyberChef preloader script found");
            assert.match(html, /window\.__cyberchefVscodeToken="[0-9a-f]{48}"/);
            assert.ok(bridge >= 0, "bridge tag present");
            assert.ok(bridge < firstOther, "bridge injected before CyberChef's scripts");
        }
        const bridge = await get(port, "/vscode-bridge.js");
        assert.strictEqual(bridge.status, 200);
        assert.match(String(bridge.headers["content-type"]), /javascript/);
    } finally {
        await server.stop();
    }
});

test("serves assets with correct MIME types and ETags", async () => {
    const server = new CyberChefServer({ root: path.join(root, "cyberchef"), bridgeScript: path.join(root, "media", "bridge.js"), port: 0 });
    const port = await server.start();
    try {
        const js = await get(port, "/assets/main.js");
        assert.strictEqual(js.status, 200);
        assert.match(String(js.headers["content-type"]), /javascript/);
        const css = await get(port, "/assets/main.css");
        assert.match(String(css.headers["content-type"]), /text\/css/);
        const mod = await get(port, "/modules/Ciphers.js");
        assert.strictEqual(mod.status, 200);
        const cached = await get(port, "/assets/main.css", { "If-None-Match": String(css.headers.etag) });
        assert.strictEqual(cached.status, 304);
        const lang = await get(port, "/assets/tesseract/lang-data/eng.traineddata.gz");
        assert.strictEqual(lang.status, 200, "tesseract language data kept");
    } finally {
        await server.stop();
    }
});

test("rejects traversal, unknown files and non-GET methods", async () => {
    const server = new CyberChefServer({ root: path.join(root, "cyberchef"), bridgeScript: path.join(root, "media", "bridge.js"), port: 0 });
    const port = await server.start();
    try {
        assert.strictEqual((await get(port, "/../package.json")).status === 200, false);
        assert.notStrictEqual((await get(port, "/%2e%2e/package.json")).status, 200);
        assert.notStrictEqual((await get(port, "/assets/..%2f..%2fpackage.json")).status, 200);
        assert.strictEqual((await get(port, "/nope.js")).status, 404);
        const post = await new Promise<number>((resolve, reject) => {
            const req = http.request({ host: "127.0.0.1", port, path: "/", method: "POST" }, (res) => {
                res.resume();
                resolve(res.statusCode!);
            });
            req.on("error", reject);
            req.end();
        });
        assert.strictEqual(post, 405);
    } finally {
        await server.stop();
    }
});

test("prompt endpoint requires the session token and relays answers", async () => {
    const asked: Array<[string, string]> = [];
    const server = new CyberChefServer({
        root: path.join(root, "cyberchef"),
        bridgeScript: path.join(root, "media", "bridge.js"),
        port: 0,
        onPrompt: async (m, d) => {
            asked.push([m, d]);
            return "42";
        },
    });
    const port = await server.start();
    try {
        const html = (await get(port, "/")).body.toString("utf8");
        const token = /__cyberchefVscodeToken="([0-9a-f]+)"/.exec(html)![1];
        const bad = await get(port, "/__vscode/prompt?token=nope&message=x");
        assert.strictEqual(bad.status, 403);
        assert.strictEqual(asked.length, 0);
        const ok = await get(port, `/__vscode/prompt?token=${token}&message=${encodeURIComponent("Enter tab number (1 - 3):")}&default=1`);
        assert.strictEqual(ok.status, 200);
        assert.deepStrictEqual(JSON.parse(ok.body.toString()), { value: "42" });
        assert.deepStrictEqual(asked, [["Enter tab number (1 - 3):", "1"]]);
    } finally {
        await server.stop();
    }
});

test("falls back to a random port when the preferred port is busy", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const busy = (blocker.address() as net.AddressInfo).port;
    const server = new CyberChefServer({ root: path.join(root, "cyberchef"), bridgeScript: path.join(root, "media", "bridge.js"), port: busy });
    try {
        const port = await server.start();
        assert.notStrictEqual(port, busy);
        assert.strictEqual((await get(port, "/")).status, 200);
    } finally {
        await server.stop();
        blocker.close();
    }
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
        } catch (err) {
            failed++;
            console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.stack : err}`);
        }
    }
    console.log(failed ? `\n${failed} test(s) failed` : `\nAll ${tests.length} tests passed`);
    process.exit(failed ? 1 : 0);
})();
