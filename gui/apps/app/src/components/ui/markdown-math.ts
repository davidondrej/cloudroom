// Our own remark-math: `$$…$$` math in text and as a fenced block becomes
// `inlineMath` and `math` nodes that render as
// `<code class="language-math math-inline">` and
// `<pre><code class="language-math math-display">`, which markdown-katex.ts
// turns into KaTeX. A port of micromark-extension-math 3.1.0 and
// mdast-util-math 3.0.0 (MIT, Titus Wormer): the same micromark constructs and
// mdast handlers, without their HTML compiler and markdown serializer, which
// react-markdown never calls.

// The slice of micromark's and mdast-util-from-markdown's API used here.
type Code = number | null;
type State = (code: Code) => State | undefined;
type Token = { type: string; end: unknown };
type Event = ["enter" | "exit", Token, TokenizeContext];
interface TokenizeContext {
  events: Event[];
  interrupt?: boolean;
  parser: {
    constructs: { disable: { null: string[] } };
    lazy: Record<number, boolean>;
  };
  now(): { line: number };
  sliceSerialize(token: Token, expandTabs?: boolean): string;
}
interface Effects {
  attempt(construct: Construct, ok: State, nok: State): State;
  consume(code: Code): undefined;
  enter(type: string, fields?: { contentType: "string" }): Token;
  exit(type: string): Token;
}
type Tokenizer = (
  this: TokenizeContext,
  effects: Effects,
  ok: State,
  nok: State,
) => State;
interface Construct {
  name?: string;
  tokenize: Tokenizer;
  concrete?: boolean;
  partial?: boolean;
  previous?: (this: TokenizeContext, code: Code) => boolean;
  resolve?: (events: Event[]) => Event[];
}
interface CompileContext {
  stack: unknown[];
  data: { mathFlowInside?: boolean };
  config: { enter: { data: Handle }; exit: { data: Handle } };
  buffer(): undefined;
  resume(): string;
  enter(node: object, token: Token): undefined;
  exit(token: Token): undefined;
}
type Handle = (this: CompileContext, token: Token) => undefined;
type Text = { type: "text"; value: string };
type MathNode = {
  meta: string | null;
  value: string;
  data: { hChildren: [{ children: Text[] }] };
};
type InlineMathNode = { value: string; data: { hChildren: Text[] } };
interface Processor {
  data(): {
    micromarkExtensions?: unknown[];
    fromMarkdownExtensions?: unknown[];
  };
}
export interface Options {
  /** Whether `$a$` is math too, not only `$$a$$` (default: `true`). */
  singleDollarTextMath?: boolean | null;
}

// micromark's character codes: CR, LF and CRLF are -5 to -3, a tab is -2,
// and the columns a tab expands into are -1.
const DOLLAR = 36;
const SPACE = 32;
const isLineEnding = (code: Code): boolean => code !== null && code < -2;
const isSpace = (code: Code): boolean =>
  code === -2 || code === -1 || code === SPACE;

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

