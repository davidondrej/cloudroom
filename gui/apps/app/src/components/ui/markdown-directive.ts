// Our own remark-directive: `:name[label]{attributes}` in text, `::name…` on
// its own line, and `:::name…` fenced blocks become `textDirective`,
// `leafDirective`, and `containerDirective` nodes, which
// markdown-message-directives.tsx and markdown-thread-mentions.tsx read. A
// port of micromark-extension-directive 4.0.0 and mdast-util-directive 3.1.0,
// with the attribute decoding of parse-entities 4.0.2 (all MIT, Titus Wormer):
// the same micromark constructs and mdast nodes, without their HTML compiler
// and markdown serializer, which react-markdown never calls.

// The slice of micromark's and mdast-util-from-markdown's API used here.
type Code = number | null;
type State = (code: Code) => State | undefined;
interface Token {
  type: string;
  start: { line: number; directiveContainerDepth?: number };
  next?: Token;
}
type Event = ["enter" | "exit", Token, TokenizeContext];
interface TokenizeContext {
  events: Event[];
  interrupt?: boolean;
  previous: Code;
  directiveContainerDepth?: number;
  parser: {
    constructs: { disable: { null: string[] } };
    lazy: Record<number, boolean>;
    directiveContainerDepth?: number;
    document(from: Token["start"]): TokenizeContext;
    flow(from: Token["start"]): TokenizeContext;
  };
  now(): { line: number };
  sliceSerialize(token: Token, expandTabs?: boolean): string;
}
interface ChunkFields {
  contentType: "document" | "text";
  previous: Token | undefined;
  _contentTypeTextTrailing?: true;
}
interface Effects {
  attempt(construct: Construct, ok: State, nok: State): State;
  check(construct: Construct, ok: State, nok: State): State;
  consume(code: Code): undefined;
  enter(type: string, fields?: ChunkFields): Token;
  exit(type: string): Token;
}
type Tokenizer = (
  this: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State,
) => State;
interface Construct {
  tokenize: Tokenizer;
  concrete?: boolean;
  partial?: boolean;
  previous?: (this: TokenizeContext, code: Code) => boolean;
}
interface DirectiveNode {
  type: string;
  name: string;
  attributes: Record<string, string>;
  children: unknown[];
}
interface CompileContext {
  stack: DirectiveNode[];
  data: { directiveAttributes?: [string, string][] };
  buffer(): undefined;
  resume(): string;
  enter(node: object, token: Token): undefined;
  exit(token: Token): undefined;
  sliceSerialize(token: Token): string;
}
type Handle = (this: CompileContext, token: Token) => undefined;
interface Processor {
  data(): {
    micromarkExtensions?: unknown[];
    fromMarkdownExtensions?: unknown[];
  };
}

// micromark's character codes: CR, LF and CRLF are -5 to -3, a tab is -2,
// and the columns a tab expands into are -1.
const TAB = 9;
const LF = 10;
const FF = 12;
const SPACE = 32;
const QUOTE = 34;
const NUMBER_SIGN = 35;
const AMPERSAND = 38;
const APOSTROPHE = 39;
const DASH = 45;
const DOT = 46;
const COLON = 58;
const SEMICOLON = 59;
const LESS_THAN = 60;
const EQUALS = 61;
const GREATER_THAN = 62;
const UPPER_X = 88;
const LEFT_BRACKET = 91;
const BACKSLASH = 92;
const RIGHT_BRACKET = 93;
const UNDERSCORE = 95;
const GRAVE = 96;
const LOWER_X = 120;
const LEFT_BRACE = 123;
const RIGHT_BRACE = 125;

// micromark-util-character.
const PUNCTUATION = /\p{P}|\p{S}/u;
const WHITESPACE = /\s/;
const isLineEnding = (code: Code): boolean => code !== null && code < -2;
const isLineEndingOrSpace = (code: Code): boolean =>
  code !== null && (code < 0 || code === SPACE);
const isSpace = (code: Code): boolean =>
  code === -2 || code === -1 || code === SPACE;
const isPunctuation = (code: Code): boolean =>
  code !== null && code > -1 && PUNCTUATION.test(String.fromCharCode(code));
const isWhitespace = (code: Code): boolean =>
  code !== null && code > -1 && WHITESPACE.test(String.fromCharCode(code));

