import {attachHealthTelemetry} from './health-telemetry.mjs';
// Browser-only startup: reuse the adapter-owned ManagedChrome normal boot.
// No auth/login/refresh, composer mint, chat call or request replay is added here.
function installBrowserStartup(AdapterServer) {
  const listen = AdapterServer.prototype.listen;
  AdapterServer.prototype.listen = async function (...args) {
    attachHealthTelemetry(this.server);
    const address = await listen.apply(this, args);
    await this.chrome.ensureRunning();
    return address;
  };
}
if (process.argv[2] === 'serve') {
  const { AdapterServer } = await import('./runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/server/http.js');
  installBrowserStartup(AdapterServer);
}

// Durable Windows launcher for the supplied patched adapter; no copied credentials.
const entry = new URL('./runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/cli/index.js', import.meta.url);
await import(entry.href);
