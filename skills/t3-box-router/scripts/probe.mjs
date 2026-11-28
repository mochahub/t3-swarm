#!/usr/bin/env node
/**
 * t3-box-router probe: a read-only hardware and toolchain report for the machine it runs on (Node 18+, built-in
 * modules only, no sibling imports). It is self-contained so its source can be sent to a box in a delegated task
 * and run there with `node probe.mjs` (or `node --input-type=module -` with the source on stdin).
 *
 * What it reads, and nothing more:
 *   - os.platform(), os.arch(), the CPU count and total memory;
 *   - whether named files and directories exist (/sys/class/drm vendor IDs, /proc/driver/nvidia/gpus,
 *     /Applications/Xcode.app, the Android SDK's adb, Godot.app), and the xcode-select link;
 *   - whether named executables are on PATH (Xvfb, xvfb-run, godot, docker, gh, adb), by file mode only;
 *   - these environment variables only: PATH, PATHEXT, HOME, DISPLAY, WAYLAND_DISPLAY, ANDROID_HOME,
 *     ANDROID_SDK_ROOT, DEVELOPER_DIR.
 * It runs no programs, makes no network requests and writes nothing. It never looks for credentials, environment
 * files, key stores or sign-ins (no gh auth, keychain, ssh or env dump). Credential capabilities are reported only
 * when the owner declares them with --attest cred:<name>=true|false or --attest secret:<name>=true|false.
 *
 * Output: one JSON object { kind: "t3-box-router-probe", version: 1, probedAt, os, arch, cpuCores, ramGb,
 * gpu: { count, vendor }, display: { native, virtual }, tools: { xcode, ios-sim, android-sdk, godot, docker, gh },
 * attestations? }. Feed it to `box-router apply-probe <label> [--environment-id <id>]` on the orchestrating machine.
 */

import fs from "node:fs";
import nodeOs from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PROBE_KIND = "t3-box-router-probe";
export const PROBE_VERSION = 1;
const ATTESTATION_PATTERN = /^(?:cred|secret):[a-z0-9][a-z0-9._-]{0,56}$/;
const ENV_KEYS = ["PATH", "PATHEXT", "HOME", "DISPLAY", "WAYLAND_DISPLAY", "ANDROID_HOME", "ANDROID_SDK_ROOT", "DEVELOPER_DIR"];
const PCI_VENDORS = { "0x10de": "nvidia", "0x1002": "amd", "0x1022": "amd", "0x8086": "intel" };

export class AttestError extends Error {}

/**
 * Parse --attest values ("secret:build-signing=true"). Values must be exactly true or false. Errors never repeat
 * the rejected text.
 */
export function parseAttestations(values) {
  const out = {};
  for (const v of values) {
    const m = /^([^=]*)=(true|false)$/.exec(typeof v === "string" ? v : "");
    if (!m || !ATTESTATION_PATTERN.test(m[1])) {
      throw new AttestError("--attest expects cred:<name>=true|false or secret:<name>=true|false (lowercase name).");
    }
    out[m[1]] = m[2] === "true";
  }
  return out;
}