// micromark-factory-space: optional spaces and tabs, as one `type` token of
// at most `max - 1` characters.
function factorySpace(
  effects: Effects,
  ok: State,
  type: string,
  max?: number,
): State {
  const limit = max ? max - 1 : Number.POSITIVE_INFINITY;
  let size = 0;
  return start;

  function start(code: Code): State | undefined {
    if (isSpace(code)) {
      effects.enter(type);
      return prefix(code);
    }
    return ok(code);
  }

  function prefix(code: Code): State | undefined {
    if (isSpace(code) && size++ < limit) {
      effects.consume(code);
      return prefix;
    }
    effects.exit(type);
    return ok(code);
  }
}

// micromark-factory-whitespace: spaces, tabs, and line endings.
function factoryWhitespace(effects: Effects, ok: State): State {
  let seen = false;
  return start;

  function start(code: Code): State | undefined {
    if (isLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      seen = true;
      return start;
    }
    if (isSpace(code)) {
      return factorySpace(
        effects,
        start,
        seen ? "linePrefix" : "lineSuffix",
      )(code);
    }
    return ok(code);
  }
}

// A name: no whitespace or punctuation other than `-` and `_`, which can't
// end it.
function factoryName(
  self: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State,
  type: string,
): State {
  return start;

  function start(code: Code): State | undefined {
    if (
      code === null ||
      isLineEnding(code) ||
      isPunctuation(code) ||
      isWhitespace(code)
    ) {
      return nok(code);
    }
    effects.enter(type);
    effects.consume(code);
    return name;
  }

  function name(code: Code): State | undefined {
    if (
      code === null ||
      isLineEnding(code) ||
      isWhitespace(code) ||
      (isPunctuation(code) && code !== DASH && code !== UNDERSCORE)
    ) {
      effects.exit(type);
      return self.previous === DASH || self.previous === UNDERSCORE
        ? nok(code)
        : ok(code);
    }
    effects.consume(code);
    return name;
  }
}

// `[…]` with phrasing content: may be empty, holds balanced brackets (up to
// 32 deep, for nested directives), and, with `disallowEol`, no line endings.
function factoryLabel(
  effects: Effects,
  ok: State,
  nok: State,
  prefix: string,
  disallowEol?: boolean,
): State {
  const type = `${prefix}Label`;
  const markerType = `${type}Marker`;
  const stringType = `${type}String`;
  // Counts only escaped brackets and backslashes, like upstream.
  let size = 0;
  let balance = 0;
  let previous: Token | undefined;
  return start;

  function start(code: Code): State | undefined {
    effects.enter(type);
    effects.enter(markerType);
    effects.consume(code);
    effects.exit(markerType);
    return afterStart;
  }

  function afterStart(code: Code): State | undefined {
    if (code === RIGHT_BRACKET) {
      effects.enter(markerType);
      effects.consume(code);
      effects.exit(markerType);
      effects.exit(type);
      return ok;
    }
    effects.enter(stringType);
    return lineStart(code);
  }

  function lineStart(code: Code): State | undefined {
    if (code === RIGHT_BRACKET && !balance) return atClosingBrace(code);
    const token = effects.enter("chunkText", {
      _contentTypeTextTrailing: true,
      contentType: "text",
      previous,
    });
    if (previous) previous.next = token;
    previous = token;
    return data(code);
  }

  function data(code: Code): State | undefined {
    if (code === null || size > 999) return nok(code);
    if (code === LEFT_BRACKET && ++balance > 32) return nok(code);
    if (code === RIGHT_BRACKET && !balance--) {
      effects.exit("chunkText");
      return atClosingBrace(code);
    }
    if (isLineEnding(code)) {
      if (disallowEol) return nok(code);
      effects.consume(code);
      effects.exit("chunkText");
      return lineStart;
    }
    effects.consume(code);
    return code === BACKSLASH ? dataEscape : data;
  }

  function dataEscape(code: Code): State | undefined {
    if (code === LEFT_BRACKET || code === BACKSLASH || code === RIGHT_BRACKET) {
      effects.consume(code);
      size++;
      return data;
    }
    return data(code);
  }

  function atClosingBrace(code: Code): State | undefined {
    effects.exit(stringType);
    effects.enter(markerType);
    effects.consume(code);
    effects.exit(markerType);
    effects.exit(type);
    return ok;
  }
}

