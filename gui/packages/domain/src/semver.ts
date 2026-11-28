// Our own semver: the part of node-semver 7.7.4 (ISC, Isaac Z. Schlueter and
// Contributors; notice in gui/NOTICE) that Cloudroom calls, ported as is in
// its default strict mode, without the `loose` and `includePrerelease`
// options: SemVer, Comparator, Range, parse, valid, compare, rcompare, gt,
// gte, lt, major, prerelease, coerce, validRange, satisfies, and minVersion.
// Ranges follow npm's grammar: `||`, hyphen ranges, x-ranges, `~`, `^`, and
// the rule that a prerelease only matches a comparator on its own
// major.minor.patch that has a prerelease too.
// 7.7.4 is what the server ran, so ranges saved under it stay valid. 7.8
// rejects x-ranges like 1.x.3; versions parse and compare the same in both.

type Identifier = string | number;
type Version = string | SemVer;

const MAX_LENGTH = 256;
const MAX_SAFE_COMPONENT_LENGTH = 16;
const MAX_SAFE_BUILD_LENGTH = MAX_LENGTH - 6;
const LETTERDASHNUMBER = "[a-zA-Z0-9-]";

// node-semver's regex tokens. `src` holds each token's source; `re` holds the
// "safe" form that caps `\s`, `\d`, and identifier repeats against regex DoS.
const src: Record<string, string> = {};
const re: Record<string, RegExp> = {};
function token(name: string, value: string, global = false): void {
  src[name] = value;
  let safe = value;
  for (const [unit, max] of [
    ["\\s", 1],
    ["\\d", MAX_LENGTH],
    [LETTERDASHNUMBER, MAX_SAFE_BUILD_LENGTH],
  ] as const) {
    safe = safe
      .split(`${unit}*`)
      .join(`${unit}{0,${max}}`)
      .split(`${unit}+`)
      .join(`${unit}{1,${max}}`);
  }
  re[name] = new RegExp(safe, global ? "g" : undefined);
}

token("NUMERICIDENTIFIER", "0|[1-9]\\d*");
token("NUMERICIDENTIFIERLOOSE", "\\d+");
token("NONNUMERICIDENTIFIER", `\\d*[a-zA-Z-]${LETTERDASHNUMBER}*`);
token(
  "MAINVERSION",
  `(${src.NUMERICIDENTIFIER})\\.(${src.NUMERICIDENTIFIER})\\.(${src.NUMERICIDENTIFIER})`,
);
token(
  "MAINVERSIONLOOSE",
  `(${src.NUMERICIDENTIFIERLOOSE})\\.(${src.NUMERICIDENTIFIERLOOSE})\\.(${src.NUMERICIDENTIFIERLOOSE})`,
);
token(
  "PRERELEASEIDENTIFIER",
  `(?:${src.NONNUMERICIDENTIFIER}|${src.NUMERICIDENTIFIER})`,
);
token(
  "PRERELEASEIDENTIFIERLOOSE",
  `(?:${src.NONNUMERICIDENTIFIER}|${src.NUMERICIDENTIFIERLOOSE})`,
);
token(
  "PRERELEASE",
  `(?:-(${src.PRERELEASEIDENTIFIER}(?:\\.${src.PRERELEASEIDENTIFIER})*))`,
);
token(
  "PRERELEASELOOSE",
  `(?:-?(${src.PRERELEASEIDENTIFIERLOOSE}(?:\\.${src.PRERELEASEIDENTIFIERLOOSE})*))`,
);
token("BUILDIDENTIFIER", `${LETTERDASHNUMBER}+`);
token("BUILD", `(?:\\+(${src.BUILDIDENTIFIER}(?:\\.${src.BUILDIDENTIFIER})*))`);
token("FULLPLAIN", `v?${src.MAINVERSION}${src.PRERELEASE}?${src.BUILD}?`);
token("FULL", `^${src.FULLPLAIN}$`);
token(
  "LOOSEPLAIN",
  `[v=\\s]*${src.MAINVERSIONLOOSE}${src.PRERELEASELOOSE}?${src.BUILD}?`,
);
token("GTLT", "((?:<|>)?=?)");
token("XRANGEIDENTIFIER", `${src.NUMERICIDENTIFIER}|x|X|\\*`);
token(
  "XRANGEPLAIN",
  `[v=\\s]*(${src.XRANGEIDENTIFIER})(?:\\.(${src.XRANGEIDENTIFIER})(?:\\.(${src.XRANGEIDENTIFIER})(?:${src.PRERELEASE})?${src.BUILD}?)?)?`,
);
token("XRANGE", `^${src.GTLT}\\s*${src.XRANGEPLAIN}$`);
token(
  "COERCEPLAIN",
  `(^|[^\\d])(\\d{1,${MAX_SAFE_COMPONENT_LENGTH}})(?:\\.(\\d{1,${MAX_SAFE_COMPONENT_LENGTH}}))?(?:\\.(\\d{1,${MAX_SAFE_COMPONENT_LENGTH}}))?`,
);
token("COERCE", `${src.COERCEPLAIN}(?:$|[^\\d])`);
token("LONETILDE", "(?:~>?)");
token("TILDETRIM", `(\\s*)${src.LONETILDE}\\s+`, true);
token("TILDE", `^${src.LONETILDE}${src.XRANGEPLAIN}$`);
token("LONECARET", "(?:\\^)");
token("CARETTRIM", `(\\s*)${src.LONECARET}\\s+`, true);
token("CARET", `^${src.LONECARET}${src.XRANGEPLAIN}$`);
token("COMPARATOR", `^${src.GTLT}\\s*(${src.FULLPLAIN})$|^$`);
token(
  "COMPARATORTRIM",
  `(\\s*)${src.GTLT}\\s*(${src.LOOSEPLAIN}|${src.XRANGEPLAIN})`,
  true,
);
token(
  "HYPHENRANGE",
  `^\\s*(${src.XRANGEPLAIN})\\s+-\\s+(${src.XRANGEPLAIN})\\s*$`,
);
token("STAR", "(<|>)?=?\\s*\\*");
token("GTE0", "^\\s*>=\\s*0\\.0\\.0\\s*$");

