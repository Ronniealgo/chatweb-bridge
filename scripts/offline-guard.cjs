// Test-only containment: fixtures may use ephemeral loopback HTTP, never the live route.
const net = require('node:net');
const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function check(host, port) {
  if (!allowedHosts.has(host || 'localhost') || [1456, 1457].includes(Number(port)))
    throw new Error('Offline fixture attempted a forbidden endpoint');
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const value = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof value === 'object') check(value.host, value.port);
  else check(typeof args[1] === 'string' ? args[1] : 'localhost', value);
  return connect.apply(this, args);
};
const fetch = globalThis.fetch;
globalThis.fetch = function(input, ...args) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  check(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80));
  return fetch(input, ...args);
};