// `{#id .class key=value key="value" key='value' key}`.
function factoryAttributes(
  effects: Effects,
  ok: State,
  nok: State,
  prefix: string,
  disallowEol?: boolean,
): State {
  const attributesType = `${prefix}Attributes`;
  const attributesMarkerType = `${attributesType}Marker`;
  const attributeType = `${prefix}Attribute`;
  const nameType = `${attributeType}Name`;
  const valueLiteralType = `${attributeType}ValueLiteral`;
  const valueType = `${attributeType}Value`;
  const valueMarkerType = `${attributeType}ValueMarker`;
  const valueDataType = `${attributeType}ValueData`;
  // `…AttributeId` or `…AttributeClass` while in a `#` or `.` shortcut.
  let shortcutType = "";
  let marker: Code | undefined;
  return start;

  function start(code: Code): State | undefined {
    effects.enter(attributesType);
    effects.enter(attributesMarkerType);
    effects.consume(code);
    effects.exit(attributesMarkerType);
    return between;
  }

  function between(code: Code): State | undefined {
    if (code === NUMBER_SIGN) {
      shortcutType = `${attributeType}Id`;
      return shortcutStart(code);
    }
    if (code === DOT) {
      shortcutType = `${attributeType}Class`;
      return shortcutStart(code);
    }
    if (disallowEol && isSpace(code)) {
      return factorySpace(effects, between, "whitespace")(code);
    }
    if (!disallowEol && isLineEndingOrSpace(code)) {
      return factoryWhitespace(effects, between)(code);
    }
    if (
      code === null ||
      isLineEnding(code) ||
      isWhitespace(code) ||
      (isPunctuation(code) && code !== DASH && code !== UNDERSCORE)
    ) {
      return end(code);
    }
    effects.enter(attributeType);
    effects.enter(nameType);
    effects.consume(code);
    return name;
  }

  function shortcutStart(code: Code): State | undefined {
    effects.enter(attributeType);
    effects.enter(shortcutType);
    effects.enter(`${shortcutType}Marker`);
    effects.consume(code);
    effects.exit(`${shortcutType}Marker`);
    return shortcutStartAfter;
  }

  function shortcutStartAfter(code: Code): State | undefined {
    if (
      code === null ||
      code === QUOTE ||
      code === NUMBER_SIGN ||
      code === APOSTROPHE ||
      code === DOT ||
      code === LESS_THAN ||
      code === EQUALS ||
      code === GREATER_THAN ||
      code === GRAVE ||
      code === RIGHT_BRACE ||
      isLineEndingOrSpace(code)
    ) {
      return nok(code);
    }
    effects.enter(`${shortcutType}Value`);
    effects.consume(code);
    return shortcut;
  }

  function shortcut(code: Code): State | undefined {
    if (
      code === null ||
      code === QUOTE ||
      code === APOSTROPHE ||
      code === LESS_THAN ||
      code === EQUALS ||
      code === GREATER_THAN ||
      code === GRAVE
    ) {
      return nok(code);
    }
    if (
      code === NUMBER_SIGN ||
      code === DOT ||
      code === RIGHT_BRACE ||
      isLineEndingOrSpace(code)
    ) {
      effects.exit(`${shortcutType}Value`);
      effects.exit(shortcutType);
      effects.exit(attributeType);
      return between(code);
    }
    effects.consume(code);
    return shortcut;
  }

  function name(code: Code): State | undefined {
    if (
      code === null ||
      isLineEnding(code) ||
      isWhitespace(code) ||
      (isPunctuation(code) &&
        code !== DASH &&
        code !== DOT &&
        code !== COLON &&
        code !== UNDERSCORE)
    ) {
      effects.exit(nameType);
      if (disallowEol && isSpace(code)) {
        return factorySpace(effects, nameAfter, "whitespace")(code);
      }
      if (!disallowEol && isLineEndingOrSpace(code)) {
        return factoryWhitespace(effects, nameAfter)(code);
      }
      return nameAfter(code);
    }
    effects.consume(code);
    return name;
  }

  function nameAfter(code: Code): State | undefined {
    if (code === EQUALS) {
      effects.enter(`${attributeType}InitializerMarker`);
      effects.consume(code);
      effects.exit(`${attributeType}InitializerMarker`);
      return valueBefore;
    }
    // An attribute without a value.
    effects.exit(attributeType);
    return between(code);
  }

  function valueBefore(code: Code): State | undefined {
    if (
      code === null ||
      code === LESS_THAN ||
      code === EQUALS ||
      code === GREATER_THAN ||
      code === GRAVE ||
      code === RIGHT_BRACE ||
      (disallowEol && isLineEnding(code))
    ) {
      return nok(code);
    }
    if (code === QUOTE || code === APOSTROPHE) {
      effects.enter(valueLiteralType);
      effects.enter(valueMarkerType);
      effects.consume(code);
      effects.exit(valueMarkerType);
      marker = code;
      return valueQuotedStart;
    }
    if (disallowEol && isSpace(code)) {
      return factorySpace(effects, valueBefore, "whitespace")(code);
    }
    if (!disallowEol && isLineEndingOrSpace(code)) {
      return factoryWhitespace(effects, valueBefore)(code);
    }
    effects.enter(valueType);
    effects.enter(valueDataType);
    effects.consume(code);
    marker = undefined;
    return valueUnquoted;
  }

  function valueUnquoted(code: Code): State | undefined {
    if (
      code === null ||
      code === QUOTE ||
      code === APOSTROPHE ||
      code === LESS_THAN ||
      code === EQUALS ||
      code === GREATER_THAN ||
      code === GRAVE
    ) {
      return nok(code);
    }
    if (code === RIGHT_BRACE || isLineEndingOrSpace(code)) {
      effects.exit(valueDataType);
      effects.exit(valueType);
      effects.exit(attributeType);
      return between(code);
    }
    effects.consume(code);
    return valueUnquoted;
  }

  function valueQuotedStart(code: Code): State | undefined {
    if (code === marker) {
      effects.enter(valueMarkerType);
      effects.consume(code);
      effects.exit(valueMarkerType);
      effects.exit(valueLiteralType);
      effects.exit(attributeType);
      return valueQuotedAfter;
    }
    effects.enter(valueType);
    return valueQuotedBetween(code);
  }

  function valueQuotedBetween(code: Code): State | undefined {
    if (code === marker) {
      effects.exit(valueType);
      return valueQuotedStart(code);
    }
    if (code === null) return nok(code);
    // Blank lines can't exist in content.
    if (isLineEnding(code)) {
      return disallowEol
        ? nok(code)
        : factoryWhitespace(effects, valueQuotedBetween)(code);
    }
    effects.enter(valueDataType);
    effects.consume(code);
    return valueQuoted;
  }

  function valueQuoted(code: Code): State | undefined {
    if (code === marker || code === null || isLineEnding(code)) {
      effects.exit(valueDataType);
      return valueQuotedBetween(code);
    }
    effects.consume(code);
    return valueQuoted;
  }

  function valueQuotedAfter(code: Code): State | undefined {
    return code === RIGHT_BRACE || isLineEndingOrSpace(code)
      ? between(code)
      : end(code);
  }

  function end(code: Code): State | undefined {
    if (code === RIGHT_BRACE) {
      effects.enter(attributesMarkerType);
      effects.consume(code);
      effects.exit(attributesMarkerType);
      effects.exit(attributesType);
      return ok;
    }
    return nok(code);
  }
}

