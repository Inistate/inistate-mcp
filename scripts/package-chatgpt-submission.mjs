// Build the ChatGPT plugin upload ZIP. It mirrors the package already accepted
// for the existing ChatGPT plugin: a single `.codex-plugin/plugin.json` whose
// `name` is that plugin's ID, plus the `.mcp.json` it references. The plugin's
// MCP declaration must be kept; removing it is rejected on submission.
//
// ChatGPT publishing already used 2.0.1, so the plugin version is the package
// version with its major bumped by one (1.3.0 -> 2.3.0), keeping it above that.
import { deflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const mcpUrl = "https://mcp.inistate.com/mcp";
const pluginName = "app-69f9ad1e0abc819193c9f1bbfe8ed040";
const [major, minor, patch] = pkg.version.split(".");
const pluginVersion = `${Number(major) + 1}.${minor}.${patch}`;

const description =
  "Turn ChatGPT into a governed AI teammate for your business operations. Inistate lets ChatGPT create workflows, update records, trigger approvals, upload files, query entries, and execute state transitions through structured forms — with every action captured in a full audit trail. No prompt engineering required. The schema is the prompt.";

// The listing requires a square app icon (PNG, JPEG, WebP or SVG, at least 48x48,
// under 5 MiB). Supply it as chatgpt-plugin/assets/icon.<ext>; it is used for both
// composerIcon and logo. An optional icon-dark.<ext> is used for the dark variants.
const assetsDir = path.join(root, "chatgpt-plugin", "assets");
const findAsset = (base) => ["png", "svg", "webp", "jpg", "jpeg"].map((ext) => `${base}.${ext}`).find((file) => existsSync(path.join(assetsDir, file)));
const icon = findAsset("icon");
if (!icon) {
  throw new Error(`App icon required: add a square icon.png (or .svg/.webp/.jpg) to ${path.relative(root, assetsDir)}.`);
}
const iconDark = findAsset("icon-dark");
const assetFiles = [icon, iconDark].filter(Boolean);

const pluginManifest = {
  author: { name: "Inistate" },
  description,
  interface: {
    capabilities: [],
    composerIcon: `./assets/${icon}`,
    ...(iconDark ? { composerIconDark: `./assets/${iconDark}`, logoDark: `./assets/${iconDark}` } : {}),
    logo: `./assets/${icon}`,
    category: "Business & Operations",
    defaultPrompt: ["List workspaces"],
    developerName: "Inistate",
    displayName: "Inistate",
    longDescription: description,
    privacyPolicyURL: "https://inistate.com/privacyPolicy",
    shortDescription: "Make & run business workflows",
    supportURL: "https://support.inistate.com/",
    termsOfServiceURL: "https://inistate.com/terms",
    websiteURL: "https://inistate.com",
  },
  mcpServers: "./.mcp.json",
  name: pluginName,
  version: pluginVersion,
};
const mcpManifest = { mcpServers: { inistate: { url: mcpUrl } } };

const crc32 = (data) => {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const writeU16 = (buffer, offset, value) => buffer.writeUInt16LE(value, offset);
const writeU32 = (buffer, offset, value) => buffer.writeUInt32LE(value >>> 0, offset);

function zipFiles(files) {
  const flags = 0x0800; // UTF-8 file name
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, contents } of files) {
    const fileName = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(contents);
    const crc = crc32(contents);
    const local = Buffer.alloc(30 + fileName.length + compressed.length);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 4, 20);
    writeU16(local, 6, flags);
    writeU16(local, 8, 8);
    writeU16(local, 10, 0);
    writeU16(local, 12, 0);
    writeU32(local, 14, crc);
    writeU32(local, 18, compressed.length);
    writeU32(local, 22, contents.length);
    writeU16(local, 26, fileName.length);
    writeU16(local, 28, 0);
    fileName.copy(local, 30);
    compressed.copy(local, 30 + fileName.length);
    locals.push(local);

    const central = Buffer.alloc(46 + fileName.length);
    writeU32(central, 0, 0x02014b50);
    writeU16(central, 4, 20);
    writeU16(central, 6, 20);
    writeU16(central, 8, flags);
    writeU16(central, 10, 8);
    writeU16(central, 12, 0);
    writeU16(central, 14, 0);
    writeU32(central, 16, crc);
    writeU32(central, 20, compressed.length);
    writeU32(central, 24, contents.length);
    writeU16(central, 28, fileName.length);
    writeU16(central, 30, 0);
    writeU16(central, 32, 0);
    writeU16(central, 34, 0);
    writeU16(central, 36, 0);
    writeU32(central, 38, 0);
    writeU32(central, 42, offset);
    fileName.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }

  const end = Buffer.alloc(22);
  writeU32(end, 0, 0x06054b50);
  writeU16(end, 4, 0);
  writeU16(end, 6, 0);
  writeU16(end, 8, files.length);
  writeU16(end, 10, files.length);
  writeU32(end, 12, centrals.reduce((size, central) => size + central.length, 0));
  writeU32(end, 16, offset);
  writeU16(end, 20, 0);
  return Buffer.concat([...locals, ...centrals, end]);
}

const outputDir = path.join(root, "artifacts");
const outputPath = path.join(outputDir, `${pluginName}-${pluginVersion}.zip`);
mkdirSync(outputDir, { recursive: true });
writeFileSync(outputPath, zipFiles([
  { name: ".codex-plugin/plugin.json", contents: Buffer.from(`${JSON.stringify(pluginManifest, null, 2)}
`) },
  ...assetFiles.map((file) => ({ name: `assets/${file}`, contents: readFileSync(path.join(assetsDir, file)) })),
  { name: ".mcp.json", contents: Buffer.from(`${JSON.stringify(mcpManifest, null, 2)}
`) },
]));
console.log(`Created ${path.relative(root, outputPath)} (plugin ${pluginName} v${pluginVersion}).`);
