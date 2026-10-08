# tree-sitter-mozcpp

[tree-sitter-cpp](https://github.com/tree-sitter/tree-sitter-cpp) with
Mozilla's (Gecko's) macros, for [searchfox](https://searchfox.org)'s history
tokenizer.  It's a fork of
[rust-code-analysis](https://github.com/mozilla/rust-code-analysis)'s
tree-sitter-mozcpp (by Calixte Denizet), which is an overlay on
tree-sitter-cpp: `grammar.js` extends tree-sitter-cpp's grammar.

## Differences from tree-sitter-cpp

Gecko (and the libraries it vendors) use macros in ways that tree-sitter-cpp
can't parse, which make it misparse whole files: ex: a class ending in
`NS_DECL_ISUPPORTS` (no semicolon) followed by `};` never closes, so the rest of
the file nests in it.  Rather than lists of macros, this grammar recognizes
macros by their shapes, with its external scanner deciding which ALL-CAPS
names are macros by what's around them (see `scan_macro_start` in
`src/scanner.c`), so that the grammar doesn't have to consider each name as
both a macro and ordinary code:
- `macro_invocation`: statement-like macros on lines of their own, in
  classes (`NS_DECL_ISUPPORTS`, `NS_INLINE_DECL_REFCOUNTING(Foo)`), namespaces
  (`NS_IMPL_ISUPPORTS(Foo, nsIRunnable)`), and functions: an ALL-CAPS name
  first on its line, with optional arguments, ending the line, and not
  continued by the next line (ex: by `{` or `:`).  In classes, they can also
  end with a semicolon (`DEFINE_SIZE_STATIC (6);`).
- `macro_type_specifier`: macros that expand to declarations' types
  (`NS_IMETHOD_(void) Foo();`, `static MOZ_THREAD_LOCAL(uint32_t) sFoo;`).
- `macro_annotation`: annotation macros before declarations (`SQLITE_API int
  foo();`, `MOZ_CAN_RUN_SCRIPT void Foo();`, but not `HANDLE h;`), after
  `class` and `struct` (`class MOZ_STACK_CLASS Foo`), after pointers' `*`s
  (`T* PROTOBUF_NONNULL foo()`), after declarations' types (`int XMLCALL
  foo()`, but not `uint32_t SSRC() const`), before constructors (`MOZ_IMPLICIT
  Foo(int aX) : mX(aX) {}`), and after declarators and functions' parameters
  (`int mX MOZ_GUARDED_BY(mMutex);`, `void Foo() final MOZ_REQUIRES(mMutex);`).
- Macros' arguments (`macro_arguments`) are tokens in balanced parentheses,
  since they can be anything (ex: `REFLEXIVE_EQUALITY_OPERATORS(const
  StaticAutoPtr<T>&, U*, lhs.get() == rhs, class T, class U)`).
- Calls of macros whose first argument is a declaration
  (`QM_TRY_INSPECT(const auto& foo, GetFoo());`).

And fixes to tree-sitter-cpp 0.23.4:
- Strings concatenated with macros in the middle (`"a" PRIu32 "b"`).
- Lambdas' parenthesized and braced init-captures (`[self(self)]`).
- Pointer-to-member calls with `->*` (`(this->*aMethod)()`).
- Default arguments without declarators (`const Foo* = nullptr`).
- Pure virtual functions' `0` is a `number_literal` (an anonymous regex in
  tree-sitter-cpp, which isn't in its trees).

And Objective-C's expressions and statements, for Objective-C++'s C++
(searchfox parses Objective-C++'s Objective-C declarations, ex:
`@implementation ... @end`, with tree-sitter-objc, and the rest with this):
- `message_expression`: message sends (`[[NSFoo alloc] initWithName:aName
  count:1]`, `[NSFoo class]`), whose receivers are names, messages,
  casts, and calls, members, and subscripts of them, so that `[&self =
  *this]` is still a lambda's capture and `[[clang::foo]]` an attribute.
- Literals: `objc_string_literal` (`@"a"`, and concatenated, `@"a" @"b"`, a
  `concatenated_string`), `selector_expression`,
  `protocol_expression`, `encode_expression`, `boxed_expression` (`@(x)`,
  `@1`, `@YES`), `array_literal`, `dictionary_literal`, and
  `availability_expression` (`@available(macOS 11.0, *)`,
  `__builtin_available(...)`).
- Blocks: `block_literal` (`^{ ... }`, `^(id aX) { ... }`, `^BOOL(id aX) {
  ... }`) and `block_pointer_declarator` (`void (^aCallback)(int)`).
- Statements: `autoreleasepool_statement`, `objc_try_statement`,
  `synchronized_statement`, `objc_throw_statement`, and `for_in_statement`
  (`for (NSString* name in names)`).
- ARC's and nullability's qualifiers (`__bridge`, `__weak`, `_Nullable`,
  ...).

What it doesn't handle: preprocessor conditionals inside declarations or
expressions (ex: `#ifdef DEBUG` in a constructor's initializers), which
tree-sitter-cpp only parses around whole statements and declarations
(searchfox's tokenizer parses only conditionals' first branches, blanking the
rest, and then those separately); `"*/"` in `#define`s' strings; and macros
with mixed-case names, ex: one that is a function's body.

This was rust-code-analysis's tree-sitter-mozcpp, whose grammar listed
Gecko's annotation macros (`MOZ_CAN_RUN_SCRIPT`, ...), `QM_TRY_*`-style
macros, top-level macros alone on their lines, and Windows types (`DWORD`,
...), but not class-scope macros (which it handled from 2019-12 to 2020-04).
Its lists are replaced by the above, which also don't make those names
keywords.

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
