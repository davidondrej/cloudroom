// Only numbers and arithmetic operators are accepted. The same parser runs in the app and CLI.
export function calculate(source: string): string {
  const expression = source.replace(/\s+/g, "");
  const tokens =
    expression.match(/(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?|[()+*/%^\-]/gi) ??
    [];
  const invalid = () =>
    new Error("Enter a numeric expression such as (3 + 4) * 2.");
  if (!tokens.length || tokens.length > 256 || tokens.join("") !== expression)
    throw invalid();
  let index = 0;
  const precedence: Record<string, number> = {
    "+": 1,
    "-": 1,
    "*": 2,
    "/": 2,
    "%": 2,
    "^": 3,
  };
  function read(minimum: number): number {
    const first = tokens[index++];
    let value: number;
    if (first === "(") {
      value = read(0);
      if (tokens[index++] !== ")") throw invalid();
    } else if (first === "+" || first === "-")
      value = (first === "-" ? -1 : 1) * read(3);
    else {
      value = Number(first);
      if (!Number.isFinite(value)) throw invalid();
    }
    while ((precedence[tokens[index]] ?? -1) >= minimum) {
      const op = tokens[index++],
        right = read(precedence[op] + (op === "^" ? 0 : 1));
      switch (op) {
        case "+":
          value += right;
          break;
        case "-":
          value -= right;
          break;
        case "*":
          value *= right;
          break;
        case "/":
          value /= right;
          break;
        case "%":
          value %= right;
          break;
        case "^":
          value **= right;
          break;
      }
    }
    return value;
  }
  const result = read(0);
  if (index !== tokens.length || !Number.isFinite(result)) throw invalid();
  return String(result);
}