// An optional `[label]`, then optional `{attributes}`, after a name.
function labelAndAttributes(
  effects: Effects,
  prefix: string,
  disallowEol: boolean,
  next: State,
): State {
  const label: Construct = {
    partial: true,
    tokenize: (effects, ok, nok) =>
      factoryLabel(effects, ok, nok, prefix, disallowEol),
  };
  const attributes: Construct = {
    partial: true,
    tokenize: (effects, ok, nok) =>
      factoryAttributes(effects, ok, nok, prefix, disallowEol),
  };
  const afterLabel = (code: Code): State | undefined =>
    code === LEFT_BRACE
      ? effects.attempt(attributes, next, next)(code)
      : next(code);
  return (code) =>
    code === LEFT_BRACKET
      ? effects.attempt(label, afterLabel, afterLabel)(code)
      : afterLabel(code);
}

// `:name[label]{attributes}` in text. An unescaped `:` right before can't
// open one.
const directiveText: Construct = {
  previous(code) {
    // If there is a previous code, there is always a tail.
    return (
      code !== COLON ||
      this.events[this.events.length - 1]![1].type === "characterEscape"
    );
  },
  tokenize(effects, ok, nok) {
    const afterName = (code: Code): State | undefined =>
      code === COLON
        ? nok(code)
        : labelAndAttributes(effects, "directiveText", false, after)(code);
    return (code) => {
      effects.enter("directiveText");
      effects.enter("directiveTextMarker");
      effects.consume(code);
      effects.exit("directiveTextMarker");
      return factoryName(this, effects, afterName, nok, "directiveTextName");
    };

    function after(code: Code): State | undefined {
      effects.exit("directiveText");
      return ok(code);
    }
  },
};

