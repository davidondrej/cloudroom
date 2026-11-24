const blockingChildProcessCalls = new Set([
  "execFileSync",
  "execSync",
  "spawnSync",
]);

const noBlockingChildProcessCall = {
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          blockingChildProcessCalls.has(node.callee.name)
        ) {
          context.report({
            node: node.callee,
            message:
              "Use async child_process APIs instead of blocking sync variants.",
          });
        }
      },
    };
  },
};

function findJsxAttribute(node, name) {
  return node.attributes.find(
    (attribute) =>
      attribute.type === "JSXAttribute" &&
      attribute.name.type === "JSXIdentifier" &&
      attribute.name.name === name,
  );
}

const noNativeTitleWithAriaLabel = {
  create(context) {
    return {
      JSXOpeningElement(node) {
        const titleAttribute = findJsxAttribute(node, "title");
        if (titleAttribute && findJsxAttribute(node, "aria-label")) {
          context.report({
            node: titleAttribute,
            message:
              "Do not pair aria-label with a native title tooltip. Use aria-label for the accessible name and a design-system Tooltip, or put title on the truncated text only.",
          });
        }
      },
    };
  },
};

const noNativeTitleOnButton = {
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type === "JSXIdentifier" && node.name.name === "Button") {
          const titleAttribute = findJsxAttribute(node, "title");
          if (titleAttribute) {
            context.report({
              node: titleAttribute,
              message:
                "Do not put native title tooltips on the shared Button primitive. Use aria-label for icon-only buttons and a design-system Tooltip when visible hover help is intentional.",
            });
          }
        }
      },
    };
  },
};

// Test rules for .oxlintrc.tests.json, ported from @interfere/landmines (MIT, see NOTICE).
// Each takes a per-file allowlist with an exact count, so the list can only shrink.
const allowlistSchema = [
  {
    type: "object",
    properties: {
      allow: {
        type: "object",
        additionalProperties: { type: "integer", minimum: 1 },
      },
    },
    additionalProperties: false,
  },
];

// More violations than the file's allowance reports each one; fewer reports the stale entry.
function reportAllowed(context, program, violations, message, staleMessage) {
  const filename = context.physicalFilename.replaceAll("\\", "/");
  const [path, count] = Object.entries(context.options[0]?.allow ?? {}).find(
    ([entry]) => filename === entry || filename.endsWith(`/${entry}`),
  ) ?? ["", 0];
  if (violations.length < count) {
    context.report({
      node: program,
      message: staleMessage(path, violations.length),
    });
  } else if (violations.length > count) {
    for (const node of violations) context.report({ node, message });
  }
}

function isMember(node, object, property) {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === object &&
    node.property.type === "Identifier" &&
    node.property.name === property
  );
}

const testCallees = new Set([
  "test",
  "it",
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
]);
const timerModules = new Set(["node:timers/promises", "timers/promises"]);

function isSetTimeout(node) {
  return (
    (node.type === "Identifier" && node.name === "setTimeout") ||
    isMember(node, "globalThis", "setTimeout") ||
    isMember(node, "window", "setTimeout")
  );
}

// The name a callee chain starts from: `it` for `it.each(rows)("name", fn)`.
function calleeRoot(node) {
  if (node.type === "CallExpression") return calleeRoot(node.callee);
  if (node.type === "MemberExpression") return calleeRoot(node.object);
  if (node.type === "TaggedTemplateExpression") return calleeRoot(node.tag);
  return node.type === "Identifier" ? node.name : undefined;
}

// True when the innermost function around `node` is passed to a test or hook.
function inTestBody(node) {
  let current = node.parent;
  while (
    current &&
    current.type !== "ArrowFunctionExpression" &&
    current.type !== "FunctionExpression" &&
    current.type !== "FunctionDeclaration"
  ) {
    current = current.parent;
  }
  const call = current?.parent;
  return (
    call?.type === "CallExpression" &&
    testCallees.has(calleeRoot(call.callee) ?? "")
  );
}

// The one expression a function body runs: `() => x` or `() => { x; }`.
function onlyExpression(body) {
  if (body?.type !== "BlockStatement") return body;
  const [statement, ...rest] = body.body;
  return statement?.type === "ExpressionStatement" && rest.length === 0
    ? statement.expression
    : null;
}

// `new Promise((resolve) => setTimeout(resolve, ms))`, or with `() => resolve()`.
function resolvesAfterTimeout(node) {
  const [executor] = node.arguments;
  if (
    executor?.type !== "ArrowFunctionExpression" &&
    executor?.type !== "FunctionExpression"
  ) {
    return false;
  }
  const [resolve] = executor.params;
  if (resolve?.type !== "Identifier") return false;
  const call = onlyExpression(executor.body);
  if (call?.type !== "CallExpression" || !isSetTimeout(call.callee)) {
    return false;
  }
  const [handler] = call.arguments;
  if (handler?.type === "Identifier") return handler.name === resolve.name;
  return (
    handler?.type === "ArrowFunctionExpression" &&
    handler.body.type === "CallExpression" &&
    handler.body.callee.type === "Identifier" &&
    handler.body.callee.name === resolve.name
  );
}

