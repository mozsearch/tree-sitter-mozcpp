#include "tree_sitter/alloc.h"
#include "tree_sitter/parser.h"

#include <assert.h>
#include <string.h>
#include <wctype.h>

enum TokenType {
    RAW_STRING_DELIMITER,
    RAW_STRING_CONTENT,
    MACRO_LINE_START,
    MACRO_STATEMENT_START,
    TYPE_MACRO_START,
    SPECIFIER_ANNOTATION_START,
    LEADING_ANNOTATION_START,
    TRAILING_ANNOTATION_START,
    CONSTRUCTOR_ANNOTATION_START,
    POST_TYPE_ANNOTATION_START,
};

/// The spec limits delimiters to 16 chars
#define MAX_DELIMITER_LENGTH 16

typedef struct {
    uint8_t delimiter_length;
    wchar_t delimiter[MAX_DELIMITER_LENGTH];
} Scanner;

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void reset(Scanner *scanner) {
    scanner->delimiter_length = 0;
    memset(scanner->delimiter, 0, sizeof scanner->delimiter);
}

/// Scan the raw string delimiter in R"delimiter(content)delimiter"
static bool scan_raw_string_delimiter(Scanner *scanner, TSLexer *lexer) {
    if (scanner->delimiter_length > 0) {
        // Closing delimiter: must exactly match the opening delimiter.
        // We already checked this when scanning content, but this is how we
        // know when to stop. We can't stop at ", because R"""hello""" is valid.
        for (int i = 0; i < scanner->delimiter_length; ++i) {
            if (lexer->lookahead != scanner->delimiter[i]) {
                return false;
            }
            advance(lexer);
        }
        reset(scanner);
        return true;
    }

    // Opening delimiter: record the d-char-sequence up to (.
    // d-char is any basic character except parens, backslashes, and spaces.
    for (;;) {
        if (scanner->delimiter_length >= MAX_DELIMITER_LENGTH || lexer->eof(lexer) || lexer->lookahead == '\\' ||
            iswspace(lexer->lookahead)) {
            return false;
        }
        if (lexer->lookahead == '(') {
            // Rather than create a token for an empty delimiter, we fail and
            // let the grammar fall back to a delimiter-less rule.
            return scanner->delimiter_length > 0;
        }
        scanner->delimiter[scanner->delimiter_length++] = lexer->lookahead;
        advance(lexer);
    }
}

/// Scan the raw string content in R"delimiter(content)delimiter"
static bool scan_raw_string_content(Scanner *scanner, TSLexer *lexer) {
    // The progress made through the delimiter since the last ')'.
    // The delimiter may not contain ')' so a single counter suffices.
    for (int delimiter_index = -1;;) {
        // If we hit EOF, consider the content to terminate there.
        // This forms an incomplete raw_string_literal, and models the code
        // well.
        if (lexer->eof(lexer)) {
            lexer->mark_end(lexer);
            return true;
        }

        if (delimiter_index >= 0) {
            if (delimiter_index == scanner->delimiter_length) {
                if (lexer->lookahead == '"') {
                    return true;
                }
                delimiter_index = -1;
            } else {
                if (lexer->lookahead == scanner->delimiter[delimiter_index]) {
                    delimiter_index += 1;
                } else {
                    delimiter_index = -1;
                }
            }
        }

        if (delimiter_index == -1 && lexer->lookahead == ')') {
            // The content doesn't include the )delimiter" part.
            // We must still scan through it, but exclude it from the token.
            lexer->mark_end(lexer);
            delimiter_index = 0;
        }

        advance(lexer);
    }
}


/// The longest macro invocation (with its arguments) we look for.
#define MAX_MACRO_LENGTH 16384

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

