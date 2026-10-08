/**
 * tree-sitter-cpp with Mozilla's (Gecko's) macros: rules for the shapes macros
 * take in Gecko and the libraries it vendors, rather than lists of macros.
 * The external scanner decides which ALL-CAPS names are macros, by what's
 * around them (see `scan_macro_start` in src/scanner.c), so that the grammar
 * doesn't have to consider each name as both a macro and ordinary code.  See
 * the README.
 */

const CPP = require("tree-sitter-cpp/grammar");
// (Which tree-sitter-cpp extends.)
const PREC = require("tree-sitter-c/grammar").PREC;

module.exports = grammar(CPP, {
  name: 'mozcpp',

  externals: ($, original) => original.concat([
    $._macro_line_start,
    $._macro_statement_start,
    $._type_macro_start,
    $._specifier_annotation_start,
    $._leading_annotation_start,
    $._trailing_annotation_start,
    $._constructor_annotation_start,
    $._post_type_annotation_start,
  ]),

  // (For macro calls whose first argument is a declaration, lambdas'
  // init-captures, default arguments without declarators, concatenated
  // strings, and Objective-C's message sends, below.)
  conflicts: ($, original) => original.concat([
    [$._declarator, $.type_specifier, $.expression, $.call_expression],
    [$.expression, $.call_expression],
    [$._declarator, $.expression, $.call_expression],
    [$.type_specifier, $.expression, $.call_expression],
    [$.expression, $.call_expression, $.lambda_capture_initializer],
    [$._abstract_declarator, $.optional_parameter_declaration],
    [$.pointer_declarator, $.abstract_pointer_declarator],
    [$._string, $.concatenated_string],
    [$.attribute, $._message_receiver],
    [$.lambda_capture_initializer, $._message_receiver],
    [$.expression, $.call_expression, $.lambda_capture_initializer, $._message_receiver],
    [$.expression, $._message_receiver],
    [$.attribute, $._scope_resolution],
  ]),

  rules: {
    _top_level_item: ($, original) => choice(
      original,
      $.macro_invocation,
    ),

    // (Namespaces' bodies, and functions'.)
    _block_item: ($, original) => choice(
      original,
      $.macro_invocation,
    ),

    _field_declaration_list_item: ($, original) => choice(
      original,
      $.macro_invocation,
      alias($._macro_statement, $.macro_invocation),
    ),

    // A statement-like macro on a line of its own, ex: `NS_DECL_ISUPPORTS` or
    // `NS_INLINE_DECL_REFCOUNTING_INHERITED(A, B)` in a class, or
    // `NS_IMPL_ISUPPORTS(Foo, nsIRunnable)` in a namespace: an ALL-CAPS name
    // first on its line, with optional arguments, ending the line (or, in
    // classes, followed by a semicolon, ex: `DEFINE_SIZE_STATIC (6);`).
    // (A `(` after a macro's name starts its arguments: the scanner checked.)
    macro_invocation: $ => prec.right(seq(
      $._macro_line_start,
      field('name', $.identifier),
      optional(field('arguments', $.macro_arguments)),
    )),
    _macro_statement: $ => seq(
      $._macro_statement_start,
      field('name', $.identifier),
      optional(field('arguments', $.macro_arguments)),
      ';',
    ),

    // Macros' arguments can be anything (ex: types, or `lhs.get() == rhs,
    // class T`), so they're tokens, in balanced parentheses.
    macro_arguments: $ => seq('(', repeat($._macro_token), ')'),
    _macro_token: $ => choice(
      $.macro_arguments,
      $.identifier,
      $.number_literal,
      $.string_literal,
      $.raw_string_literal,
      $.char_literal,
      $.primitive_type,
      $.true,
      $.false,
      $.null,
      $.this,
      'auto', 'class', 'const', 'constexpr', 'decltype', 'delete', 'enum',
      'explicit', 'final', 'friend', 'inline', 'long', 'mutable', 'new',
      'noexcept', 'operator', 'override', 'private', 'protected', 'public',
      'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'template',
      'typename', 'union', 'unsigned', 'virtual', 'volatile',
      ',', ';', '::', '->', '->*', '.', '.*', '...', '?', ':', '+', '-', '*',
      '/', '%', '&', '|', '^', '~', '!', '=', '<', '>', '[', ']', '{', '}',
      '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '++', '--', '+=', '-=',
      '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '<=>',
    ),

    // A macro that expands to a declaration's type, ex:
    // `NS_IMETHOD_(void) Foo();` or `static MOZ_THREAD_LOCAL(uint32_t) sFoo;`.
    type_specifier: ($, original) => choice(
      original,
      $.macro_type_specifier,
    ),
    macro_type_specifier: $ => seq(
      $._type_macro_start,
      field('name', $.identifier),
      field('arguments', $.macro_arguments),
    ),

    // Annotation macros, ex: `SQLITE_API` and `MOZ_CAN_RUN_SCRIPT` before
    // declarations, `MOZ_STACK_CLASS` after `class`, `PROTOBUF_NONNULL` after
    // a pointer's `*`, `XMLCALL` after a declaration's type, and
    // `MOZ_GUARDED_BY(mMutex)` and `MOZ_REQUIRES(mMutex)` after declarators and
    // functions' parameters, and `MOZ_IMPLICIT` before constructors.
    specifier_annotation: $ => prec.right(seq(
      $._specifier_annotation_start,
      field('name', $.identifier),
      optional(field('arguments', $.macro_arguments)),
    )),
    leading_annotation: $ => prec.right(seq(
      $._leading_annotation_start,
      field('name', $.identifier),
      optional(field('arguments', $.macro_arguments)),
    )),
    trailing_annotation: $ => prec.right(seq(
      $._trailing_annotation_start,
      field('name', $.identifier),
      optional(field('arguments', $.macro_arguments)),
    )),

    post_type_annotation: $ => seq(
      $._post_type_annotation_start,
      field('name', $.identifier),
    ),
    constructor_annotation: $ => prec.right(seq(
      $._constructor_annotation_start,
      field('name', $.identifier),
      optional(field('arguments', $.macro_arguments)),
    )),
    _constructor_specifiers: ($, original) => choice(
      original,
      alias($.constructor_annotation, $.macro_annotation),
      // (Ex: `SK_ALWAYS_INLINE constexpr explicit operator bool()`.)
      alias($.specifier_annotation, $.macro_annotation),
    ),

    _declaration_specifiers: $ => prec.right(seq(
      repeat(choice($._declaration_modifiers, alias($.specifier_annotation, $.macro_annotation))),
      field('type', $.type_specifier),
      repeat(choice($._declaration_modifiers, alias($.post_type_annotation, $.macro_annotation))),
    )),

    _class_declaration: $ => seq(
      repeat(choice($.attribute_specifier, $.alignas_qualifier, alias($.leading_annotation, $.macro_annotation))),
      optional($.ms_declspec_modifier),
      repeat($.attribute_declaration),
      $._class_declaration_item,
    ),

    pointer_declarator: $ => prec.dynamic(1, prec.right(seq(
      optional($.ms_based_modifier),
      '*',
      repeat($.ms_pointer_modifier),
      repeat(choice($.type_qualifier, alias($.leading_annotation, $.macro_annotation))),
      field('declarator', $._declarator),
    ))),
    pointer_field_declarator: $ => prec.dynamic(1, prec.right(seq(
      optional($.ms_based_modifier),
      '*',
      repeat($.ms_pointer_modifier),
      repeat(choice($.type_qualifier, alias($.leading_annotation, $.macro_annotation))),
      field('declarator', $._field_declarator),
    ))),

    _function_declarator_seq: $ => seq(
      field('parameters', $.parameter_list),
      optional($._function_attributes_start),
      optional($.ref_qualifier),
      optional($._function_exception_specification),
      optional($._function_attributes_end),
      repeat(alias($.trailing_annotation, $.macro_annotation)),
      optional($.trailing_return_type),
      optional($._function_postfix),
      // (Ex: `Foo() final MOZ_REQUIRES(mMutex)`.)
      repeat(alias($.trailing_annotation, $.macro_annotation)),
    ),

    declaration: $ => seq(
      $._declaration_specifiers,
      commaSep1(field('declarator', choice(
        seq(
          $._declarator,
          repeat(alias($.trailing_annotation, $.macro_annotation)),
          optional($.gnu_asm_expression),
        ),
        $.init_declarator,
      ))),
      ';',
    ),

    field_declaration: $ => seq(
      $._declaration_specifiers,
      commaSep(seq(
        field('declarator', $._field_declarator),
        repeat(alias($.trailing_annotation, $.macro_annotation)),
        optional(choice(
          $.bitfield_clause,
          field('default_value', $.initializer_list),
          seq('=', field('default_value', choice($.expression, $.initializer_list))),
        )),
      )),
      optional($.attribute_specifier),
      ';',
    ),

    parameter_declaration: $ => seq(
      $._declaration_specifiers,
      optional(field('declarator', choice(
        $._declarator,
        $._abstract_declarator,
      ))),
      repeat(choice($.attribute_specifier, alias($.trailing_annotation, $.macro_annotation))),
    ),

    // (tree-sitter-cpp requires a declarator, ex: `const Foo* = nullptr` isn't
    // one.)
    optional_parameter_declaration: $ => seq(
      $._declaration_specifiers,
      field('declarator', optional(choice($._declarator, $.abstract_reference_declarator, $._abstract_declarator))),
      '=',
      field('default_value', $.expression),
    ),

    // A call of a macro whose first argument is a declaration, ex:
    // `QM_TRY_INSPECT(const auto& foo, GetFoo())`.
    call_expression: ($, original) => choice(
      original,
      prec.dynamic(-1, seq(
        field('function', $.identifier),
        field('arguments', alias($.macro_declaration_argument_list, $.argument_list)),
      )),
    ),
    macro_declaration_argument_list: $ => seq(
      '(',
      $.parameter_declaration,
      repeat(seq(',', choice($.expression, $.initializer_list, $.compound_statement))),
      ')',
    ),

    // ## Objective-C's expressions and statements, in Objective-C++'s C++
    // (searchfox parses Objective-C++'s Objective-C declarations, ex:
    // `@implementation`, with tree-sitter-objc).

    // Message sends: `[obj foo]`, `[Cls fooWith:a and:b]`, `[NSString
    // stringWithFormat:@"%d", x]`.  (Selectors' parts can be some keywords,
    // ex: `[NSFoo class]`.)
    message_expression: $ => choice(
      seq('[', $._message_body, ']'),
      // (`[[NSFoo alloc] init]`, whose `[[` is a token, for attributes.)
      seq('[[', alias($._inner_message, $.message_expression), $._message_arguments, ']'),
    ),
    _inner_message: $ => seq($._message_body, ']'),
    // (Attributes' `prefix::name` has `_scope_resolution`'s precedence, so
    // that `[[clang::foo]]` and a message send to a qualified receiver,
    // `[[ns::Foo alloc] init]`, are a conflict, rather than the latter
    // winning.)
    attribute: $ => seq(
      choice(
        prec(1, seq(field('prefix', $.identifier), '::', field('name', $.identifier))),
        field('name', $.identifier),
      ),
      optional($.argument_list),
    ),
    // (Receivers are names, other messages, casts, and the like, and calls,
    // members, and subscripts of them, not ex: `&self`, which would make
    // `[&self = *this]`, a lambda's capture, a message's start.)
    _message_body: $ => seq(field('receiver', $._message_receiver), $._message_arguments),
    _message_receiver: $ => choice(
      $.identifier,
      $.qualified_identifier,
      $.template_function,
      $.this,
      $.message_expression,
      $.parenthesized_expression,
      $.cast_expression,
      $.objc_string_literal,
      alias($._receiver_call, $.call_expression),
      alias($._receiver_field, $.field_expression),
      alias($._receiver_subscript, $.subscript_expression),
    ),
    _receiver_call: $ => prec(PREC.CALL, seq(
      field('function', $._message_receiver),
      field('arguments', $.argument_list),
    )),
    _receiver_field: $ => prec(PREC.FIELD, seq(
      field('argument', $._message_receiver),
      field('operator', choice('.', '->')),
      field('field', choice($._field_identifier, $.template_method)),
    )),
    _receiver_subscript: $ => prec(PREC.SUBSCRIPT, seq(
      field('argument', $._message_receiver),
      field('indices', $.subscript_argument_list),
    )),
    _message_arguments: $ => choice(
      field('selector', $._selector_part),
      seq(
        repeat1($.keyword_argument),
        repeat(seq(',', field('argument', $.expression))),
      ),
    ),
    keyword_argument: $ => seq(
      optional(field('keyword', $._selector_part)),
      ':',
      field('argument', $.expression),
    ),
    // (Of C++'s keywords, selectors' parts can only be `class` and `new`
    // (the ones Gecko's use) and `delete`: more of them made error recovery
    // worse, ex: with `void` as one, a macro call before `void
    // operator<<(...);` took it.)
    _selector_part: $ => choice(
      $.identifier,
      alias(choice('class', 'new', 'delete'), $.identifier),
    ),

    // `@"..."` (concatenated with more, a `concatenated_string`: `@"a" @"b"`,
    // `@"a" "b"`),
    // `@selector(foo:bar:)`, `@protocol(Foo)`, `@encode(int)`, boxed values
    // and collections: `@(x)`, `@1`, `@YES`, `@[a, b]`, `@{k: v}`, and
    // availability checks: `@available(macOS 11.0, *)` (and C++'s
    // `__builtin_available(...)`).
    objc_string_literal: $ => seq('@', $.string_literal),
    _objc_concatenated_string: $ => prec.right(seq(
      $.objc_string_literal,
      repeat1(choice($.objc_string_literal, $.string_literal)),
    )),
    selector_expression: $ => seq(
      '@selector',
      '(',
      repeat1(choice($._selector_part, ':')),
      ')',
    ),
    // (Protocols' names can be macros', ex: `@protocol(RTC_OBJC_TYPE(Foo))`.)
    protocol_expression: $ => seq('@protocol', '(', choice($.identifier, $.call_expression), ')'),
    encode_expression: $ => seq('@encode', '(', $.type_descriptor, ')'),
    boxed_expression: $ => seq('@', choice(
      seq('(', $.expression, ')'),
      $.number_literal,
      seq('-', $.number_literal),
      $.char_literal,
      $.identifier,
      $.true,
      $.false,
    )),
    array_literal: $ => seq('@', '[', commaSep($.expression), optional(','), ']'),
    dictionary_literal: $ => seq(
      '@',
      '{',
      commaSep($.dictionary_pair),
      optional(','),
      '}',
    ),
    dictionary_pair: $ => seq(
      field('key', $.expression),
      ':',
      field('value', $.expression),
    ),
    availability_expression: $ => seq(
      choice('@available', '__builtin_available'),
      '(',
      commaSep1(choice(seq($.identifier, optional($.version_number)), '*')),
      ')',
    ),
    version_number: _ => /\d+(\.\d+)*/,

    // Blocks: `^{ ... }`, `^(int aX) { ... }`, and with a return type,
    // `^BOOL(id aX) { ... }`, whose type has the parameters.
    block_literal: $ => seq(
      '^',
      optional(choice(
        field('parameters', $.parameter_list),
        field('type', $.type_descriptor),
      )),
      field('body', $.compound_statement),
    ),

    _expression_not_binary: ($, original) => choice(
      original,
      $.message_expression,
      $.objc_string_literal,
      alias($._objc_concatenated_string, $.concatenated_string),
      $.selector_expression,
      $.protocol_expression,
      $.encode_expression,
      $.boxed_expression,
      $.array_literal,
      $.dictionary_literal,
      $.availability_expression,
      $.block_literal,
    ),

    // Blocks' types: `void (^aCallback)(int)`, `void (^)(int)`.
    block_pointer_declarator: $ => prec.dynamic(1, prec.right(seq(
      '^',
      repeat($.type_qualifier),
      field('declarator', $._declarator),
    ))),
    block_pointer_field_declarator: $ => prec.dynamic(1, prec.right(seq(
      '^',
      repeat($.type_qualifier),
      field('declarator', $._field_declarator),
    ))),
    abstract_block_pointer_declarator: $ => prec.dynamic(1, prec.right(seq(
      '^',
      repeat($.type_qualifier),
      field('declarator', optional($._abstract_declarator)),
    ))),
    _declarator: ($, original) => choice(original, $.block_pointer_declarator),
    _field_declarator: ($, original) => choice(
      original,
      alias($.block_pointer_field_declarator, $.block_pointer_declarator),
    ),
    _abstract_declarator: ($, original) => choice(original, $.abstract_block_pointer_declarator),

    // ARC's and nullability's qualifiers, ex: `(__bridge id)aRef`.
    type_qualifier: ($, original) => choice(
      original,
      '__weak', '__strong', '__unsafe_unretained', '__autoreleasing', '__block',
      '__bridge', '__bridge_retained', '__bridge_transfer', '_Nullable',
      '_Null_unspecified', '__nullable', '__nonnull', '__kindof',
    ),

    // `@autoreleasepool { ... }`, `@try { ... } @catch (NSException* e) { ...
    // } @finally { ... }`, `@synchronized (obj) { ... }`, `@throw e;`.
    autoreleasepool_statement: $ => seq('@autoreleasepool', field('body', $.compound_statement)),
    objc_try_statement: $ => seq(
      '@try',
      field('body', $.compound_statement),
      repeat($.objc_catch_clause),
      optional(seq('@finally', field('finally', $.compound_statement))),
    ),
    objc_catch_clause: $ => seq(
      '@catch',
      '(',
      choice($.parameter_declaration, '...'),
      ')',
      field('body', $.compound_statement),
    ),
    synchronized_statement: $ => seq(
      '@synchronized',
      '(',
      $.expression,
      ')',
      field('body', $.compound_statement),
    ),
    objc_throw_statement: $ => seq('@throw', optional($.expression), ';'),
    // Fast enumeration: `for (NSString* name in names) { ... }`, `for (name in
    // names) { ... }`.
    for_in_statement: $ => seq(
      'for',
      '(',
      choice(
        seq($._declaration_specifiers, field('declarator', $._declarator)),
        field('left', $.identifier),
      ),
      'in',
      field('right', $.expression),
      ')',
      field('body', $.statement),
    ),
    _non_case_statement: ($, original) => choice(
      original,
      $.autoreleasepool_statement,
      $.objc_try_statement,
      $.synchronized_statement,
      $.objc_throw_statement,
      $.for_in_statement,
    ),

    // (tree-sitter-cpp only has `=` initializers, not `[self(self)]` or
    // `[self{self}]`.)
    lambda_capture_initializer: $ => seq(
      optional('&'),
      optional('...'),
      field('left', $.identifier),
      choice(
        seq('=', field('right', $.expression)),
        field('right', choice($.argument_list, $.initializer_list)),
      ),
    ),

    // (tree-sitter-cpp has `.*`, but not `->*`, ex: `(this->*aMethod)()`.)
    field_expression: $ => seq(
      prec(PREC.FIELD, seq(
        field('argument', $.expression),
        field('operator', choice('.', '.*', '->', '->*')),
      )),
      field('field', choice(
        prec.dynamic(1, $._field_identifier),
        alias($.qualified_field_identifier, $.qualified_identifier),
        $.destructor_name,
        $.template_method,
        alias($.dependent_field_identifier, $.dependent_name),
      )),
    ),

    // tree-sitter-cpp requires a string second (ex: `"a" B "c"` isn't one).
    concatenated_string: $ => prec.right(seq(
      choice(
        seq($.identifier, choice($.string_literal, $.raw_string_literal)),
        seq(
          choice($.string_literal, $.raw_string_literal),
          choice($.identifier, $.string_literal, $.raw_string_literal),
        ),
      ),
      repeat(choice($.identifier, $.string_literal, $.raw_string_literal)),
    )),
  },
});

function commaSep(rule) {
  return optional(commaSep1(rule));
}

function commaSep1(rule) {
  return seq(rule, repeat(seq(',', rule)));
}