const NUMERIC = /^[0-9]+$/;
function compareIdentifiers(a: Identifier, b: Identifier): number {
  if (typeof a === "number" && typeof b === "number") {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  const aNumeric = NUMERIC.test(String(a));
  const bNumeric = NUMERIC.test(String(b));
  if (aNumeric && bNumeric) {
    const x = +a;
    const y = +b;
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a === b ? 0 : String(a) < String(b) ? -1 : 1;
}

export class SemVer {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: Identifier[];
  build: string[];
  version = "";

  constructor(version: string) {
    if (typeof version !== "string") {
      throw new TypeError(
        `Invalid version. Must be a string. Got type "${typeof version}".`,
      );
    }
    if (version.length > MAX_LENGTH) {
      throw new TypeError(`version is longer than ${MAX_LENGTH} characters`);
    }
    const m = version.trim().match(re.FULL);
    if (!m) throw new TypeError(`Invalid Version: ${version}`);
    this.raw = version;
    this.major = +m[1];
    this.minor = +m[2];
    this.patch = +m[3];
    if (this.major > Number.MAX_SAFE_INTEGER || this.major < 0) {
      throw new TypeError("Invalid major version");
    }
    if (this.minor > Number.MAX_SAFE_INTEGER || this.minor < 0) {
      throw new TypeError("Invalid minor version");
    }
    if (this.patch > Number.MAX_SAFE_INTEGER || this.patch < 0) {
      throw new TypeError("Invalid patch version");
    }
    this.prerelease = m[4]
      ? m[4].split(".").map((id) => {
          if (NUMERIC.test(id)) {
            const num = +id;
            if (num >= 0 && num < Number.MAX_SAFE_INTEGER) return num;
          }
          return id;
        })
      : [];
    this.build = m[5] ? m[5].split(".") : [];
    this.format();
  }

  format(): string {
    this.version = `${this.major}.${this.minor}.${this.patch}`;
    if (this.prerelease.length) this.version += `-${this.prerelease.join(".")}`;
    return this.version;
  }

  toString(): string {
    return this.version;
  }

  compare(other: Version): number {
    if (!(other instanceof SemVer)) {
      if (typeof other === "string" && other === this.version) return 0;
      other = new SemVer(other);
    }
    if (other.version === this.version) return 0;
    return this.compareMain(other) || this.comparePre(other);
  }

  compareMain(other: SemVer): number {
    if (this.major !== other.major) return this.major < other.major ? -1 : 1;
    if (this.minor !== other.minor) return this.minor < other.minor ? -1 : 1;
    if (this.patch !== other.patch) return this.patch < other.patch ? -1 : 1;
    return 0;
  }

  // Having no prerelease sorts after having one.
  comparePre(other: SemVer): number {
    if (this.prerelease.length && !other.prerelease.length) return -1;
    if (!this.prerelease.length && other.prerelease.length) return 1;
    if (!this.prerelease.length && !other.prerelease.length) return 0;
    for (let i = 0; ; i++) {
      const a = this.prerelease[i];
      const b = other.prerelease[i];
      if (a === undefined && b === undefined) return 0;
      if (b === undefined) return 1;
      if (a === undefined) return -1;
      if (a !== b) return compareIdentifiers(a, b);
    }
  }
}

function semverOf(version: Version): SemVer {
  return version instanceof SemVer ? version : new SemVer(version);
}

function cmp(a: SemVer, operator: string, b: SemVer): boolean {
  const order = compare(a, b);
  switch (operator) {
    case "":
      return order === 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
  }
  throw new TypeError(`Invalid operator: ${operator}`);
}

export class Comparator {
  operator: string;
  /** null matches any version (node-semver's `Comparator.ANY`). */
  semver: SemVer | null;
  value: string;

  constructor(comp: string) {
    comp = comp.trim().split(/\s+/).join(" ");
    const m = comp.match(re.COMPARATOR);
    if (!m) throw new TypeError(`Invalid comparator: ${comp}`);
    this.operator = m[1] !== undefined && m[1] !== "=" ? m[1] : "";
    this.semver = m[2] ? new SemVer(m[2]) : null;
    this.value =
      this.semver === null ? "" : this.operator + this.semver.version;
  }

  toString(): string {
    return this.value;
  }

  test(version: Version): boolean {
    if (this.semver === null) return true;
    if (typeof version === "string") {
      try {
        version = new SemVer(version);
      } catch {
        return false;
      }
    }
    return cmp(version, this.operator, this.semver);
  }
}

const isNullSet = (c: Comparator) => c.value === "<0.0.0-0";
const isAny = (c: Comparator) => c.value === "";
const isX = (id: string | undefined) =>
  !id || id.toLowerCase() === "x" || id === "*";

export class Range {
  raw: string;
  set: Comparator[][];

  constructor(range: string) {
    this.raw = range.trim().replace(/\s+/g, " ");
    let set = this.raw
      .split("||")
      .map((part) => parseRange(part.trim()))
      .filter((comparators) => comparators.length);
    if (!set.length) throw new TypeError(`Invalid SemVer Range: ${this.raw}`);
    // Drop null sets unless every set is one; a lone `*` set wins outright.
    if (set.length > 1) {
      const first = set[0];
      set = set.filter((comparators) => !isNullSet(comparators[0]));
      if (set.length === 0) {
        set = [first];
      } else if (set.length > 1) {
        const any = set.find((c) => c.length === 1 && isAny(c[0]));
        if (any) set = [any];
      }
    }
    this.set = set;
  }

  get range(): string {
    return this.set
      .map((comparators) => comparators.map((c) => c.value.trim()).join(" "))
      .join("||");
  }

  toString(): string {
    return this.range;
  }

  test(version: Version): boolean {
    if (!version) return false;
    if (typeof version === "string") {
      try {
        version = new SemVer(version);
      } catch {
        return false;
      }
    }
    const parsed = version;
    return this.set.some((comparators) => testSet(comparators, parsed));
  }
}

function testSet(comparators: Comparator[], version: SemVer): boolean {
  if (!comparators.every((c) => c.test(version))) return false;
  if (!version.prerelease.length) return true;
  // `^1.2.3-pr.1` lets `1.2.3-pr.2` through, but not `1.2.4-alpha`.
  return comparators.some(
    (c) =>
      c.semver !== null &&
      c.semver.prerelease.length > 0 &&
      c.semver.major === version.major &&
      c.semver.minor === version.minor &&
      c.semver.patch === version.patch,
  );
}

// Parsed sets by range text, least recently used first, like node-semver's
// cache: update checks test one range against every published version.
const parsedRanges = new Map<string, Comparator[]>();

function parseRange(range: string): Comparator[] {
  const cached = parsedRanges.get(range);
  if (cached) {
    parsedRanges.delete(range);
    parsedRanges.set(range, cached);
    return cached;
  }
  const key = range;
  range = range
    .replace(re.HYPHENRANGE, hyphenReplace)
    .replace(re.COMPARATORTRIM, "$1$2$3")
    .replace(re.TILDETRIM, "$1~")
    .replace(re.CARETTRIM, "$1^");
  const comparators = range
    .split(" ")
    .map(parseComparator)
    .join(" ")
    .split(/\s+/)
    .map((comp) => new Comparator(comp.trim().replace(re.GTE0, "")));
  const byValue = new Map<string, Comparator>();
  for (const comp of comparators) {
    if (isNullSet(comp)) return [comp];
    byValue.set(comp.value, comp);
  }
  if (byValue.size > 1) byValue.delete("");
  const result = [...byValue.values()];
  const oldest = parsedRanges.keys().next().value;
  if (parsedRanges.size >= 1000 && oldest !== undefined) {
    parsedRanges.delete(oldest);
  }
  parsedRanges.set(key, result);
  return result;
}

// Turns carets, tildes, x-ranges, and stars into plain comparators.
function parseComparator(comp: string): string {
  comp = comp.replace(re.BUILD, "");
  comp = comp.trim().split(/\s+/).map(replaceCaret).join(" ");
  comp = comp.trim().split(/\s+/).map(replaceTilde).join(" ");
  comp = comp.split(/\s+/).map(replaceXRange).join(" ");
  return comp.trim().replace(re.STAR, "");
}

// ~1.2.3 is >=1.2.3 <1.3.0-0; ~1.2 is >=1.2.0 <1.3.0-0; ~1 is >=1.0.0 <2.0.0-0.
function replaceTilde(comp: string): string {
  return comp.replace(
    re.TILDE,
    (_, M: string, m?: string, p?: string, pr?: string) => {
      if (isX(M)) return "";
      if (isX(m)) return `>=${M}.0.0 <${+M + 1}.0.0-0`;
      if (isX(p)) return `>=${M}.${m}.0 <${M}.${+(m as string) + 1}.0-0`;
      const from = pr ? `>=${M}.${m}.${p}-${pr}` : `>=${M}.${m}.${p}`;
      return `${from} <${M}.${+(m as string) + 1}.0-0`;
    },
  );
}

// ^1.2.3 is >=1.2.3 <2.0.0-0; ^0.2.3 is >=0.2.3 <0.3.0-0; ^0.0.3 is >=0.0.3 <0.0.4-0.
function replaceCaret(comp: string): string {
  return comp.replace(
    re.CARET,
    (_, M: string, m?: string, p?: string, pr?: string) => {
      if (isX(M)) return "";
      if (isX(m)) return `>=${M}.0.0 <${+M + 1}.0.0-0`;
      if (isX(p)) {
        return M === "0"
          ? `>=${M}.${m}.0 <${M}.${+(m as string) + 1}.0-0`
          : `>=${M}.${m}.0 <${+M + 1}.0.0-0`;
      }
      const from = pr ? `>=${M}.${m}.${p}-${pr}` : `>=${M}.${m}.${p}`;
      if (M !== "0") return `${from} <${+M + 1}.0.0-0`;
      return m === "0"
        ? `${from} <${M}.${m}.${+(p as string) + 1}-0`
        : `${from} <${M}.${+(m as string) + 1}.0-0`;
    },
  );
}

function replaceXRange(comp: string): string {
  comp = comp.trim();
  return comp.replace(
    re.XRANGE,
    (ret: string, gtlt: string, M: string, m?: string, p?: string) => {
      // The first x wins: 1.x.3 is 1.x, and x.1.2 is any version.
      const xM = isX(M);
      const xm = xM || isX(m);
      const anyX = xm || isX(p);
      if (gtlt === "=" && anyX) gtlt = "";
      if (xM) return gtlt === ">" || gtlt === "<" ? "<0.0.0-0" : "*";
      if (gtlt && anyX) {
        let major: string | number = M;
        let minor: string | number = xm ? 0 : (m as string);
        if (gtlt === ">") {
          // >1 is >=2.0.0, and >1.2 is >=1.3.0.
          gtlt = ">=";
          if (xm) major = +M + 1;
          else minor = +minor + 1;
        } else if (gtlt === "<=") {
          // <=0.7.x is <0.8.0-0, and <=7.x is <8.0.0-0.
          gtlt = "<";
          if (xm) major = +M + 1;
          else minor = +minor + 1;
        }
        return `${gtlt}${major}.${minor}.0${gtlt === "<" ? "-0" : ""}`;
      }
      if (xm) return `>=${M}.0.0 <${+M + 1}.0.0-0`;
      if (anyX) return `>=${M}.${m}.0 <${M}.${+(m as string) + 1}.0-0`;
      return ret;
    },
  );
}

// 1.2 - 3.4.5 is >=1.2.0 <=3.4.5; 1.2.3 - 3.4 is >=1.2.3 <3.5.0-0.
function hyphenReplace(
  _: string,
  from: string,
  fM: string,
  fm: string | undefined,
  fp: string | undefined,
  _fpr: string | undefined,
  _fb: string | undefined,
  to: string,
  tM: string,
  tm: string | undefined,
  tp: string | undefined,
  tpr: string | undefined,
): string {
  if (isX(fM)) from = "";
  else if (isX(fm)) from = `>=${fM}.0.0`;
  else if (isX(fp)) from = `>=${fM}.${fm}.0`;
  else from = `>=${from}`;
  if (isX(tM)) to = "";
  else if (isX(tm)) to = `<${+tM + 1}.0.0-0`;
  else if (isX(tp)) to = `<${tM}.${+(tm as string) + 1}.0-0`;
  else if (tpr) to = `<=${tM}.${tm}.${tp}-${tpr}`;
  else to = `<=${to}`;
  return `${from} ${to}`.trim();
}

export function parse(version: Version): SemVer | null {
  if (version instanceof SemVer) return version;
  try {
    return new SemVer(version);
  } catch {
    return null;
  }
}

export function valid(version: Version): string | null {
  return parse(version)?.version ?? null;
}

export function compare(a: Version, b: Version): number {
  return semverOf(a).compare(semverOf(b));
}

export function rcompare(a: Version, b: Version): number {
  return compare(b, a);
}

export function gt(a: Version, b: Version): boolean {
  return compare(a, b) > 0;
}

export function gte(a: Version, b: Version): boolean {
  return compare(a, b) >= 0;
}

export function lt(a: Version, b: Version): boolean {
  return compare(a, b) < 0;
}

export function major(version: Version): number {
  return semverOf(version).major;
}

export function prerelease(version: Version): Identifier[] | null {
  const parsed = parse(version);
  return parsed && parsed.prerelease.length ? parsed.prerelease : null;
}

/** The first `1`, `1.2`, or `1.2.3` in the text, as a version, e.g. `v2.4-beta` is 2.4.0. */
export function coerce(version: Version | number): SemVer | null {
  if (version instanceof SemVer) return version;
  if (typeof version === "number") version = String(version);
  if (typeof version !== "string") return null;
  const m = version.match(re.COERCE);
  if (m === null) return null;
  return parse(`${m[2]}.${m[3] || "0"}.${m[4] || "0"}`);
}

/** The normalized range, `*` for any version, or null if it isn't a range. */
export function validRange(range: string): string | null {
  try {
    return new Range(range).range || "*";
  } catch {
    return null;
  }
}

export function satisfies(version: Version, range: string): boolean {
  let parsed: Range;
  try {
    parsed = new Range(range);
  } catch {
    return false;
  }
  return parsed.test(version);
}

/** The lowest version the range matches, or null. Throws if it isn't a range. */
export function minVersion(range: string): SemVer | null {
  const parsed = new Range(range);
  for (const floor of ["0.0.0", "0.0.0-0"]) {
    const version = new SemVer(floor);
    if (parsed.test(version)) return version;
  }
  let lowest: SemVer | null = null;
  for (const comparators of parsed.set) {
    let setMin: SemVer | null = null;
    for (const comparator of comparators) {
      // A set that held a `*` comparator matched 0.0.0 above.
      if (comparator.semver === null) continue;
      const version = new SemVer(comparator.semver.version);
      if (comparator.operator === ">") {
        if (version.prerelease.length === 0) version.patch++;
        else version.prerelease.push(0);
        version.raw = version.format();
      } else if (comparator.operator !== "" && comparator.operator !== ">=") {
        continue;
      }
      if (!setMin || gt(version, setMin)) setMin = version;
    }
    if (setMin && (!lowest || gt(lowest, setMin))) lowest = setMin;
  }
  return lowest && parsed.test(lowest) ? lowest : null;
}