const noFixedSleep = {
  meta: { type: "problem", schema: allowlistSchema },
  create(context) {
    const timers = new Set();
    const sleeps = [];
    let fakeTimers = false;
    function isSleep(node) {
      if (node.type === "NewExpression") {
        return (
          node.callee.type === "Identifier" &&
          node.callee.name === "Promise" &&
          resolvesAfterTimeout(node)
        );
      }
      if (node.type !== "CallExpression") return false;
      return (
        (node.callee.type === "Identifier" && timers.has(node.callee.name)) ||
        isMember(node.callee, "scheduler", "wait") ||
        isMember(node.callee, "Bun", "sleep")
      );
    }
    return {
      ImportDeclaration(node) {
        if (!timerModules.has(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === "setTimeout"
          ) {
            timers.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        if (isMember(node.callee, "vi", "useFakeTimers")) fakeTimers = true;
      },
      AwaitExpression(node) {
        if (isSleep(node.argument) && inTestBody(node)) sleeps.push(node);
      },
      "Program:exit"(program) {
        reportAllowed(
          context,
          program,
          fakeTimers ? [] : sleeps,
          "Replace this fixed sleep with a signal: await the operation itself or a promise its handler resolves. To move time, use vi.useFakeTimers() and advance it. A sleep guesses how long real work takes and fails under CPU load.",
          (path, count) =>
            `This file now has ${count} fixed sleeps; lower its bb/no-fixed-sleep allowlist entry for ${path} in .oxlintrc.tests.json to ${count}, or remove the entry at 0.`,
        );
      },
    };
  },
};

const spyMatchers = new Set([
  "toHaveBeenCalled",
  "toHaveBeenCalledOnce",
  "toHaveBeenCalledTimes",
  "toHaveBeenCalledWith",
  "toHaveBeenCalledExactlyOnceWith",
  "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith",
  "toHaveReturned",
  "toHaveReturnedTimes",
  "toHaveReturnedWith",
  "toHaveLastReturnedWith",
  "toHaveNthReturnedWith",
  "toHaveResolved",
  "toHaveResolvedTimes",
  "toHaveResolvedWith",
  "toHaveLastResolvedWith",
  "toHaveNthResolvedWith",
]);

function propertyName(node) {
  return node.property.type === "Identifier" && !node.computed
    ? node.property.name
    : undefined;
}

// The names a plain read goes through: ["fetch", "mock", "calls"]; null for anything else.
function readPath(node) {
  if (node.type === "ChainExpression") return readPath(node.expression);
  if (node.type === "Identifier") return [node.name];
  if (node.type !== "MemberExpression") return null;
  const object = readPath(node.object);
  return object && [...object, propertyName(node) ?? "[]"];
}

// Spy state or a recorder's length or size. A ref's `.current` doesn't count.
function readsRecorder(node) {
  const names = readPath(node);
  if (!names || names.includes("current")) return false;
  const last = names.at(-1);
  return (
    names.includes("mock") ||
    (names.length > 1 && (last === "length" || last === "size"))
  );
}

// What a poll callback checks: its expression body, or its single statement.
function polledValue(callback) {
  if (
    callback.type !== "ArrowFunctionExpression" &&
    callback.type !== "FunctionExpression"
  ) {
    return null;
  }
  if (!callback.body) return null;
  if (callback.body.type !== "BlockStatement") return callback.body;
  const [statement, ...rest] = callback.body.body;
  if (rest.length > 0) return null;
  if (statement?.type === "ReturnStatement") return statement.argument;
  return statement?.type === "ExpressionStatement"
    ? statement.expression
    : null;
}

// `expect(spy).toHaveBeenCalled()` or `expect(list).not.toHaveLength(0)` inside vi.waitFor.
function assertsRecorder(node) {
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression"
  ) {
    return false;
  }
  const matcher = propertyName(node.callee) ?? "";
  const subject =
    node.callee.object.type === "MemberExpression" &&
    propertyName(node.callee.object) === "not"
      ? node.callee.object.object
      : node.callee.object;
  if (
    subject.type !== "CallExpression" ||
    subject.callee.type !== "Identifier" ||
    subject.callee.name !== "expect"
  ) {
    return false;
  }
  const [target] = subject.arguments;
  if (!target || target.type === "SpreadElement") return false;
  if (readsRecorder(target)) return true;
  const names = readPath(target);
  return (
    names !== null &&
    !names.includes("current") &&
    (spyMatchers.has(matcher) || matcher === "toHaveLength")
  );
}

// `expect.poll(() => list).toHaveLength(n)`.
function pollsLength(node, value) {
  const names = readPath(value);
  return (
    node.parent.type === "MemberExpression" &&
    propertyName(node.parent) === "toHaveLength" &&
    names !== null &&
    !names.includes("current")
  );
}

const noUnsignaledPoll = {
  meta: { type: "problem", schema: allowlistSchema },
  create(context) {
    const violations = [];
    return {
      CallExpression(node) {
        const poll = isMember(node.callee, "expect", "poll");
        if (!poll && !isMember(node.callee, "vi", "waitFor")) return;
        const [callback] = node.arguments;
        const value = callback && polledValue(callback);
        if (!value) return;
        if (
          readsRecorder(value) ||
          (poll ? pollsLength(node, value) : assertsRecorder(value))
        ) {
          violations.push(node);
        }
      },
      "Program:exit"(program) {
        reportAllowed(
          context,
          program,
          violations,
          "Await a signal instead of polling a request recorder or spy: resolve a Promise.withResolvers() deferred from the handler or callback that records it, then await its promise, or await the operation's own completion. A deadline-bound poll on a counter fails under CPU load, and a longer timeout only hides that.",
          (path, count) =>
            `This file now has ${count} unsignaled polls; lower its bb/no-unsignaled-poll allowlist entry for ${path} in .oxlintrc.tests.json to ${count}, or remove the entry at 0.`,
        );
      },
    };
  },
};

export const rules = {
  "no-blocking-child-process-call": noBlockingChildProcessCall,
  "no-fixed-sleep": noFixedSleep,
  "no-native-title-on-button": noNativeTitleOnButton,
  "no-native-title-with-aria-label": noNativeTitleWithAriaLabel,
  "no-unsignaled-poll": noUnsignaledPoll,
};

export default {
  meta: {
    name: "bb",
  },
  rules,
};