// `::name[label]{attributes}`, alone on its line.
const directiveLeaf: Construct = {
  tokenize(effects, ok, nok) {
    const self = this;
    return start;

    function start(code: Code): State | undefined {
      effects.enter("directiveLeaf");
      effects.enter("directiveLeafSequence");
      effects.consume(code);
      return inStart;
    }

    function inStart(code: Code): State | undefined {
      if (code !== COLON) return nok(code);
      effects.consume(code);
      effects.exit("directiveLeafSequence");
      const afterAttributes = (code: Code): State | undefined =>
        factorySpace(effects, end, "whitespace")(code);
      const afterName = labelAndAttributes(
        effects,
        "directiveLeaf",
        true,
        afterAttributes,
      );
      return factoryName(self, effects, afterName, nok, "directiveLeafName");
    }

    function end(code: Code): State | undefined {
      if (code === null || isLineEnding(code)) {
        effects.exit("directiveLeaf");
        return ok(code);
      }
      return nok(code);
    }
  },
};

// A line ending, then a line that isn't lazy (a paragraph continuation
// outside the container's prefixes).
const nonLazyLine: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    const self = this;
    return start;

    function start(code: Code): State | undefined {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return lineStart;
    }

    function lineStart(code: Code): State | undefined {
      return self.parser.lazy[self.now().line] ? nok(code) : ok(code);
    }
  },
};

// Nested container content is parsed again at each level by micromark. Cap
// that nesting so a short message can't cause quadratic work.
const MAX_CONTAINER_DEPTH = 32;
const containerDepthParsers = new WeakSet<TokenizeContext["parser"]>();

