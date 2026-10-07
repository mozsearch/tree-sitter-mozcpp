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
  // init-captures, default arguments without declarators, and concatenated
  // strings, below.)
  conflicts: ($, original) => original.concat([
    [$._declarator, $.type_specifier, $.expression, $.call_expression],
    [$.expression, $.call_expression],
    [$._declarator, $.expression, $.call_expression],
    [$.type_specifier, $.expression, $.call_expression],
    [$.expression, $.call_expression, $.lambda_capture_initializer],
    [$._abstract_declarator, $.optional_parameter_declaration],
    [$.pointer_declarator, $.abstract_pointer_declarator],
    [$._string, $.concatenated_string],
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
