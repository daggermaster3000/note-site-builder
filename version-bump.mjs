// `npm version patch` keeps manifest.json and versions.json in step with package.json.
import { readFileSync, writeFileSync } from "fs";

const version = process.env.npm_package_version;
if (!version) {
	console.error("Run this through `npm version <patch|minor|major>`, not directly.");
	process.exit(1);
}
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[version] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");
