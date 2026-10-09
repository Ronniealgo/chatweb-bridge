# Third-party attribution and unresolved notice

This project adapts `@minzicat/pi-chatgpt-web-adapter` **0.1.1**, distributed through
the official npm registry. Registry maintainer: **minzicat**. The package declares
its repository as `minzique/dotfiles-agents`, subdirectory
`packages/pi-chatgpt-web-adapter`, and labels its license MIT. Maintainer identity
is attribution from the registry, not a verified copyright-holder statement.

- [Exact version metadata](https://registry.npmjs.org/@minzicat%2fpi-chatgpt-web-adapter/0.1.1)
- [Declared repository](https://github.com/minzique/dotfiles-agents)
- Machine-readable source/integrity: `third-party/adapter-provenance.json`.
- Local modifications: `patches/adapter-0.1.1-to-runtime-v4.patch`; the manifest
  enumerates ten changed/added files and all pristine/reconstructed file hashes.

The published tarball SHA256 is
`e45e8e72a3296df14d36946941e0c7c7ec034fa2e0926e9dc78cc4be3aaad5a1`.
Its SHA512 matches the recorded official version metadata and the runtime lockfile.
The root bridge lockfile contains only bridge dependencies, not the adapter.
The npm metadata does not provide a git commit, so this candidate pins the actual
published artifact instead of claiming an unverified source commit.

## Original copyright notice remains unavailable

The verified original tarball has no LICENSE/COPYING/NOTICE file and no original
copyright/license grant text found in its source; the README only names MIT.
The preserved anonymous audit recorded 404 for the declared GitHub repository
and tested license locations. An older API observation was 403; neither response
establishes why the source is unavailable. No new upstream lookup is claimed here.

No original copyright statement has been recovered. A generic MIT template or a
new guessed copyright line has deliberately not been substituted. Obtain and
preserve the actual upstream notice before public redistribution of adapter-derived
code or patches. The [MIT terms](https://opensource.org/license/mit) require keeping
the copyright and permission notices; the npm license label alone does not supply
those missing texts.

## Other dependencies and distribution scope

The root and runtime lockfiles pin all dependency versions and registry integrity
values. `ajv` is a direct bridge dependency and `puppeteer-core` is the adapter's
direct browser dependency. Their locked trees declare MIT, Apache-2.0, BSD, ISC
and 0BSD licenses. Generated dependency trees are excluded from this source
candidate and installed directly from the public registry; do not replace their
licenses if later assembling a binary or dependency-inclusive distribution.

Authorized original contributions use MIT, Copyright (c) 2026 うんけん;
see LICENSE-SCOPE.md. The runtime dependency-reference manifests and all vendor
license/author metadata are retained; our project author is not substituted there.
This does not relicense any third-party material or resolve the adapter notice. The generated
installation manifest's old ISC field was removed rather than being treated as a
license for this project. DSH, Chrome, authenticated profiles and user data are
not redistributed. Nothing here asserts endorsement by upstream maintainers.

The latest preserved repository/license lookup returned 404; an older 403
observation is not the current result. Neither establishes why the source is
unavailable. A patch distribution still carries derived material and does not
resolve missing copyright/permission notices. No upstream license has been granted or changed by this preparation.

## Release-preparation clarification (2026-10-09)

All preceding third-party declarations are retained. The follow-up audit fetched
both published 0.1.0 and 0.1.1 tarballs anew and matched registry integrity. Each
contains 39 files; 37 files are identical, with only package metadata and the
changelog differing. Neither includes original copyright/permission text. The
0.1.1 files match this patch manifest's pristine input hashes.

Primary sources retained:
- [Official 0.1.1 metadata](https://registry.npmjs.org/@minzicat%2fpi-chatgpt-web-adapter/0.1.1)
- [Official 0.1.1 tarball](https://registry.npmjs.org/@minzicat/pi-chatgpt-web-adapter/-/pi-chatgpt-web-adapter-0.1.1.tgz)
- [Official 0.1.0 metadata](https://registry.npmjs.org/@minzicat%2fpi-chatgpt-web-adapter/0.1.0)
- [Declared repository API](https://api.github.com/repos/minzique/dotfiles-agents)
- [Declared main root license](https://raw.githubusercontent.com/minzique/dotfiles-agents/main/LICENSE)
- [Declared package license](https://raw.githubusercontent.com/minzique/dotfiles-agents/main/packages/pi-chatgpt-web-adapter/LICENSE)

The repository and tested license URLs returned 404 in that audit; no reason for
their unavailability is inferred. MIT remains the verified upstream declaration.
The missing original notice is not fabricated, and the maintainer is not asserted
to be the copyright holder. This uncertainty is not a determination of infringement.
Complete redistribution conditions are not yet confirmed, so public upload of
this combined source remains on hold pending matching notice/authorization.
Project live-task acceptance has since been confirmed by the maintainer; the
older deployment wording above records the source-preparation history and is
not a request to repeat that acceptance. New credential deployment remains deferred.

## Upstream author identification and notice recovery (2026-10-09 follow-up)

Further public-source investigation. No contact was made with the author, and no
credential or private data was used beyond this project owner’s own GitHub login.

### Author identity, cross-checked from three independent public records

| Record | Value |
| --- | --- |
| npm maintainer of the package | `minzicat`, email `minzi@minzique.net` |
| GitHub user | `minzique` — display name "Minzi", website `minzique.net` |
| npm publishing scope | `@minzicat` (the author’s own scope) |

The npm email domain and the GitHub account website match, so the package author
and the GitHub account are the same person. The declared repository
`github.com/minzique/dotfiles-agents` no longer resolves (404), and the adapter is
not present in the author’s current public repositories, so the package’s own
LICENSE file could not be retrieved.

### Best available original copyright evidence

A different package by the **same author**, in the same npm scope family and also
published under MIT, carries an explicit original notice:

    minzique/pi-claude-oauth-adapter/LICENSE
    MIT License
    Copyright (c) 2026 Minzi

Source: `https://api.github.com/repos/minzique/pi-claude-oauth-adapter/license`

### What is confirmed and what is derived

- **Confirmed:** `@minzicat/pi-chatgpt-web-adapter` declares MIT in its published
  package metadata and README. The published 0.1.0 and 0.1.1 artifacts contain no
  standalone copyright or license text file. Both artifacts were re-fetched in this
  audit and their registry integrity was matched.
- **Confirmed:** the package author is Minzi (GitHub `minzique`, npm `minzicat`).
- **Derived, not verified against the 0.1.1 artifact:** the copyright line
  `Copyright (c) 2026 Minzi` comes from the same author’s other MIT project. It is
  recorded here as the best available attribution for that author’s 2026 work, not as
  text extracted from the 0.1.1 tarball.

No copyright holder has been invented. If the author supplies a different, or more
specific, notice for 0.1.1, it will be reproduced verbatim here and the derived line
above will be removed.

### Upstream MIT notice preserved by this project

    MIT License

    Copyright (c) 2026 Minzi

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

This notice covers the upstream portions only. The project’s own original
contributions remain under their separate MIT grant recorded in LICENSE and
LICENSE-SCOPE.md; neither grant replaces the other.