/** The real host, read-only. Tests pass their own. */
export function realHost() {
  const env = {};
  for (const k of ENV_KEYS) if (typeof process.env[k] === "string") env[k] = process.env[k];
  return {
    platform: nodeOs.platform(),
    arch: nodeOs.arch(),
    cpuCount: typeof nodeOs.availableParallelism === "function" ? nodeOs.availableParallelism() : nodeOs.cpus().length,
    totalmem: nodeOs.totalmem(),
    homedir: nodeOs.homedir(),
    env,
    exists: (p) => {
      try {
        fs.statSync(p);
        return true;
      } catch {
        return false;
      }
    },
    isExecutable: (p) => {
      try {
        if (!fs.statSync(p).isFile()) return false;
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    readdir: (p) => {
      try {
        return fs.readdirSync(p);
      } catch {
        return [];
      }
    },
    readText: (p) => {
      try {
        return fs.readFileSync(p, "utf8").slice(0, 256);
      } catch {
        return null;
      }
    },
    readlink: (p) => {
      try {
        return fs.readlinkSync(p);
      } catch {
        return null;
      }
    },
  };
}

function onPath(host, name) {
  const dirs = String(host.env.PATH || "").split(host.platform === "win32" ? ";" : ":").filter(Boolean);
  const exts = host.platform === "win32" ? ["", ...String(host.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())] : [""];
  for (const dir of dirs) for (const ext of exts) if (host.isExecutable(path.join(dir, name + ext))) return true;
  return false;
}

function detectGpu(host) {
  if (host.platform === "darwin") return host.arch === "arm64" ? { count: 1, vendor: "apple" } : { count: 0, vendor: null };
  if (host.platform !== "linux") return { count: 0, vendor: null };
  const nvidia = host.readdir("/proc/driver/nvidia/gpus").length;
  if (nvidia > 0) return { count: nvidia, vendor: "nvidia" };
  const vendors = [];
  for (const card of host.readdir("/sys/class/drm")) {
    if (!/^card\d+$/.test(card)) continue;
    const id = (host.readText(`/sys/class/drm/${card}/device/vendor`) || "").trim().toLowerCase();
    vendors.push(PCI_VENDORS[id] || "other");
  }
  if (!vendors.length) return { count: 0, vendor: null };
  const vendor = ["nvidia", "amd", "intel"].find((v) => vendors.includes(v)) || "other";
  return { count: vendors.filter((v) => v === vendor).length, vendor };
}

function xcodeDeveloperDir(host) {
  if (host.platform !== "darwin") return null;
  const candidates = [];
  if (host.env.DEVELOPER_DIR) candidates.push(host.env.DEVELOPER_DIR);
  const link = host.readlink("/var/db/xcode_select_link");
  if (link) candidates.push(link);
  candidates.push("/Applications/Xcode.app/Contents/Developer", "/Applications/Xcode-beta.app/Contents/Developer");
  return candidates.find((d) => /\.app\/Contents\/Developer\/?$/.test(d) && host.exists(path.join(d, "usr/bin/xcodebuild"))) || null;
}

function androidSdk(host) {
  const roots = [host.env.ANDROID_HOME, host.env.ANDROID_SDK_ROOT];
  if (host.homedir) roots.push(path.join(host.homedir, "Library/Android/sdk"), path.join(host.homedir, "Android/Sdk"));
  const adb = host.platform === "win32" ? "adb.exe" : "adb";
  return roots.some((r) => typeof r === "string" && r && host.isExecutable(path.join(r, "platform-tools", adb))) || onPath(host, "adb");
}

/** The probe report for `host` (default: this machine). attestations come only from the owner's flags. */
export function probeMachine({ host = realHost(), attestations = {}, now = Date.now() } = {}) {
  const osName = { darwin: "macos", linux: "linux", win32: "windows" }[host.platform] || "other";
  const developerDir = xcodeDeveloperDir(host);
  const godotApp = host.platform === "darwin" && (host.exists("/Applications/Godot.app") || host.exists("/Applications/Godot_mono.app"));
  const report = {
    kind: PROBE_KIND,
    version: PROBE_VERSION,
    probedAt: new Date(now).toISOString(),
    os: osName,
    arch: { x64: "x64", arm64: "arm64", arm: "arm" }[host.arch] || "other",
    cpuCores: Math.max(1, Math.floor(Number(host.cpuCount) || 1)),
    ramGb: Math.round((Number(host.totalmem) / 2 ** 30) * 10) / 10,
    gpu: detectGpu(host),
    display: {
      native: host.platform === "darwin" || host.platform === "win32" || Boolean(host.env.DISPLAY || host.env.WAYLAND_DISPLAY),
      virtual: onPath(host, "Xvfb") || onPath(host, "xvfb-run"),
    },
    tools: {
      xcode: Boolean(developerDir),
      "ios-sim": Boolean(developerDir) && host.exists(path.join(developerDir, "Platforms/iPhoneSimulator.platform")),
      "android-sdk": androidSdk(host),
      godot: godotApp || ["godot", "godot4", "Godot"].some((n) => onPath(host, n)),
      docker: onPath(host, "docker"),
      gh: onPath(host, "gh"),
    },
  };
  if (Object.keys(attestations).length) report.attestations = { ...attestations };
  return report;
}

function main(argv) {
  const attest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--attest") attest.push(argv[++i]);
    else if (a.startsWith("--attest=")) attest.push(a.slice("--attest=".length));
    else if (a === "-h" || a === "--help") {
      process.stdout.write("Usage: node probe.mjs [--attest cred:<name>=true|false] [--attest secret:<name>=true|false]\n");
      return;
    } else {
      process.stdout.write(JSON.stringify({ ok: false, error: "Unknown argument. Usage: node probe.mjs [--attest secret:<name>=true|false]" }) + "\n");
      process.exitCode = 1;
      return;
    }
  }
  try {
    process.stdout.write(JSON.stringify(probeMachine({ attestations: parseAttestations(attest) }), null, 2) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e instanceof AttestError ? e.message : "Probe failed." }) + "\n");
    process.exitCode = 1;
  }
}

// Run when executed directly, or when the source arrives on stdin (no script path in argv).
const entry = process.argv[1];
const isMain = !entry || entry === "-" || (() => {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href || import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
})();
if (isMain) main(process.argv.slice(2));