static inline bool is_macro_name_char(int32_t c) {
    return (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

static inline bool is_word_char(int32_t c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '$';
}

static inline bool is_line_space(int32_t c) { return c == ' ' || c == '\t' || c == '\f' || c == '\v' || c == '\r'; }

/// Advance past spaces, tabs, and comments on the current line (not the
/// newline; block comments may span lines), returning false at a line comment
/// continued onto the next line, or a comment that doesn't end.
static bool scan_rest_of_line_space(TSLexer *lexer, unsigned *length) {
    for (;;) {
        if (*length > MAX_MACRO_LENGTH) {
            return false;
        }
        if (is_line_space(lexer->lookahead)) {
            advance(lexer);
            ++*length;
        } else if (lexer->lookahead == '/') {
            advance(lexer);
            ++*length;
            if (lexer->lookahead == '/') {
                while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
                    if (lexer->lookahead == '\\') {
                        // (A line comment continued onto the next line.)
                        return false;
                    }
                    advance(lexer);
                    ++*length;
                }
                return true;
            }
            if (lexer->lookahead != '*') {
                return false;
            }
            advance(lexer);
            ++*length;
            for (;;) {
                if (lexer->eof(lexer) || *length > MAX_MACRO_LENGTH) {
                    return false;
                }
                if (lexer->lookahead == '*') {
                    advance(lexer);
                    ++*length;
                    if (lexer->lookahead == '/') {
                        advance(lexer);
                        ++*length;
                        break;
                    }
                } else {
                    advance(lexer);
                    ++*length;
                }
            }
        } else {
            return true;
        }
    }
}

/// Advance past a macro invocation's parenthesized arguments, from the `(`
/// to past the matching `)`, skipping strings, characters, and comments.
/// Arguments with preprocessor directives or raw strings aren't ones we
/// handle.
static bool scan_macro_arguments(TSLexer *lexer, unsigned *length) {
    int depth = 0;
    bool line_start = false;
    int32_t previous = 0;
    for (;;) {
        if (lexer->eof(lexer) || *length > MAX_MACRO_LENGTH) {
            return false;
        }
        int32_t c = lexer->lookahead;
        if (line_start && c == '#') {
            return false;
        }
        if (c == '\n') {
            line_start = true;
        } else if (!is_line_space(c)) {
            line_start = false;
        }
        if (c == '"' || (c == '\'' && !is_word_char(previous))) {
            if (c == '"' && previous == 'R') {
                return false;
            }
            int32_t quote = c;
            advance(lexer);
            ++*length;
            while (lexer->lookahead != quote) {
                if (lexer->eof(lexer) || lexer->lookahead == '\n' || *length > MAX_MACRO_LENGTH) {
                    return false;
                }
                if (lexer->lookahead == '\\') {
                    advance(lexer);
                    ++*length;
                }
                advance(lexer);
                ++*length;
            }
            advance(lexer);
            ++*length;
            previous = quote;
            continue;
        }
        if (c == '/') {
            advance(lexer);
            ++*length;
            if (lexer->lookahead == '/') {
                while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
                    advance(lexer);
                    ++*length;
                }
            } else if (lexer->lookahead == '*') {
                advance(lexer);
                ++*length;
                for (;;) {
                    if (lexer->eof(lexer) || *length > MAX_MACRO_LENGTH) {
                        return false;
                    }
                    if (lexer->lookahead == '*') {
                        advance(lexer);
                        ++*length;
                        if (lexer->lookahead == '/') {
                            advance(lexer);
                            ++*length;
                            break;
                        }
                    } else {
                        advance(lexer);
                        ++*length;
                    }
                }
            }
            previous = '/';
            continue;
        }
        if (c == '(') {
            depth++;
        } else if (c == ')') {
            depth--;
            if (depth == 0) {
                advance(lexer);
                ++*length;
                return true;
            }
        }
        previous = c;
        advance(lexer);
        ++*length;
    }
}

