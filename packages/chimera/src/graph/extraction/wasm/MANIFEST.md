# Vendored grammar wasm — provenance manifest

Every `.wasm` in this directory is a byte copy of the prebuilt artifact from
upstream codegraph `src/extraction/wasm/` (MIT; upstream repo snapshot
`6a056ec5db35172f9dc348f87b54ea415aa5169e`, vendoring commits c5eebe6 /
03d54e4 / c2503e2 / f1ca991 / 1909931 / a6c62d7 / 09e301b / 45a53eb /
d1b75a1 / 44561b6). Each artifact is built from the SAME grammar revision the
native extraction kernel compiles (`codegraph-kernel/Cargo.toml` pins) —
parser.c/scanner.c sha-matched against the crates.io tarball unless noted.
The `kernel-grammar-parity` test asserts ABI + node-kind + field-table
identity between the two arms; bump the crate pin and the vendored wasm
together, and update this manifest.

`jsx` shares `tree-sitter-javascript.wasm` (mirrors the kernel's langs.rs).
`objc` is NOT vendored — it still resolves from the tree-sitter-wasms npm
package (the kernel has no objc arm; no parity constraint).

| file | language(s) | grammar revision (pinned) | sha256 |
| --- | --- | --- | --- |
| tree-sitter-typescript.wasm | typescript | tree-sitter-typescript v0.23.2 (f975a62) | 3a44d634c9840dccec36f33b99592bd086a2f940e9cd80c64347c45b7dce662f |
| tree-sitter-tsx.wasm | tsx | tree-sitter-typescript v0.23.2 (f975a62), tsx variant | 8f647a1b2cafe9ab00fb2056d79021d2a144ba17a72f45511072311c1b05d08e |
| tree-sitter-javascript.wasm | javascript, jsx | tree-sitter-javascript v0.25.0 (44c892e) | 7978e62bcc851ab1d1f6dcd4678f9eda79df2b3b3490e75f81dd819d9bccccfa |
| tree-sitter-java.wasm | java | tree-sitter-java v0.23.5 (94703d5) | 181a6fbc34d7864a551d91c13882fc33007e923b3c81a4bdbe7fa47492090077 |
| tree-sitter-python.wasm | python | tree-sitter-python v0.23.6 (bffb65a) | a7fdc587e77bd729b9f5b783c659be23c896e305a2c374472bed7114d9e01fac |
| tree-sitter-go.wasm | go | tree-sitter-go v0.23.4 (3c3775f) | 4eda5d91c99ca981e88bc7d3d33f0db166b4bab0a84d0021a9abf39b364c78ef |
| tree-sitter-c.wasm | c | tree-sitter-c =0.24.2 (b780e47) | a271e584616c7c3c0ac663f01cd05dd5f1a6c2ce6d4cd23096548985a95d0ccb |
| tree-sitter-cpp.wasm | cpp | tree-sitter-cpp =0.23.4 (f41e1a0) | 70f5e2b9976dad56bdcd1fafcb3af8c839c7a92e7beaa437162bcf45f390e83d |
| tree-sitter-rust.wasm | rust | tree-sitter-rust =0.24.2 (77a3747) | 206031e0f67fb41ecae505868ca3bb917df7375031aebafd2f97314a849713fe |
| tree-sitter-c_sharp.wasm | csharp | tree-sitter-c-sharp =0.23.5 (upstream #717; ABI 15, STATE_COUNT 8053, table-identical to the crate tarball) | 6f69e1cae44e1c32c1eccc170dc5a9778fb94ff716f71113fe1f8c4299aa2f40 |
| tree-sitter-ruby.wasm | ruby | tree-sitter-ruby =0.23.1 (71bd32f; ABI stays 14 — the tag predates the ABI-15 generator; parity asserts same-revision, not same-ABI) | 4cb5a4b12870876ca864c1e92fe1f5cd47036b2adc083e9306488af88867dbb4 |
| tree-sitter-php.wasm | php | tree-sitter-php =0.24.2 (5b5627f), FULL `php` variant (HTML interleaving — never php_only) | 6545a9a110bc878e26ed329950147e190c83da038bb17e999de646fe6c4d6c82 |
| tree-sitter-swift.wasm | swift | tree-sitter-swift crate =0.7.3, built from the CRATE TARBALL src/ (NOT a tag sha-match: the tag's checked-in parser.c is an older ABI-14 generation; grammar.json rules are JSON-equal — table identity by construction) | cc77a63b8487956270e2f385e29a03ba0773ba532a3c8a8844a26b4c98793843 |
| tree-sitter-kotlin.wasm | kotlin | tree-sitter-kotlin fwcd 0.3.8 (tag e1a2d5a) — upstream prebuilt artifact, byte-copied 2026-09-16 | c80c88867a589a1a0959bcea89de84b7e9684b3693b2cdb2944812458e62ff48 |
| tree-sitter-dart.wasm | dart | dart vendored from the upstream artifact (byte-identical to tree-sitter-wasms 0.1.13's build, whose github ref is UNPINNED — vendoring removes the silent-drift risk of a routine dependency bump) | 7f5364e4256cf7e55efd01dd52421ef2663caa8061b82659b7e4bf61064545ec |
| tree-sitter-lua.wasm | lua | lua vendored C (build.rs; v0.4.1 revision, not on crates.io); ABI 15 | 6d95607fc7d78964cfdf065ccb1ba76be5ed217c5ec0d0a3cace13c59fa1ae43 |
| tree-sitter-luau.wasm | luau | tree-sitter-grammars luau v1.2.0 (parser.c 8f25bc17… / scanner.c a157bb52…); ABI 14 | f1647052518f2bdfae8e8c0b033ffdeca1193d69d11c78ba20f84c8374fd0fe3 |
| tree-sitter-pascal.wasm | pascal | (no kernel arm in the fork's parity gate; historical vendor) | be3634fca99c19f5e1035a1a9c7d93d6ee82b35e6d5024f02be4883b71329c3e |
| tree-sitter-scala.wasm | scala | scala vendored C (kernel build.rs grammars/scala) | 7945b13e6f9b15b578c5e5e4e60253c049fec07c531518163f3415a76c0621aa |

Note: kotlin and dart were vendored as the hardening follow-up (2026-09-16) —
both now load from this directory like every other kernel-routable language.
Only `objc` still resolves through tree-sitter-wasms (no kernel arm; outside
the parity gate). The grammar-parity test asserts all 19 gate languages
strictly against these artifacts.