// `:::name[label]{attributes}`, then document content, until a fence of at
// least as many colons or the end of its container.
const directiveContainer: Construct = {
  concrete: true,
  tokenize(effects, ok, nok) {
    const self = this;
    const depth = self.directiveContainerDepth ?? 0;
    if (depth >= MAX_CONTAINER_DEPTH) return nok;
    if (!containerDepthParsers.has(self.parser)) {
      const parser = self.parser;
      const createDocument = parser.document;
      const createFlow = parser.flow;
      parser.document = (from) => {
        parser.directiveContainerDepth = from.directiveContainerDepth;
        const context = createDocument(from);
        context.directiveContainerDepth = from.directiveContainerDepth;
        return context;
      };
      parser.flow = (from) => {
        const context = createFlow(from);
        context.directiveContainerDepth = parser.directiveContainerDepth;
        return context;
      };
      containerDepthParsers.add(parser);
    }
    const tail = self.events[self.events.length - 1];
    const initialSize =
      tail && tail[1].type === "linePrefix"
        ? tail[2].sliceSerialize(tail[1], true).length
        : 0;
    let sizeOpen = 0;
    let previous: Token | undefined;
    const afterName = labelAndAttributes(
      effects,
      "directiveContainer",
      true,
      afterAttributes,
    );
    return start;

    function start(code: Code): State | undefined {
      effects.enter("directiveContainer");
      effects.enter("directiveContainerFence");
      effects.enter("directiveContainerSequence");
      return sequenceOpen(code);
    }

    function sequenceOpen(code: Code): State | undefined {
      if (code === COLON) {
        effects.consume(code);
        sizeOpen++;
        return sequenceOpen;
      }
      if (sizeOpen < 3) return nok(code);
      effects.exit("directiveContainerSequence");
      return factoryName(
        self,
        effects,
        afterName,
        nok,
        "directiveContainerName",
      )(code);
    }

    function afterAttributes(code: Code): State | undefined {
      return factorySpace(effects, openAfter, "whitespace")(code);
    }

    function openAfter(code: Code): State | undefined {
      effects.exit("directiveContainerFence");
      if (code === null) return after(code);
      if (isLineEnding(code)) {
        if (self.interrupt) return ok(code);
        return effects.attempt(nonLazyLine, contentStart, after)(code);
      }
      return nok(code);
    }

    function contentStart(code: Code): State | undefined {
      if (code === null) return after(code);
      if (isLineEnding(code)) {
        return effects.check(
          nonLazyLine,
          emptyContentNonLazyLineAfter,
          after,
        )(code);
      }
      effects.enter("directiveContainerContent");
      return lineStart(code);
    }

    function lineStart(code: Code): State | undefined {
      return effects.attempt(
        { tokenize: tokenizeClosingFence, partial: true },
        afterContent,
        initialSize
          ? factorySpace(effects, chunkStart, "linePrefix", initialSize + 1)
          : chunkStart,
      )(code);
    }

    function chunkStart(code: Code): State | undefined {
      if (code === null) return afterContent(code);
      if (isLineEnding(code)) {
        return effects.check(
          nonLazyLine,
          chunkNonLazyStart,
          afterContent,
        )(code);
      }
      return chunkNonLazyStart(code);
    }

    function contentContinue(code: Code): State | undefined {
      if (code === null) {
        const token = effects.exit("chunkDocument");
        self.parser.lazy[token.start.line] = false;
        return afterContent(code);
      }
      if (isLineEnding(code)) {
        return effects.check(nonLazyLine, nonLazyLineAfter, lineAfter)(code);
      }
      effects.consume(code);
      return contentContinue;
    }

    function chunkNonLazyStart(code: Code): State | undefined {
      const token = effects.enter("chunkDocument", {
        contentType: "document",
        previous,
      });
      token.start.directiveContainerDepth = depth + 1;
      if (previous) previous.next = token;
      previous = token;
      return contentContinue(code);
    }

    function emptyContentNonLazyLineAfter(code: Code): State | undefined {
      effects.enter("directiveContainerContent");
      return lineStart(code);
    }

    function nonLazyLineAfter(code: Code): State | undefined {
      effects.consume(code);
      const token = effects.exit("chunkDocument");
      self.parser.lazy[token.start.line] = false;
      return lineStart;
    }

    function lineAfter(code: Code): State | undefined {
      const token = effects.exit("chunkDocument");
      self.parser.lazy[token.start.line] = false;
      return afterContent(code);
    }

    function afterContent(code: Code): State | undefined {
      effects.exit("directiveContainerContent");
      return after(code);
    }

    function after(code: Code): State | undefined {
      effects.exit("directiveContainer");
      return ok(code);
    }

    // Up to 3 spaces before a closing fence, or any with indented code off.
    function tokenizeClosingFence(
      effects: Effects,
      ok: State,
      nok: State,
    ): State {
      let size = 0;
      const { disable } = self.parser.constructs;
      const max = disable.null.includes("codeIndented") ? undefined : 4;
      return factorySpace(effects, closingPrefixAfter, "linePrefix", max);

      function closingPrefixAfter(code: Code): State | undefined {
        effects.enter("directiveContainerFence");
        effects.enter("directiveContainerSequence");
        return closingSequence(code);
      }

      function closingSequence(code: Code): State | undefined {
        if (code === COLON) {
          effects.consume(code);
          size++;
          return closingSequence;
        }
        if (size < sizeOpen) return nok(code);
        effects.exit("directiveContainerSequence");
        return factorySpace(effects, closingSequenceEnd, "whitespace")(code);
      }

      function closingSequenceEnd(code: Code): State | undefined {
        if (code === null || isLineEnding(code)) {
          effects.exit("directiveContainerFence");
          return ok(code);
        }
        return nok(code);
      }
    }
  },
};

// parse-entities' `isDecimal`, `isHexadecimal`, and `isAlphanumerical`.
const isDecimal = (code: number): boolean => code >= 48 && code <= 57;
const isHexadecimal = (code: number): boolean =>
  (code >= 97 && code <= 102) || (code >= 65 && code <= 70) || isDecimal(code);
