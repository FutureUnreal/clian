import { Platform } from 'obsidian';

// Important: avoid importing any Node-only modules at top-level so the plugin can load on mobile.
// Desktop implementation (Claude Code CLI + Agent SDK) stays in ./main.
// Mobile implementation (remote hub client) lives in ./mobile/main.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PluginExport: any;

if (Platform.isMobileApp) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  PluginExport = require('./mobile/main').default;
} else {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  PluginExport = require('./main').default;
}

export default PluginExport;
