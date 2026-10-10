import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { uploadImageAsset, imageAssetPointer, validateImageSpecs, MAX_IMAGE_FILE_BYTES, IMAGE_EXTENSIONS } from '../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/images.js';

// The page function is stringified into chatgpt.com via page.evaluate, so these
// tests run it inside a bare vm context that only exposes browser globals — the
// closest offline approximation of the real page.evaluate() serialization.
const ADAPTER_IMAGES = fileURLToPath(new URL('../runtime/node_modules/@minzicat/pi-chatgpt-web-adapter/dist/chat/images.js', import.meta.url));

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const spec = {
  origin: 'https://chatgpt.com', bearer: 'test-bearer-token', identityHeaders: { 'x-fake-identity': '1' },
  fileName: 'image-1.png', mediaType: 'image/png', sizeBytes: PNG_BYTES.length,
  bytesBase64: Buffer.from(PNG_BYTES).toString('base64'),
};

function fakePage(plan = {}) {
  const calls = [];
  const respond = (override, fallback) => override ?? { ok: true, status: 200, json: async () => fallback };
  const sandbox = vm.createContext({
    fetch: async (url, init = {}) => {
      const urlText = String(url);
      calls.push({ url: urlText, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
      if (init.method === 'POST' && urlText.endsWith('/backend-api/files'))
        return respond(plan.created, { file_id: 'file-test-1', upload_url: 'https://azure.test/container/blob?sig=1' });
      if (init.method === 'PUT') return respond(plan.put, {});
      if (init.method === 'POST' && urlText.endsWith('/uploaded')) return respond(plan.confirmed, { status: 'success' });
      throw new Error(`unexpected page fetch: ${init.method} ${urlText}`);
    },
    atob: encoded => Buffer.from(encoded, 'base64').toString('binary'),
    createImageBitmap: async () => plan.bitmap ?? { width: 7, height: 5, close() {} },
    AbortSignal, URL, Blob,
  });
  return { sandbox, calls };
}
const runInPage = (sandbox, fn, argument) => {
  sandbox.argument = argument;
  return vm.runInNewContext(`(${fn.toString()})(argument)`, sandbox);
};

test('uploadImageAsset performs the three-step upload inside a bare page context', async () => {
  const { sandbox, calls } = fakePage();
  const upload = JSON.parse(JSON.stringify(await runInPage(sandbox, uploadImageAsset, spec)), (key, value) => value);
  assert.deepEqual(upload, { file_id: 'file-test-1', width: 7, height: 5, size_bytes: PNG_BYTES.length });
  assert.equal(calls.length, 3);
  const [created, put, confirmed] = calls;
  assert.equal(created.url, 'https://chatgpt.com/backend-api/files');
  assert.equal(created.headers.authorization, 'Bearer test-bearer-token');
  assert.equal(created.headers['x-fake-identity'], '1');
  const createdBody = JSON.parse(created.body);
  assert.deepEqual({ ...createdBody, timezone_offset_min: 0 }, {
    file_name: 'image-1.png', file_size: PNG_BYTES.length, mime_type: 'image/png',
    use_case: 'multimodal', timezone_offset_min: 0, reset_rate_limits: false,
  });
  assert.equal(put.url, 'https://azure.test/container/blob?sig=1');
  assert.equal(put.headers.authorization, undefined, 'the SAS URL must not receive an Authorization header');
  assert.equal(put.headers['x-ms-blob-type'], 'BlockBlob');
  assert.equal(put.headers['x-ms-version'], '2020-04-08');
  assert.equal(put.headers['content-type'], 'image/png');
  assert.deepEqual(Buffer.from(put.body), Buffer.from(PNG_BYTES));
  assert.equal(confirmed.url, 'https://chatgpt.com/backend-api/files/file-test-1/uploaded');
  assert.equal(confirmed.body, '{}');
  assert.equal(confirmed.headers.authorization, 'Bearer test-bearer-token');
});

test('the page function carries no module-scope references (page.evaluate safe)', () => {
  const fnSource = uploadImageAsset.toString();
  for (const forbidden of ['ROUTES', 'CREATE_TIMEOUT_MS', 'PUT_TIMEOUT_MS', 'CONFIRM_TIMEOUT_MS', 'IMAGE_EXTENSIONS', 'MAX_IMAGE_FILE_BYTES'])
    assert.equal(fnSource.includes(forbidden), false, `page function must not reference module scope: ${forbidden}`);
  assert.match(fnSource, /\/backend-api\/files/, 'route literals are inlined');
  // Evaluating the serialized function in a bare context must not throw.
  const { sandbox } = fakePage();
  assert.doesNotThrow(() => vm.runInNewContext(`(${fnSource})`, sandbox));
});

test('estuary-wrapped upload URLs are unwrapped before the PUT', async () => {
  const nested = 'https://azure.test/container/blob?sig=2';
  const { sandbox, calls } = fakePage({ created: { ok: true, status: 200, json: async () => ({ file_id: 'file-e', upload_url: `https://estuary.test/ingest?upload_url=${encodeURIComponent(nested)}` }) } });
  await runInPage(sandbox, uploadImageAsset, spec);
  assert.equal(calls[1].url, nested);
});

test('upload failures surface as plain Errors before the conversation is submitted', async () => {
  for (const [name, plan, message] of [
    ['file create', { created: { ok: false, status: 403, json: async () => ({}) } }, /file create failed \(HTTP 403\)/],
    ['blob PUT', { put: { ok: false, status: 400, json: async () => ({}) } }, /blob upload failed \(HTTP 400\)/],
    ['confirm', { confirmed: { ok: false, status: 500, json: async () => ({}) } }, /file confirm failed \(HTTP 500\)/],
    ['missing upload target', { created: { ok: true, status: 200, json: async () => ({ file_id: 'file-x' }) } }, /no upload target/],
    ['unmeasurable bitmap', { bitmap: { width: 0, height: 0, close() {} } }, /could not be measured/],
  ]) {
    const { sandbox } = fakePage(plan);
    await assert.rejects(() => runInPage(sandbox, uploadImageAsset, spec), message, name);
  }
});

test('validateImageSpecs enforces the adapter-side contract', () => {
  const ok = { path: 'C:\\tmp\\a.png', media_type: 'image/png', name: 'photo' };
  assert.equal(validateImageSpecs(undefined), undefined);
  assert.equal(validateImageSpecs([]), undefined);
  assert.deepEqual(validateImageSpecs([ok]), [{ path: ok.path, media_type: 'image/png', name: 'photo' }]);
  for (const bad of [
    'nope', Array.from({ length: 9 }, () => ok),
    { ...ok, path: '' }, { ...ok, path: 123 }, { ...ok, media_type: 'image/svg+xml' }, { media_type: 'image/png' },
  ]) assert.throws(() => validateImageSpecs(Array.isArray(bad) ? bad : [bad]), err => err.status === 400);
  assert.equal(validateImageSpecs([{ ...ok, name: 'a'.repeat(121) }])[0].name.length, 120, 'over-long display names are truncated, not rejected');
});

test('imageAssetPointer builds the conversation asset part', () => {
  assert.deepEqual(imageAssetPointer({ file_id: 'file-abc', width: 7, height: 5, size_bytes: 42 }, 'image/png'), {
    content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-abc',
    size_bytes: 42, width: 7, height: 5, mime_type: 'image/png',
  });
});

test('adapter byte cap and extension map match the bridge contract', () => {
  assert.equal(MAX_IMAGE_FILE_BYTES, 20 * 1024 * 1024);
  assert.deepEqual(IMAGE_EXTENSIONS, { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' });
  assert.match(readFileSync(ADAPTER_IMAGES, 'utf8'), /uploadImageAsset/);
});
