import fs from "node:fs/promises";
import path from "node:path";

const manifestPath = process.argv[2] ?? "yapyep_phase5_media_manifest.json";
const outDir = process.argv[3] ?? "public/demo-media";
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
await fs.mkdir(outDir, { recursive: true });

for (const asset of manifest.assets) {
  const out = path.join(outDir, asset.file_name);
  try {
    const r = await fetch(asset.download_url, {
      redirect: "follow",
      headers: { "user-agent": "YapYep-Hackathon-Demo/1.0" }
    });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const buf = Buffer.from(await r.arrayBuffer());
    await fs.writeFile(out, buf);
    console.log(`OK ${asset.id} -> ${out} (${buf.length} bytes)`);
  } catch (e) {
    console.error(`FAIL ${asset.id}: ${e.message}`);
    process.exitCode = 1;
  }
}
