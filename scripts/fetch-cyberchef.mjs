#!/usr/bin/env node
/**
 * Downloads the pinned CyberChef release from GitHub and unpacks it into
 * ./cyberchef so it can be bundled into the extension and served offline.
 *
 * Usage:
 *   node scripts/fetch-cyberchef.mjs            # version from package.json "cyberchef.version"
 *   node scripts/fetch-cyberchef.mjs v11.5.0    # explicit tag
 *   node scripts/fetch-cyberchef.mjs --force    # re-download even if already present
 *
 * Set GITHUB_TOKEN to avoid GitHub API rate limits in CI.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "cyberchef");
const stampFile = path.join(outDir, ".version");

const args = process.argv.slice(2);
const force = args.includes("--force");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const tag = args.find((a) => !a.startsWith("--")) || pkg.cyberchef?.version;
if (!tag) {
    console.error("No CyberChef version given and none found in package.json (cyberchef.version).");
    process.exit(1);
}

if (!force && fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8").trim() === tag) {
    console.log(`CyberChef ${tag} already present in ./cyberchef (use --force to re-download).`);
    process.exit(0);
}

const headers = { "User-Agent": "cyberchef-vscode-build", Accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

console.log(`Looking up CyberChef release ${tag}...`);
const relRes = await fetch(`https://api.github.com/repos/gchq/CyberChef/releases/tags/${tag}`, { headers });
if (!relRes.ok) {
    console.error(`GitHub API error ${relRes.status}: ${await relRes.text()}`);
    process.exit(1);
}
const release = await relRes.json();
const asset = release.assets.find((a) => /^CyberChef.*\.zip$/i.test(a.name));
if (!asset) {
    console.error(`No CyberChef zip asset found in release ${tag}.`);
    process.exit(1);
}

console.log(`Downloading ${asset.name} (${(asset.size / 1048576).toFixed(1)} MB)...`);
const zipRes = await fetch(asset.browser_download_url, { headers: { "User-Agent": headers["User-Agent"] } });
if (!zipRes.ok) {
    console.error(`Download failed: HTTP ${zipRes.status}`);
    process.exit(1);
}
const zip = new AdmZip(Buffer.from(await zipRes.arrayBuffer()));

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const entries = zip.getEntries();
const names = new Set(entries.map((e) => e.entryName));
let htmlName = null;
let kept = 0;
let skipped = 0;

for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    // Pre-compressed copies (.gz/.br) are only needed by web servers that do content
    // negotiation. Drop them when the uncompressed file exists to halve the size.
    // (Files such as tesseract's eng.traineddata.gz have no uncompressed sibling and are kept.)
    const m = name.match(/^(.*)\.(gz|br)$/);
    if (m && names.has(m[1])) {
        skipped++;
        continue;
    }
    // The packaged index.html is replaced by our own copy of CyberChef_vX.html.
    if (/^index\.html(\.gz|\.br)?$/.test(name)) {
        skipped++;
        continue;
    }
    let target = name;
    if (/^CyberChef_v[^/]*\.html$/.test(name)) {
        htmlName = name;
        target = "index.html";
    }
    const dest = path.join(outDir, target);
    if (!dest.startsWith(outDir + path.sep)) throw new Error(`Unsafe path in zip: ${name}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
    kept++;
}

if (!htmlName) {
    console.error("CyberChef_v*.html not found in the release zip.");
    process.exit(1);
}

fs.writeFileSync(stampFile, tag + "\n");
console.log(`CyberChef ${tag} unpacked to ./cyberchef (${kept} files, ${skipped} skipped, entry ${htmlName} -> index.html).`);
