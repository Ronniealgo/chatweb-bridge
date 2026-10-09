// Synthetic credentials only. Security rejection tests do not use this wrapper.
export const externalToken = 'offline-external-fixture-token-000000000001';
export const upstreamToken = 'offline-internal-fixture-token-000000000002';
export const bridgeAuth = { externalToken, upstreamToken };
export const adapterAuth = { internalToken: upstreamToken };
export const authFetch = token => (input, init = {}) => {
 const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${token}`);
 return globalThis.fetch(input, { ...init, headers });
};