const isAlphanumerical = (code: number): boolean =>
  (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || isDecimal(code);

// character-entities-legacy: names that also decode without a `;`.
const LEGACY_NAMES = new Set(
  "AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml GT Iacute Icirc Igrave Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG THORN Uacute Ucirc Ugrave Uuml Yacute aacute acirc acute aelig agrave amp aring atilde auml brvbar ccedil cedil cent copy curren deg divide eacute ecirc egrave eth euml frac12 frac14 frac34 gt iacute icirc iexcl igrave iquest iuml laquo lt macr micro middot nbsp not ntilde oacute ocirc ograve ordf ordm oslash otilde ouml para plusmn pound quot raquo reg sect shy sup1 sup2 sup3 szlig thorn times uacute ucirc ugrave uml uuml yacute yen yuml".split(
    " ",
  ),
);

// character-reference-invalid: what HTML decodes these code points to.
const INVALID_REFERENCES: Record<number, string> = {
  0: "�",
  128: "€",
  130: "‚",
  131: "ƒ",
  132: "„",
  133: "…",
  134: "†",
  135: "‡",
  136: "ˆ",
  137: "‰",
  138: "Š",
  139: "‹",
  140: "Œ",
  142: "Ž",
  145: "‘",
  146: "’",
  147: "“",
  148: "”",
  149: "•",
  150: "–",
  151: "—",
  152: "˜",
  153: "™",
  154: "š",
  155: "›",
  156: "œ",
  158: "ž",
  159: "Ÿ",
};

// decode-named-character-reference's browser build: the DOM decodes `&name;`.
// `name` is only ASCII letters and digits, so it can't hold markup. Without a
// DOM (Node tests), named references stay as written.
let decoder: HTMLElement | undefined;
function decodeNamedReference(name: string): string | false {
  if (typeof document === "undefined") return false;
  decoder ??= document.createElement("i");
  const reference = `&${name};`;
  decoder.innerHTML = reference;
  const character = decoder.textContent ?? "";
  // `&notit;` parses as `¬it;`: only a known name consumes its `;`.
  if (
    character.charCodeAt(character.length - 1) === SEMICOLON &&
    name !== "semi"
  )
    return false;
  return character === reference ? false : character;
}

// parse-entities with `{attribute: true}`: `&amp;`, `&#38;`, and `&#x26;`
// decode; a legacy name like `&amp` decodes without its `;` unless `=`, a
// letter, or a digit follows. Anything else stays as written.
function decodeAttribute(value: string): string {
  let result = "";
  let index = -1;
  while (++index < value.length) {
    if (value.charCodeAt(index) !== AMPERSAND) {
      result += value[index];
      continue;
    }
    const following = value.charCodeAt(index + 1);
    if (
      following === TAB ||
      following === LF ||
      following === FF ||
      following === SPACE ||
      following === AMPERSAND ||
      following === LESS_THAN ||
      Number.isNaN(following)
    ) {
      result += "&";
      continue;
    }
    const start = index + 1;
    let begin = start;
    let end = start;
    let type: "named" | "decimal" | "hexadecimal" = "named";
    if (following === NUMBER_SIGN) {
      end = ++begin;
      const x = value.charCodeAt(end);
      if (x === UPPER_X || x === LOWER_X) {
        type = "hexadecimal";
        end = ++begin;
      } else {
        type = "decimal";
      }
    }
    const test =
      type === "named"
        ? isAlphanumerical
        : type === "decimal"
          ? isDecimal
          : isHexadecimal;
    let characterReferenceCharacters = "";
    let characterReference: string | false = "";
    let characters = "";
    while (end < value.length && test(value.charCodeAt(end))) {
      characters += value[end++];
      if (type === "named" && LEGACY_NAMES.has(characters)) {
        characterReferenceCharacters = characters;
        characterReference = decodeNamedReference(characters);
      }
    }
    let terminated = value.charCodeAt(end) === SEMICOLON;
    if (terminated) {
      end++;
      const namedReference =
        type === "named" ? decodeNamedReference(characters) : false;
      if (namedReference) {
        characterReferenceCharacters = characters;
        characterReference = namedReference;
      }
    }
    let reference: string | false = "";
    if (!characters) {
      // `&;`, `&#;`, and `&#x;` stay.
    } else if (type === "named") {
      if (!terminated || characterReference) {
        // An unknown name falls back to its longest legacy prefix, like
        // `&amp` in `&ampx;`.
        if (characterReferenceCharacters !== characters) {
          end = begin + characterReferenceCharacters.length;
          terminated = false;
        }
        if (!terminated) {
          const next = value.charCodeAt(end);
          if (next === EQUALS || isAlphanumerical(next))
            characterReference = "";
        }
      }
      reference = characterReference;
    } else {
      const code = Number.parseInt(
        characters,
        type === "hexadecimal" ? 16 : 10,
      );
      if ((code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
        reference = "�";
      } else if (code in INVALID_REFERENCES) {
        reference = INVALID_REFERENCES[code]!;
      } else {
        reference = String.fromCodePoint(code);
      }
    }
    result += reference || value.slice(start - 1, end);
    index = end - 1;
  }
  return result;
}

function enterDirective(type: string): Handle {
  return function (token) {
    this.enter({ type, name: "", attributes: {}, children: [] }, token);
  };
}

const exitDirective: Handle = function (token) {
  this.exit(token);
};

const exitName: Handle = function (token) {
  this.stack[this.stack.length - 1]!.name = this.sliceSerialize(token);
};

const enterAttributes: Handle = function () {
  this.data.directiveAttributes = [];
  // Capture line endings.
  this.buffer();
};

function exitShortcut(key: "id" | "class"): Handle {
  return function (token) {
    this.data.directiveAttributes!.push([
      key,
      decodeAttribute(this.sliceSerialize(token)),
    ]);
  };
}

const exitAttributeName: Handle = function (token) {
  // Attribute names can't hold character references.
  this.data.directiveAttributes!.push([this.sliceSerialize(token), ""]);
};

const exitAttributeValue: Handle = function (token) {
  const list = this.data.directiveAttributes!;
  list[list.length - 1]![1] = decodeAttribute(this.sliceSerialize(token));
};

const exitAttributes: Handle = function () {
  const list = this.data.directiveAttributes!;
  // A plain object, like upstream: a `__proto__` key is dropped.
  const cleaned: Record<string, string> = {};
  for (const [key, value] of list) {
    if (key === "class" && cleaned.class) cleaned.class += ` ${value}`;
    else cleaned[key] = value;
  }
  this.data.directiveAttributes = undefined;
  // Drop line endings.
  this.resume();
  this.stack[this.stack.length - 1]!.attributes = cleaned;
};

const directiveFromMarkdown: {
  canContainEols: string[];
  enter: Record<string, Handle>;
  exit: Record<string, Handle>;
} = { canContainEols: ["textDirective"], enter: {}, exit: {} };

for (const [prefix, type] of [
  ["directiveContainer", "containerDirective"],
  ["directiveLeaf", "leafDirective"],
  ["directiveText", "textDirective"],
] as const) {
  const { enter, exit } = directiveFromMarkdown;
  enter[prefix] = enterDirective(type);
  enter[`${prefix}Attributes`] = enterAttributes;
  exit[prefix] = exitDirective;
  exit[`${prefix}AttributeClassValue`] = exitShortcut("class");
  exit[`${prefix}AttributeIdValue`] = exitShortcut("id");
  exit[`${prefix}AttributeName`] = exitAttributeName;
  exit[`${prefix}AttributeValue`] = exitAttributeValue;
  exit[`${prefix}Attributes`] = exitAttributes;
  exit[`${prefix}Name`] = exitName;
}

// A container's `[label]` becomes its first child: a paragraph marked as the
// label.
directiveFromMarkdown.enter.directiveContainerLabel = function (token) {
  this.enter(
    { type: "paragraph", data: { directiveLabel: true }, children: [] },
    token,
  );
};
directiveFromMarkdown.exit.directiveContainerLabel = exitDirective;

export default function remarkDirective(this: unknown): undefined {
  // unified's processor, whose types don't declare these two lists.
  const data = (this as Processor).data();
  (data.micromarkExtensions ??= []).push({
    text: { [COLON]: directiveText },
    flow: { [COLON]: [directiveContainer, directiveLeaf] },
  });
  (data.fromMarkdownExtensions ??= []).push(directiveFromMarkdown);
}