/// Advance past whitespace (including newlines) and comments, noting whether
/// there was a newline, returning false at a comment that doesn't end.
static bool scan_space(TSLexer *lexer, unsigned *length, bool *newline) {
    for (;;) {
        if (*length > MAX_MACRO_LENGTH) {
            return false;
        }
        int32_t c = lexer->lookahead;
        if (iswspace(c)) {
            if (c == '\n') {
                *newline = true;
            }
            advance(lexer);
            ++*length;
        } else if (c == '/') {
            advance(lexer);
            ++*length;
            if (lexer->lookahead == '/') {
                while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
                    advance(lexer);
                    ++*length;
                }
            } else if (lexer->lookahead == '*') {
                advance(lexer);
                ++*length;
                for (;;) {
                    if (lexer->eof(lexer) || *length > MAX_MACRO_LENGTH) {
                        return false;
                    }
                    if (lexer->lookahead == '\n') {
                        *newline = true;
                    }
                    if (lexer->lookahead == '*') {
                        advance(lexer);
                        ++*length;
                        if (lexer->lookahead == '/') {
                            advance(lexer);
                            ++*length;
                            break;
                        }
                    } else {
                        advance(lexer);
                        ++*length;
                    }
                }
            } else {
                // (A `/` that isn't a comment's, which we can't put back, so
                // it's the next character: `/` is never a declaration's.)
                return false;
            }
        } else {
            return true;
        }
    }
}

#define MAX_WORD_LENGTH 31

/// Advance past a word, ex: an identifier or keyword, into `word` (truncated).
static void scan_word(TSLexer *lexer, unsigned *length, char *word) {
    unsigned n = 0;
    while (is_word_char(lexer->lookahead)) {
        if (n < MAX_WORD_LENGTH) {
            word[n++] = (char)lexer->lookahead;
        }
        advance(lexer);
        ++*length;
    }
    word[n] = 0;
}

static bool is_macro_name(const char *word) {
    bool has_letter = false;
    unsigned n = 0;
    for (; word[n]; n++) {
        if (!is_macro_name_char(word[n])) {
            return false;
        }
        has_letter = has_letter || (word[n] >= 'A' && word[n] <= 'Z');
    }
    return n >= 2 && has_letter;
}

static bool is_one_of(const char *word, const char *const *words, unsigned count) {
    for (unsigned i = 0; i < count; i++) {
        if (strcmp(word, words[i]) == 0) {
            return true;
        }
    }
    return false;
}

/// Keywords which continue a declaration after its declarator or a function's
/// parameters, ex: `override`.
static const char *const CONTINUATION_KEYWORDS[] = {
    "override", "final", "const", "noexcept", "volatile", "requires", "throw",
};

/// Keywords which start declarations' types, ex: `void` in
/// `MOZ_FORMAT_PRINTF(1, 2) void Foo(...)`.
static const char *const TYPE_KEYWORDS[] = {
    "auto", "bool", "char", "class", "const", "constexpr", "double", "enum", "explicit",
    "extern", "float", "friend", "inline", "int", "long", "mutable", "short", "signed",
    "static", "struct", "template", "typename", "union", "unsigned", "virtual", "void",
    "volatile",
};

#define COUNT(array) (sizeof array / sizeof array[0])

/// What follows a macro (its name and any arguments), for deciding what the
/// macro is: the words of a declaration (names and keywords, with qualified
/// names and template arguments as one, and not counting `*`s and `&`s between
/// them) up to the next other character.
typedef struct {
    /// Whether a newline comes before the next character after the macro.
    bool newline;
    /// The next character after the macro.
    int32_t first;
    unsigned words;
    char first_word[MAX_WORD_LENGTH + 1];
    /// The character after the words.
    int32_t terminator;
    /// If that's a `(`, the character after the matching `)`.
    int32_t after_parentheses;
} Following;

#define MAX_FOLLOWING_WORDS 8