// EOF, or an EOL before a line that belongs to the math, not a lazy one.
const nonLazyContinuation: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    const self = this;
    return start;

    function start(code: Code): State | undefined {
      if (code === null) return ok(code);
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

// Math (flow): a fence of 2+ `$` with optional meta, content lines, and a
// closing fence at least as long.
const mathFlow: Construct = {
  name: "mathFlow",
  concrete: true,
  tokenize(effects, ok, nok) {
    const self = this;
    const tail = self.events[self.events.length - 1];
    const initialSize =
      tail && tail[1].type === "linePrefix"
        ? tail[2].sliceSerialize(tail[1], true).length
        : 0;
    let sizeOpen = 0;
    return start;

    function start(code: Code): State | undefined {
      effects.enter("mathFlow");
      effects.enter("mathFlowFence");
      effects.enter("mathFlowFenceSequence");
      return sequenceOpen(code);
    }

    function sequenceOpen(code: Code): State | undefined {
      if (code === DOLLAR) {
        effects.consume(code);
        sizeOpen++;
        return sequenceOpen;
      }
      if (sizeOpen < 2) return nok(code);
      effects.exit("mathFlowFenceSequence");
      return factorySpace(effects, metaBefore, "whitespace")(code);
    }

    function metaBefore(code: Code): State | undefined {
      if (code === null || isLineEnding(code)) return metaAfter(code);
      effects.enter("mathFlowFenceMeta");
      effects.enter("chunkString", { contentType: "string" });
      return meta(code);
    }

    function meta(code: Code): State | undefined {
      if (code === null || isLineEnding(code)) {
        effects.exit("chunkString");
        effects.exit("mathFlowFenceMeta");
        return metaAfter(code);
      }
      if (code === DOLLAR) return nok(code);
      effects.consume(code);
      return meta;
    }

    function metaAfter(code: Code): State | undefined {
      // Always at an EOL or EOF.
      effects.exit("mathFlowFence");
      if (self.interrupt) return ok(code);
      return effects.attempt(
        nonLazyContinuation,
        beforeNonLazyContinuation,
        after,
      )(code);
    }

    function beforeNonLazyContinuation(code: Code): State | undefined {
      const closingFence = { tokenize: tokenizeClosingFence, partial: true };
      return effects.attempt(closingFence, after, contentStart)(code);
    }

    function contentStart(code: Code): State | undefined {
      if (!initialSize) return beforeContentChunk(code);
      const max = initialSize + 1;
      return factorySpace(effects, beforeContentChunk, "linePrefix", max)(code);
    }

    function beforeContentChunk(code: Code): State | undefined {
      if (code === null) return after(code);
      if (isLineEnding(code)) {
        return effects.attempt(
          nonLazyContinuation,
          beforeNonLazyContinuation,
          after,
        )(code);
      }
      effects.enter("mathFlowValue");
      return contentChunk(code);
    }

    function contentChunk(code: Code): State | undefined {
      if (code === null || isLineEnding(code)) {
        effects.exit("mathFlowValue");
        return beforeContentChunk(code);
      }
      effects.consume(code);
      return contentChunk;
    }

    function after(code: Code): State | undefined {
      effects.exit("mathFlow");
      return ok(code);
    }

    // Up to 3 spaces before a closing fence, or any with indented code off.
    function tokenizeClosingFence(effects: Effects, ok: State, nok: State) {
      let size = 0;
      const { disable } = self.parser.constructs;
      const max = disable.null.includes("codeIndented") ? undefined : 4;
      return factorySpace(effects, beforeSequenceClose, "linePrefix", max);

      function beforeSequenceClose(code: Code): State | undefined {
        effects.enter("mathFlowFence");
        effects.enter("mathFlowFenceSequence");
        return sequenceClose(code);
      }

      function sequenceClose(code: Code): State | undefined {
        if (code === DOLLAR) {
          size++;
          effects.consume(code);
          return sequenceClose;
        }
        if (size < sizeOpen) return nok(code);
        effects.exit("mathFlowFenceSequence");
        return factorySpace(effects, afterSequenceClose, "whitespace")(code);
      }

      function afterSequenceClose(code: Code): State | undefined {
        if (code === null || isLineEnding(code)) {
          effects.exit("mathFlowFence");
          return ok(code);
        }
        return nok(code);
      }
    }
  },
};

// Math (text): `$$a$$`, closed by a sequence of the same size. `single`
// allows `$a$`.
function mathText(single: boolean): Construct {
  return { name: "mathText", tokenize, resolve: resolveMathText, previous };

  function tokenize(effects: Effects, ok: State, nok: State): State {
    let sizeOpen = 0;
    let size = 0;
    let token: Token | undefined;
    return start;

    function start(code: Code): State | undefined {
      effects.enter("mathText");
      effects.enter("mathTextSequence");
      return sequenceOpen(code);
    }

    function sequenceOpen(code: Code): State | undefined {
      if (code === DOLLAR) {
        effects.consume(code);
        sizeOpen++;
        return sequenceOpen;
      }
      if (sizeOpen < 2 && !single) return nok(code);
      effects.exit("mathTextSequence");
      return between(code);
    }

    function between(code: Code): State | undefined {
      if (code === null) return nok(code);
      if (code === DOLLAR) {
        token = effects.enter("mathTextSequence");
        size = 0;
        return sequenceClose(code);
      }
      // Tabs, and the virtual spaces after them, are data, not padding.
      if (code === SPACE) {
        effects.enter("space");
        effects.consume(code);
        effects.exit("space");
        return between;
      }
      if (isLineEnding(code)) {
        effects.enter("lineEnding");
        effects.consume(code);
        effects.exit("lineEnding");
        return between;
      }
      effects.enter("mathTextData");
      return data(code);
    }

    function data(code: Code): State | undefined {
      if (
        code === null ||
        code === SPACE ||
        code === DOLLAR ||
        isLineEnding(code)
      ) {
        effects.exit("mathTextData");
        return between(code);
      }
      effects.consume(code);
      return data;
    }

    function sequenceClose(code: Code): State | undefined {
      if (code === DOLLAR) {
        effects.consume(code);
        size++;
        return sequenceClose;
      }
      if (size === sizeOpen) {
        effects.exit("mathTextSequence");
        effects.exit("mathText");
        return ok(code);
      }
      // A sequence of another size is data.
      token!.type = "mathTextData";
      return data(code);
    }
  }
}

// One space or EOL on both sides, around data, is padding. Then each run of
// spaces and data between EOLs becomes one data token.
function resolveMathText(events: Event[]): Event[] {
  let tailExitIndex = events.length - 4;
  let headEnterIndex = 3;
  let index: number;
  let enter: number | undefined;
  const isPadding = (event: Event): boolean =>
    event[1].type === "lineEnding" || event[1].type === "space";

  if (isPadding(events[headEnterIndex]!) && isPadding(events[tailExitIndex]!)) {
    index = headEnterIndex;
    while (++index < tailExitIndex) {
      if (events[index]![1].type === "mathTextData") {
        events[tailExitIndex]![1].type = "mathTextPadding";
        events[headEnterIndex]![1].type = "mathTextPadding";
        headEnterIndex += 2;
        tailExitIndex -= 2;
        break;
      }
    }
  }

  index = headEnterIndex - 1;
  tailExitIndex++;
  while (++index <= tailExitIndex) {
    if (enter === undefined) {
      if (index !== tailExitIndex && events[index]![1].type !== "lineEnding") {
        enter = index;
      }
    } else if (
      index === tailExitIndex ||
      events[index]![1].type === "lineEnding"
    ) {
      events[enter]![1].type = "mathTextData";
      if (index !== enter + 2) {
        events[enter]![1].end = events[index - 1]![1].end;
        events.splice(enter + 2, index - enter - 2);
        tailExitIndex -= index - enter - 2;
        index = enter + 2;
      }
      enter = undefined;
    }
  }
  return events;
}

// An escaped `$` can open math; an unescaped one right before can't.
function previous(this: TokenizeContext, code: Code): boolean {
  return (
    code !== DOLLAR ||
    this.events[this.events.length - 1]![1].type === "characterEscape"
  );
}

function exitMathData(this: CompileContext, token: Token): undefined {
  this.config.enter.data.call(this, token);
  this.config.exit.data.call(this, token);
}

const mathFromMarkdown: Record<"enter" | "exit", Record<string, Handle>> = {
  enter: {
    mathFlow(token) {
      this.enter(
        {
          type: "math",
          meta: null,
          value: "",
          data: {
            hName: "pre",
            hChildren: [
              {
                type: "element",
                tagName: "code",
                properties: { className: ["language-math", "math-display"] },
                children: [],
              },
            ],
          },
        },
        token,
      );
    },
    mathFlowFenceMeta() {
      this.buffer();
    },
    mathText(token) {
      this.enter(
        {
          type: "inlineMath",
          value: "",
          data: {
            hName: "code",
            hProperties: { className: ["language-math", "math-inline"] },
            hChildren: [],
          },
        },
        token,
      );
      this.buffer();
    },
  },
  exit: {
    mathFlow(token) {
      const value = this.resume().replace(/^(\r?\n|\r)|(\r?\n|\r)$/g, "");
      const node = this.stack.at(-1) as MathNode;
      this.exit(token);
      node.value = value;
      node.data.hChildren[0].children.push({ type: "text", value });
      this.data.mathFlowInside = undefined;
    },
    // The opening fence starts buffering the content; the closing one doesn't.
    mathFlowFence() {
      if (this.data.mathFlowInside) return;
      this.buffer();
      this.data.mathFlowInside = true;
    },
    mathFlowFenceMeta() {
      const meta = this.resume();
      (this.stack.at(-1) as MathNode).meta = meta;
    },
    mathFlowValue: exitMathData,
    mathText(token) {
      const value = this.resume();
      const node = this.stack.at(-1) as InlineMathNode;
      this.exit(token);
      node.value = value;
      node.data.hChildren.push({ type: "text", value });
    },
    mathTextData: exitMathData,
  },
};

export default function remarkMath(
  this: unknown,
  options?: Readonly<Options> | null,
): undefined {
  // unified's processor, whose types don't declare these two lists.
  const data = (this as Processor).data();
  (data.micromarkExtensions ??= []).push({
    flow: { [DOLLAR]: mathFlow },
    text: { [DOLLAR]: mathText(options?.singleDollarTextMath ?? true) },
  });
  (data.fromMarkdownExtensions ??= []).push(mathFromMarkdown);
}
