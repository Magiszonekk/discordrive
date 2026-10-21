// Installers of the desktop app with electron-builder: Windows NSIS (.exe), Linux AppImage + .deb.
// The app is bundled already (build.ts: dist/ holds every file it runs, no node_modules), so the package is
// made from a small staging folder with dist/ and a package.json of its own, not from the npm workspace.
//
//   tsx package.ts [--win] [--linux] [--mac] [--dir]     (default: the current system)
//   env DDN_BUILD_ID   text shown in About and checked by the update check (CI: the commit)
//
// Output: apps/desktop/release/ (installers, SHA256SUMS, build-info.json). No code signing (see README).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as { version: string; devDependencies: Record<string, string> };
const electronVersion = pkg.devDependencies.electron!.replace(/^[^\d]*/, "");
const BUILDER = "electron-builder@26.15.3";
const stage = join(here, ".stage");
const out = join(here, "release");
if (!existsSync(join(here, "dist", "main.cjs"))) throw new Error("run the build first (npm run build -w @ddv4/desktop)");

rmSync(stage, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(here, "dist"), join(stage, "dist"), { recursive: true });
// What the app knows about itself (About, transfer logs, update check): written by build.ts.
if (!existsSync(join(stage, "dist", "build-info.json"))) throw new Error("dist/build-info.json missing: run the build first");
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "discordrive",
      productName: "discordrive",
      version: pkg.version,
      description: "discordrive desktop app",
      author: { name: "discordrive", email: "noreply@example.com" },
      homepage: "https://github.com/Magiszonekk/discordrive",
      license: "MIT",
      main: "dist/main.cjs",
    },
    null,
    1,
  ),
);

const config = {
  appId: "io.github.magiszonekk.discordrive",
  productName: "discordrive",
  electronVersion,
  directories: { output: out, buildResources: join(here, "build-res") },
  files: ["dist/**/*", "package.json"],
  asar: true,
  // Electron fuses (security checklist #18): no ELECTRON_RUN_AS_NODE, NODE_OPTIONS or --inspect for the
  // packaged app, app code only from the (integrity-checked where supported) asar, no extra file:// rights.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
    enableCookieEncryption: true,
  },
  // No auto-update feed: updates are checked and offered by the app itself (never installed silently).
  publish: null,
  artifactName: "discordrive-${version}-${os}-${arch}.${ext}",
  win: { target: [{ target: "nsis", arch: ["x64"] }], icon: join(here, "build-res", "icon.ico") },
  // createDesktopShortcut: true = only on a fresh install ("always" would re-create it at every update). The
  // in-app update runs this installer with --updated, which keeps the user's shortcuts (README: Updates).
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, runAfterFinish: true },
  linux: {
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
    category: "Utility",
    icon: join(here, "build-res", "icon.png"),
    maintainer: "discordrive <noreply@example.com>",
    synopsis: "Files on Discord, encrypted",
  },
  // The .deb ships an AppArmor profile for Chromium's sandbox (Ubuntu 24.04+ restricts user namespaces).
  deb: {
    packageCategory: "utils",
    // electron-builder's defaults miss the sound library Chromium links against (a desktop has it anyway,
    // a minimal install does not); its name changed in Ubuntu 24.04 (t64).
    depends: ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0", "libasound2t64 | libasound2", "libgbm1"],
  },
  mac: { target: [{ target: "zip", arch: ["x64", "arm64"] }], identity: null },
};
writeFileSync(join(stage, "builder.json"), JSON.stringify(config, null, 1));

const targets = process.argv.slice(2).filter((a) => ["--win", "--linux", "--mac", "--dir"].includes(a));
execFileSync("npx", ["--yes", BUILDER, "--config", "builder.json", "--projectDir", stage, ...targets], {
  cwd: stage,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
});

// SHA-256 of every installer (the release page lists them; the app checks the one it downloads).
const files = readdirSync(out).filter((f) => /\.(exe|AppImage|deb|zip)$/.test(f));
const sums = files.map((f) => `${createHash("sha256").update(readFileSync(join(out, f))).digest("hex")}  ${f}`).join("\n") + "\n";
writeFileSync(join(out, "SHA256SUMS"), sums);
writeFileSync(join(out, "build-info.json"), readFileSync(join(stage, "dist", "build-info.json")));
console.log("build", JSON.parse(readFileSync(join(stage, "dist", "build-info.json"), "utf8")).build);
console.log(sums);