static bool scan_following(TSLexer *lexer, unsigned *length, Following *following) {
    following->newline = false;
    following->words = 0;
    following->first_word[0] = 0;
    if (!scan_space(lexer, length, &following->newline)) {
        return false;
    }
    following->first = lexer->eof(lexer) ? 0 : lexer->lookahead;
    bool ignored;
    while (following->words < MAX_FOLLOWING_WORDS) {
        int32_t c = lexer->lookahead;
        if ((c == '*' || c == '&') && following->words > 0) {
            // (Between a declaration's type and its declarator.  Not before
            // the first word, where they'd be operators, ex: in
            // `NS_SUCCEEDED(rv) && done`, nor `&&`, which is more often `and`
            // than an rvalue reference.)
            advance(lexer);
            ++*length;
            if (c == '&' && lexer->lookahead == '&') {
                following->terminator = '&';
                return true;
            }
        } else if (c == '~' || (is_word_char(c) && !(c >= '0' && c <= '9'))) {
            if (c == '~') {
                advance(lexer);
                ++*length;
            }
            char word[MAX_WORD_LENGTH + 1];
            scan_word(lexer, length, word);
            if (following->words == 0) {
                memcpy(following->first_word, word, sizeof word);
            }
            following->words++;
            // (Qualified names and template arguments are part of the word.)
            for (;;) {
                if (!scan_space(lexer, length, &ignored)) {
                    return false;
                }
                if (lexer->lookahead == '<') {
                    int depth = 0;
                    do {
                        if (lexer->eof(lexer) || *length > MAX_MACRO_LENGTH || lexer->lookahead == ';' ||
                            lexer->lookahead == '{') {
                            return false;
                        }
                        if (lexer->lookahead == '<') {
                            depth++;
                        } else if (lexer->lookahead == '>') {
                            depth--;
                        }
                        advance(lexer);
                        ++*length;
                    } while (depth > 0);
                } else if (lexer->lookahead == ':') {
                    advance(lexer);
                    ++*length;
                    if (lexer->lookahead != ':') {
                        following->terminator = ':';
                        return true;
                    }
                    advance(lexer);
                    ++*length;
                    if (!scan_space(lexer, length, &ignored)) {
                        return false;
                    }
                    if (lexer->lookahead == '~') {
                        advance(lexer);
                        ++*length;
                    }
                    if (!is_word_char(lexer->lookahead)) {
                        return false;
                    }
                    char rest[MAX_WORD_LENGTH + 1];
                    scan_word(lexer, length, rest);
                } else {
                    break;
                }
            }
        } else {
            break;
        }
        if (!scan_space(lexer, length, &ignored)) {
            return false;
        }
    }
    following->terminator = lexer->eof(lexer) ? 0 : lexer->lookahead;
    following->after_parentheses = 0;
    if (following->terminator == '(') {
        if (!scan_macro_arguments(lexer, length) || !scan_space(lexer, length, &ignored)) {
            return false;
        }
        following->after_parentheses = lexer->eof(lexer) ? 0 : lexer->lookahead;
    }
    return true;
}

