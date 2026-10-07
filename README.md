# tree-sitter-mozcpp

[tree-sitter-cpp](https://github.com/tree-sitter/tree-sitter-cpp) with
Mozilla's (Gecko's) macros, for [searchfox](https://searchfox.org)'s history
tokenizer.  It's a fork of
[rust-code-analysis](https://github.com/mozilla/rust-code-analysis)'s
tree-sitter-mozcpp (by Calixte Denizet), which is an overlay on
tree-sitter-cpp: `grammar.js` extends tree-sitter-cpp's grammar.

## Differences from tree-sitter-cpp

From rust-code-analysis's tree-sitter-mozcpp:
- Top-level macros alone on their lines (`alone_macro`, ex: `NS_IMETHODIMP`,
  and `alone_macro_call`, ex: `U_NAMESPACE_BEGIN(FOO)`).
- Mozilla's annotation macros (`macro_annotation`, ex: `MOZ_CAN_RUN_SCRIPT`,
  `MOZ_STACK_CLASS`) where tree-sitter-cpp takes storage class specifiers,
  after parameter lists, and after `class`/`struct`.
- Calls of macros whose first argument is a declaration
  (`QM_TRY_INSPECT(const auto& foo, ...)`).
- Windows types (`DWORD`, `HANDLE`, ...) as primitive types.

## Building

The generated parser (`src/parser.c`, `src/grammar.json`,
`src/node-types.json`, `src/tree_sitter/`) is committed, so the Rust crate
builds without node.  To regenerate it after changing `grammar.js`:

```sh
npm ci --ignore-scripts
# (The CLI's install script downloads its binary.)
(cd node_modules/tree-sitter-cli && node install.js)
npx tree-sitter generate
npx tree-sitter test
cargo test
```

`package.json` pins tree-sitter-cpp to 0.23.4 and tree-sitter-c to 0.23.1, the
versions of the tree-sitter-cpp 0.23.4 crate's generated parser, and
`src/scanner.c` is tree-sitter-cpp 0.23.4's with its symbols renamed from
`tree_sitter_cpp_*` to `tree_sitter_mozcpp_*`, so that both grammars can be
linked into one program.
