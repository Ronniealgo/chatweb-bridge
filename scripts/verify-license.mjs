import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { relativePath, sourceFile } from './source-files.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const normalize = value => value.replace(/\s+/gu, ' ').trim();
const mitBody = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const requiredExclusions = [
  'patches/adapter-0.1.1-to-runtime-v4.patch', 'patches/adapter-manifest.json',
  'runtime/package.json', 'runtime/package-lock.json', 'third-party/adapter-provenance.json',
];
function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

// Consistency check only: never a legal opinion, upstream grant or publication approval.
export function verifyLicense(root = defaultRoot) {
  root = resolve(root);
  const text = name => readFileSync(sourceFile(root, name), 'utf8');
  const json = name => JSON.parse(text(name));
  const scope = json('LICENSE-SCOPE.json');
  const release = json('release-files.json');
  const pkg = json('package.json');
  const lock = json('package-lock.json');
  const runtimePkg = json('runtime/package.json');
  const runtimeLock = json('runtime/package-lock.json');
  const manifest = json('patches/adapter-manifest.json');
  const provenance = json('third-party/adapter-provenance.json');
  const attribution = scope.authorAttribution;

  requireCondition(scope.schema === 1 && scope.originalContributionsLicense === 'MIT' &&
    scope.ownerDecision?.selectedLicense === 'MIT', 'Original contribution license must be MIT');
  requireCondition(attribution?.name === 'うんけん' && attribution.year === 2026 &&
    scope.ownerDecision.attributionName === attribution.name, 'Original attribution must match the supplied owner notice');
  const notice = 'Copyright (c) ' + attribution.year + ' ' + attribution.name;
  requireCondition(scope.licenseDocument === 'LICENSE' &&
    normalize(text('LICENSE')) === normalize('MIT License\n\n' + notice + '\n\n' + mitBody),
    'Original MIT notice or standard permission/warranty text differs');
  requireCondition(text('COPYRIGHT-NOTICE.md').includes(notice) &&
    scope.licenseDocumentOwnNotice.includes(notice), 'Copyright attribution records differ');
  requireCondition(pkg.author?.name === attribution.name, 'Package author attribution differs');
  requireCondition(pkg.private === true && runtimePkg.private === true,
    'Local candidate must retain private package metadata');
  requireCondition(pkg.license === 'SEE LICENSE IN LICENSE-SCOPE.md', 'Package license must retain its third-party scope boundary');

  requireCondition(Array.isArray(release.files) && new Set(release.files).size === release.files.length,
    'Release file list must be unique');
  requireCondition(Array.isArray(scope.originalContributionFiles) &&
    new Set(scope.originalContributionFiles).size === scope.originalContributionFiles.length,
    'Original scope list must be unique');
  const original = new Set(scope.originalContributionFiles.map(relativePath));
  const exclusions = Object.keys(scope.excludedFiles).map(relativePath);
  for (const name of requiredExclusions) {
    requireCondition(exclusions.includes(name) && !original.has(name), 'Third-party exclusion missing or regranted: ' + name);
  }
  requireCondition(exclusions.every(name => !original.has(name)) && !original.has(scope.licenseDocument),
    'License scope categories overlap');
  requireCondition(exclusions.every(name => typeof scope.excludedFiles[name] === 'string' && scope.excludedFiles[name].trim()),
    'Third-party exclusions need explicit reasons');
  const covered = [...original, ...exclusions, scope.licenseDocument].sort();
  requireCondition(isDeepStrictEqual(covered, release.files.map(relativePath).sort()), 'License scope must cover exactly the source allowlist');
  release.files.forEach(name => sourceFile(root, name));

  for (const [name, metadata, pinned] of [['bridge', pkg, lock], ['runtime', runtimePkg, runtimeLock]]) {
    requireCondition(pinned.lockfileVersion === 3 && pinned.packages?.[''], name + ' lockfile root missing');
    for (const field of ['name', 'version', 'dependencies', 'engines', 'license']) {
      requireCondition(isDeepStrictEqual(metadata[field], pinned.packages[''][field]), name + ' package/lock ' + field + ' differs');
    }
    requireCondition(pinned.name === metadata.name && pinned.version === metadata.version,
      name + ' lockfile identity differs');
  }
  const upstream = manifest.upstream;
  requireCondition(upstream.package === '@minzicat/pi-chatgpt-web-adapter' && upstream.version === '0.1.1' &&
    runtimePkg.dependencies[upstream.package] === upstream.version, 'Adapter version must remain pinned to 0.1.1');
  const adapter = runtimeLock.packages['node_modules/' + upstream.package];
  requireCondition(adapter?.version === upstream.version && adapter.resolved === upstream.tarball &&
    adapter.integrity === upstream.integrity && adapter.license === upstream.declaredLicense,
    'Adapter runtime lock/provenance differs');
  for (const [field, expected] of Object.entries({ package: upstream.package, version: upstream.version,
    tarball: upstream.tarball, integrity: upstream.integrity, tarballSHA256: upstream.tarballSHA256,
    declaredLicense: upstream.declaredLicense })) {
    requireCondition(provenance[field] === expected, 'Adapter provenance ' + field + ' differs');
  }
  return {
    originalContributionsLicense: 'MIT', author: attribution.name, copyrightYear: attribution.year,
    sourceFiles: release.files.length, packageLockPairs: 'consistent', adapterVersion: upstream.version,
    upstreamNoticeStatus: provenance.originalLicenseTextIncludedInTarball === false ? 'unresolved' : 'requires-separate-review',
    publicRedistributionCleared: false, networkRequests: 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/verify-license.mjs');
    console.log(JSON.stringify(verifyLicense()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
