#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relPath) {
    return fs.readFileSync(path.join(root, relPath), "utf8");
}

function json(relPath) {
    return JSON.parse(read(relPath));
}

function capture(label, text, regex) {
    const match = text.match(regex);
    if (!match) {
        throw new Error(`Missing ${label}`);
    }
    return match[1];
}

function assertEqual(label, actual, expected) {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
}

function assertContains(label, text, expected) {
    if (!text.includes(expected)) {
        throw new Error(`${label}: missing ${expected}`);
    }
}

function parseSemver(label, version) {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) {
        throw new Error(`${label}: invalid semver ${version}`);
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(left, right) {
    const a = parseSemver("left semver", left);
    const b = parseSemver("right semver", right);
    for (let idx = 0; idx < 3; idx += 1) {
        if (a[idx] !== b[idx]) return a[idx] - b[idx];
    }
    return 0;
}

function assertLessOrEqualSemver(label, actual, ceiling) {
    if (compareSemver(actual, ceiling) > 0) {
        throw new Error(`${label}: ${actual} must be <= package version ${ceiling}`);
    }
}

const serverCargo = read("services/server/Cargo.toml");
const serverCompatibility = read("services/server/src/compatibility.rs");
const tsPackage = json("packages/sdk/package.json");
const pythonProject = read("packages/python-sdk-memwal/pyproject.toml");
const pythonCompatibility = read("packages/python-sdk-memwal/memwal/compatibility.py");
const mcpPackage = json("packages/mcp/package.json");
const mcpCompatibility = read("packages/mcp/src/compatibility.ts");
const sdkCompatibility = read("packages/sdk/src/compatibility.ts");
const policyDoc = read("docs/relayer/versioning-and-compatibility.md");

const relayerPackageVersion = capture(
    "server package version",
    serverCargo,
    /^version\s*=\s*"([^"]+)"/m,
);
const apiVersion = capture(
    "RELAYER_API_VERSION",
    serverCompatibility,
    /RELAYER_API_VERSION:\s*&str\s*=\s*"([^"]+)"/,
);
const minTypescript = capture(
    "MIN_TYPESCRIPT_SDK_VERSION",
    serverCompatibility,
    /MIN_TYPESCRIPT_SDK_VERSION:\s*&str\s*=\s*"([^"]+)"/,
);
const minPython = capture(
    "MIN_PYTHON_SDK_VERSION",
    serverCompatibility,
    /MIN_PYTHON_SDK_VERSION:\s*&str\s*=\s*"([^"]+)"/,
);
const minMcp = capture(
    "MIN_MCP_PACKAGE_VERSION",
    serverCompatibility,
    /MIN_MCP_PACKAGE_VERSION:\s*&str\s*=\s*"([^"]+)"/,
);

const pythonVersion = capture("Python package version", pythonProject, /^version\s*=\s*"([^"]+)"/m);
const tsSdkVersion = capture(
    "MEMWAL_TYPESCRIPT_COMPATIBILITY_VERSION",
    sdkCompatibility,
    /MEMWAL_TYPESCRIPT_COMPATIBILITY_VERSION\s*=\s*"([^"]+)"/,
);
const pythonSdkVersion = capture(
    "MEMWAL_PYTHON_COMPATIBILITY_VERSION",
    pythonCompatibility,
    /MEMWAL_PYTHON_COMPATIBILITY_VERSION\s*=\s*"([^"]+)"/,
);
const mcpSdkVersion = capture(
    "MEMWAL_MCP_COMPATIBILITY_VERSION",
    mcpCompatibility,
    /MEMWAL_MCP_COMPATIBILITY_VERSION\s*=\s*"([^"]+)"/,
);

assertEqual("Rust min TypeScript SDK", minTypescript, tsSdkVersion);
assertEqual("Rust min Python SDK", minPython, pythonSdkVersion);
assertEqual("Rust min MCP package", minMcp, mcpSdkVersion);
assertLessOrEqualSemver("TypeScript compatibility baseline", tsSdkVersion, tsPackage.version);
assertLessOrEqualSemver("Python compatibility baseline", pythonSdkVersion, pythonVersion);
assertLessOrEqualSemver("MCP compatibility baseline", mcpSdkVersion, mcpPackage.version);

for (const value of [
    apiVersion,
    relayerPackageVersion,
    minTypescript,
    minPython,
    minMcp,
]) {
    assertContains("versioning policy doc", policyDoc, value);
}

console.log("compatibility contract OK");
