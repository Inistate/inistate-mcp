import fs from "fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const tpl = JSON.parse(fs.readFileSync("server-template.json", "utf8"));

tpl.name = pkg.mcpName;
tpl.version = pkg.version;
if ('packages' in tpl && Array.isArray(tpl.packages) && tpl.packages.length > 0) {
    tpl.packages[0].identifier = pkg.name;
    tpl.packages[0].version = pkg.version;
}

fs.writeFileSync("server.json", JSON.stringify(tpl, null, 2));
console.log("server.json synced");