/// A macro by its shape: an ALL-CAPS name, with optional (balanced, possibly
/// multi-line) arguments, which is
/// - a statement-like macro on a line of its own (`MACRO_LINE_START`): first
///   on its line, ending it, and not continued by the next line (ex: by `{`
///   or `:`), or followed by a semicolon (`MACRO_STATEMENT_START`, only where
///   the grammar takes one, in classes);
/// - a macro that expands to a declaration's type (`TYPE_MACRO_START`), ex:
///   `NS_IMETHOD_(void) Foo();`: with arguments, followed by a declarator (a
///   name followed by `(`, `;`, `=`, `,`, `[`, or `{`);
/// - an annotation before a declaration (`SPECIFIER_ANNOTATION_START`), ex:
///   `SQLITE_API int foo();`: followed by its type and declarator (at least
///   two words, unlike `HANDLE h;`);
/// - an annotation before a name (`LEADING_ANNOTATION_START`), ex: after
///   `class` or after a pointer's `*`;
/// - an annotation after a declaration's type (`POST_TYPE_ANNOTATION_START`),
///   ex: `int XMLCALL foo()`: without arguments (unlike `uint32_t SSRC()
///   const`), followed by a name;
/// - an annotation before a constructor's definition
///   (`CONSTRUCTOR_ANNOTATION_START`), ex: `MOZ_IMPLICIT Foo(int aX) : mX(aX)
///   {}`: followed by a name, parameters, and `:` or `{`;
/// - or an annotation after a declarator or a function's parameters
///   (`TRAILING_ANNOTATION_START`), ex: `int mFoo MOZ_GUARDED_BY(mMutex);`,
///   followed by the end of the declaration, another annotation, or a
///   keyword like `override`.
/// The tokens are zero-width, before the name, so that the grammar parses the
/// macro's name and arguments; they only say what the macro is.  (Where the
/// scanner decides, tree-sitter doesn't consider other parses, so these are
/// careful not to take ordinary code.)
static bool scan_macro_start(TSLexer *lexer, const bool *valid_symbols) {
    bool line_start = false;
    if (valid_symbols[MACRO_LINE_START] || valid_symbols[MACRO_STATEMENT_START]) {
        line_start = lexer->get_column(lexer) == 0;
    }
    while (iswspace(lexer->lookahead)) {
        if (lexer->lookahead == '\n') {
            line_start = true;
        }
        skip(lexer);
    }
    if (!is_macro_name_char(lexer->lookahead) || (lexer->lookahead >= '0' && lexer->lookahead <= '9')) {
        return false;
    }
    lexer->mark_end(lexer);

    unsigned length = 0;
    char name[MAX_WORD_LENGTH + 1];
    scan_word(lexer, &length, name);
    if (!is_macro_name(name)) {
        return false;
    }
    if (!scan_rest_of_line_space(lexer, &length)) {
        return false;
    }
    bool has_arguments = lexer->lookahead == '(';
    if (has_arguments) {
        if (!scan_macro_arguments(lexer, &length) || !scan_rest_of_line_space(lexer, &length)) {
            return false;
        }
    }

    if (line_start && lexer->lookahead == ';' && valid_symbols[MACRO_STATEMENT_START]) {
        advance(lexer);
        length++;
        if (!scan_rest_of_line_space(lexer, &length) || (lexer->lookahead != '\n' && !lexer->eof(lexer))) {
            return false;
        }
        lexer->result_symbol = MACRO_STATEMENT_START;
        return true;
    }
    bool line_end = lexer->lookahead == '\n' || lexer->eof(lexer);

    Following following;
    if (!scan_following(lexer, &length, &following)) {
        return false;
    }

    if (line_start && line_end && valid_symbols[MACRO_LINE_START]) {
        bool continued = false;
        switch (following.first) {
            case '{':
            case ':':
            case ',':
            case ')':
            case '.':
            case '?':
            case '=':
            case '+':
            case '-':
            case '*':
            case '/':
            case '%':
            case '&':
            case '|':
            case '^':
            case '<':
            case '>':
            case ';':
                continued = true;
                break;
            default:
                continued = is_one_of(following.first_word, CONTINUATION_KEYWORDS, COUNT(CONTINUATION_KEYWORDS));
        }
        if (!continued) {
            lexer->result_symbol = MACRO_LINE_START;
            return true;
        }
    }

    int32_t t = following.terminator;
    if (has_arguments && valid_symbols[TYPE_MACRO_START] && following.words == 1 &&
        !is_one_of(following.first_word, TYPE_KEYWORDS, COUNT(TYPE_KEYWORDS)) &&
        (t == '(' || t == ';' || t == '=' || t == ',' || t == '[' || t == '{')) {
        lexer->result_symbol = TYPE_MACRO_START;
        return true;
    }
    if (valid_symbols[CONSTRUCTOR_ANNOTATION_START] && following.words == 1 && t == '(' &&
        (following.after_parentheses == ':' || following.after_parentheses == '{')) {
        lexer->result_symbol = CONSTRUCTOR_ANNOTATION_START;
        return true;
    }
    if (valid_symbols[SPECIFIER_ANNOTATION_START] && following.words >= 2 &&
        (t == '(' || t == ';' || t == '=' || t == ',' || t == '[' || t == '{' || t == ':' || t == ')')) {
        lexer->result_symbol = SPECIFIER_ANNOTATION_START;
        return true;
    }
    bool named = following.words >= 1 &&
                 !is_one_of(following.first_word, CONTINUATION_KEYWORDS, COUNT(CONTINUATION_KEYWORDS)) &&
                 (t == '(' || t == ';' || t == '=' || t == ',' || t == '[' || t == '{' || t == ':' || t == ')');
    if (valid_symbols[LEADING_ANNOTATION_START] && named) {
        lexer->result_symbol = LEADING_ANNOTATION_START;
        return true;
    }
    if (valid_symbols[POST_TYPE_ANNOTATION_START] && named && !has_arguments) {
        lexer->result_symbol = POST_TYPE_ANNOTATION_START;
        return true;
    }
    if (valid_symbols[TRAILING_ANNOTATION_START]) {
        bool ends = following.words == 0 && (following.first == ';' || following.first == ',' ||
                                             following.first == '=' || following.first == '{' ||
                                             following.first == ')' || following.first == ':' ||
                                             following.first == '[' || following.first == '-');
        if (ends || is_macro_name(following.first_word) ||
            is_one_of(following.first_word, CONTINUATION_KEYWORDS, COUNT(CONTINUATION_KEYWORDS))) {
            lexer->result_symbol = TRAILING_ANNOTATION_START;
            return true;
        }
    }
    return false;
}

