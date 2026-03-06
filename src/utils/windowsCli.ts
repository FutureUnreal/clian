/**
 * Windows CLI helpers.
 *
 * GUI apps (Obsidian/Electron) often run with a minimal PATH and may not be able
 * to resolve npm/pnpm/yarn global shims like `codex` or `gemini`.
 *
 * These helpers try common global-bin locations and return an absolute path to
 * a runnable shim (usually `.cmd`) when possible.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function isBareCommand(cmd: string): boolean {
  if (!cmd) return false;
  // If the user provided a path, don't treat it as a bare command.
  if (cmd.includes('/') || cmd.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(cmd)) return false;
  return true;
}

function isExistingFile(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function getHomeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || '';
}

function getAppDataDir(): string | null {
  const home = getHomeDir();
  return process.env.APPDATA || (home ? path.join(home, 'AppData', 'Roaming') : null);
}

function getLocalAppDataDir(): string | null {
  const home = getHomeDir();
  return process.env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : null);
}

/**
 * Resolve a bare command (e.g. "codex") to an absolute shim path if possible.
 * Returns null when not on Windows or not resolvable.
 */
export function resolveWindowsShim(command: string): string | null {
  if (process.platform !== 'win32') return null;
  const cmd = (command || '').trim();
  if (!isBareCommand(cmd)) return null;

  const appData = getAppDataDir();
  const localAppData = getLocalAppDataDir();

  // Prefer `.exe` if present, else `.cmd` (npm/pnpm/yarn shims).
  const candidates: string[] = [];

  if (appData) {
    candidates.push(
      path.join(appData, 'npm', `${cmd}.exe`),
      path.join(appData, 'npm', `${cmd}.cmd`),
      path.join(appData, 'npm', `${cmd}.bat`)
    );
  }

  const pnpmHome = process.env.PNPM_HOME || (localAppData ? path.join(localAppData, 'pnpm') : null);
  if (pnpmHome) {
    candidates.push(
      path.join(pnpmHome, `${cmd}.exe`),
      path.join(pnpmHome, `${cmd}.cmd`),
      path.join(pnpmHome, `${cmd}.bat`)
    );
  }

  if (localAppData) {
    candidates.push(
      path.join(localAppData, 'Yarn', 'bin', `${cmd}.cmd`),
      path.join(localAppData, 'Yarn', 'bin', `${cmd}.bat`)
    );
  }

  // Volta shims are often `.cmd` on Windows.
  const home = getHomeDir();
  if (home) {
    candidates.push(path.join(home, '.volta', 'bin', `${cmd}.cmd`));
  }

  for (const p of candidates) {
    if (p && isExistingFile(p)) return p;
  }

  return null;
}

