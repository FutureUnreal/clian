#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const packagePath = path.join(__dirname, '..', 'package.json');
const manifestPath = path.join(__dirname, '..', 'manifest.json');
const versionsPath = path.join(__dirname, '..', 'versions.json');

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const versionsJson = fs.existsSync(versionsPath)
  ? JSON.parse(fs.readFileSync(versionsPath, 'utf8'))
  : {};

manifestJson.version = packageJson.version;

if (!manifestJson.minAppVersion) {
  throw new Error('manifest.json is missing minAppVersion');
}

versionsJson[packageJson.version] = manifestJson.minAppVersion;

fs.writeFileSync(manifestPath, JSON.stringify(manifestJson, null, 2) + '\n');
fs.writeFileSync(versionsPath, JSON.stringify(versionsJson, null, 2) + '\n');

console.log(
  `Synced ${packageJson.version} to manifest.json and versions.json (${manifestJson.minAppVersion})`
);