void *tree_sitter_mozcpp_external_scanner_create() {
    Scanner *scanner = (Scanner *)ts_calloc(1, sizeof(Scanner));
    memset(scanner, 0, sizeof(Scanner));
    return scanner;
}

bool tree_sitter_mozcpp_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Scanner *scanner = (Scanner *)payload;

    if (valid_symbols[RAW_STRING_DELIMITER] && valid_symbols[RAW_STRING_CONTENT]) {
        // we're in error recovery
        return false;
    }

    // No skipping leading whitespace: raw-string grammar is space-sensitive.
    if (valid_symbols[RAW_STRING_DELIMITER]) {
        lexer->result_symbol = RAW_STRING_DELIMITER;
        return scan_raw_string_delimiter(scanner, lexer);
    }

    if (valid_symbols[RAW_STRING_CONTENT]) {
        lexer->result_symbol = RAW_STRING_CONTENT;
        return scan_raw_string_content(scanner, lexer);
    }

    if (valid_symbols[MACRO_LINE_START] || valid_symbols[MACRO_STATEMENT_START] || valid_symbols[TYPE_MACRO_START] ||
        valid_symbols[SPECIFIER_ANNOTATION_START] || valid_symbols[LEADING_ANNOTATION_START] ||
        valid_symbols[TRAILING_ANNOTATION_START] || valid_symbols[CONSTRUCTOR_ANNOTATION_START] ||
        valid_symbols[POST_TYPE_ANNOTATION_START]) {
        return scan_macro_start(lexer, valid_symbols);
    }

    return false;
}

unsigned tree_sitter_mozcpp_external_scanner_serialize(void *payload, char *buffer) {
    static_assert(MAX_DELIMITER_LENGTH * sizeof(wchar_t) < TREE_SITTER_SERIALIZATION_BUFFER_SIZE,
                  "Serialized delimiter is too long!");

    Scanner *scanner = (Scanner *)payload;
    size_t size = scanner->delimiter_length * sizeof(wchar_t);
    memcpy(buffer, scanner->delimiter, size);
    return (unsigned)size;
}

void tree_sitter_mozcpp_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    assert(length % sizeof(wchar_t) == 0 && "Can't decode serialized delimiter!");

    Scanner *scanner = (Scanner *)payload;
    scanner->delimiter_length = length / sizeof(wchar_t);
    if (length > 0) {
        memcpy(&scanner->delimiter[0], buffer, length);
    }
}

void tree_sitter_mozcpp_external_scanner_destroy(void *payload) {
    Scanner *scanner = (Scanner *)payload;
    ts_free(scanner);
}
