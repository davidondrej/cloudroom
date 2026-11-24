/**
 * @license
 * The matcher below is ported from fzf for JavaScript 0.5.2
 * (https://github.com/ajitid/fzf-for-js), a port of the algorithm of fzf
 * (https://github.com/junegunn/fzf) by Junegunn Choi.
 *
 * BSD 3-Clause License
 *
 * Copyright (c) 2021, Ajit
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// fzf's basic search with the options fuzzy-match uses: the whole query is one
// fuzzy term (spaces included), scored by fzf's V2 algorithm (V1 once text
// length times query length outgrows the scratch buffer), scanning forward,
// with Latin letters folded to ASCII. Texts and query are NFC-normalized, and
// positions count UTF-16 code units of the normalized text.

export type Casing = "smart-case" | "case-insensitive";

export interface FzfHit {
  index: number;
  score: number;
  start: number;
  positions: Set<number>;
}

type Match = Omit<FzfHit, "index">;

const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;
const BONUS_BOUNDARY = SCORE_MATCH / 2;
const BONUS_NON_WORD = SCORE_MATCH / 2;
const BONUS_CAMEL_123 = BONUS_BOUNDARY + SCORE_GAP_EXTENSION;
const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION);
const BONUS_FIRST_CHAR_MULTIPLIER = 2;

const NON_WORD = 0;
const LOWER = 1;
const UPPER = 2;
const LETTER = 3;
const NUMBER = 4;
const NUMBER_CHAR = /\p{Number}/u;
const LETTER_CHAR = /\p{Letter}/u;

// Letters fzf folds to ASCII: its table (code point, then letter), then every
// letter one combining mark (U+0300 to U+036F) composes, then a Vietnamese
// range per vowel. Later entries win, as in fzf.
const FOLD_TABLE = `216O 223s 248o 273d 295h 305i 320l 322l 359t 383s 384b 385B 387b 390O 392c
393D 394D 396d 398E 400E 402f 403G 407I 409k 410l 412M 413N 414n 415O 421p
427t 429t 430T 434V 436y 438z 477e 485g 544N 545d 549z 564l 565n 566t 567j
570A 571C 572c 573L 574T 575s 576z 579B 580U 581V 582E 583e 584J 585j 586Q
587q 588R 589r 590Y 591y 592a 593a 595b 596o 597c 598d 599d 600e 603e 604e
605e 606e 607j 608g 609g 610G 613h 614h 616i 618I 619l 620l 621l 623m 624m
625m 626n 627n 628N 629o 633r 634r 635r 636r 637r 638r 639r 640R 641R 642s
647t 648t 649u 651v 652v 653w 654y 655Y 656z 657z 663c 665B 666e 667G 668H
669j 670k 671L 672q 686h 867a 868e 869i 870o 871u 872c 873d 874h 875m 876r
877t 878v 879x 7424A 7427B 7428C 7429D 7431E 7432e 7433i 7434J 7435K 7436L
7437M 7438N 7439O 7440O 7441o 7442o 7443o 7446o 7447o 7448P 7449R 7450R
7451T 7452U 7453u 7454u 7455m 7456V 7457W 7458Z 7522i 7523r 7524u 7525v
7834a 7835s 8305i 8341h 8342k 8343l 8344m 8345n 8346p 8347s 8348t 8580c`;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const FOLDS = new Map<number, number>();
for (const [, code, letter] of FOLD_TABLE.matchAll(/(\d+)([A-Za-z])/g)) {
  FOLDS.set(Number(code), letter!.charCodeAt(0));
}
for (let mark = 0x300; mark <= 0x36f; mark++) {
  for (const letter of LETTERS) {
    const composed = (letter + String.fromCodePoint(mark))
      .normalize()
      .codePointAt(0)!;
    if (composed > 126) FOLDS.set(composed, letter.charCodeAt(0));
  }
}
for (const [vowel, first, last] of [
  ["a", 7844, 7863],
  ["e", 7870, 7879],
  ["o", 7888, 7907],
  ["u", 7912, 7921],
] as const) {
  for (let code = first; code <= last; code++) {
    const letter = code % 2 === 0 ? vowel.toUpperCase() : vowel;
    FOLDS.set(code, letter.charCodeAt(0));
  }
}

function fold(rune: number): number {
  return rune < 192 || rune > 8580 ? rune : (FOLDS.get(rune) ?? rune);
}

function lower(rune: number): number {
  return String.fromCodePoint(rune).toLowerCase().codePointAt(0)!;
}

// fzf's runes are UTF-16 code units, so a surrogate pair is two runes.
function toRunes(text: string): number[] {
  const runes = new Array<number>(text.length);
  for (let i = 0; i < text.length; i++) runes[i] = text.charCodeAt(i);
  return runes;
}

function charClassOfAscii(rune: number): number {
  if (rune >= 97 && rune <= 122) return LOWER;
  if (rune >= 65 && rune <= 90) return UPPER;
  if (rune >= 48 && rune <= 57) return NUMBER;
  return NON_WORD;
}

function charClassOfNonAscii(rune: number): number {
  const char = String.fromCodePoint(rune);
  if (char !== char.toUpperCase()) return LOWER;
  if (char !== char.toLowerCase()) return UPPER;
  if (NUMBER_CHAR.test(char)) return NUMBER;
  if (LETTER_CHAR.test(char)) return LETTER;
  return NON_WORD;
}

function charClassOf(rune: number): number {
  return rune <= 127 ? charClassOfAscii(rune) : charClassOfNonAscii(rune);
}

function bonusFor(prevClass: number, charClass: number): number {
  if (prevClass === NON_WORD && charClass !== NON_WORD) return BONUS_BOUNDARY;
  if (
    (prevClass === LOWER && charClass === UPPER) ||
    (prevClass !== NUMBER && charClass === NUMBER)
  ) {
    return BONUS_CAMEL_123;
  }
  return charClass === NON_WORD ? BONUS_NON_WORD : 0;
}

// The first index of `char` from `from`, or of its capital when not
// case-sensitive, whichever comes first; -1 if neither occurs.
function trySkip(
  input: readonly number[],
  caseSensitive: boolean,
  char: number,
  from: number,
): number {
  const index = input.indexOf(char, from);
  if (index === from || caseSensitive || char < 97 || char > 122) return index;
  const upper = input.indexOf(char - 32, from);
  return upper >= 0 && (index < 0 || upper < index) ? upper : index;
}

const isAscii = (runes: readonly number[]) => runes.every((r) => r < 128);

// Where an ASCII text can start matching an ASCII pattern (one before its first
// character), -1 when it cannot match, 0 when either is not ASCII.
function asciiFuzzyIndex(
  input: readonly number[],
  pattern: readonly number[],
  caseSensitive: boolean,
): number {
  if (!isAscii(input)) return 0;
  if (!isAscii(pattern)) return -1;
  let firstIndex = 0;
  let index = 0;
  for (let p = 0; p < pattern.length; p++) {
    index = trySkip(input, caseSensitive, pattern[p]!, index);
    if (index < 0) return -1;
    if (p === 0 && index > 0) firstIndex = index - 1;
    index++;
  }
  return firstIndex;
}

// fzf's scratch buffer, shared by every search and cleared before each one.
// Backtraces read some cells this text never wrote (the next row of C), so
// keep fzf's sizes and offsets: they decide what those cells hold.
const slab16 = new Int16Array(100 * 1024);
const slab32 = new Int32Array(2048);

function alloc16(offset: number, size: number): [number, Int16Array] {
  return slab16.length > offset + size
    ? [offset + size, slab16.subarray(offset, offset + size)]
    : [offset, new Int16Array(size)];
}

function alloc32(offset: number, size: number): [number, Int32Array] {
  return slab32.length > offset + size
    ? [offset + size, slab32.subarray(offset, offset + size)]
    : [offset, new Int32Array(size)];
}

// Smith-Waterman-style best alignment of a non-empty pattern in input.
function fuzzyMatchV2(
  caseSensitive: boolean,
  input: readonly number[],
  pattern: readonly number[],
): Match | null {
  const M = pattern.length;
  const N = input.length;
  if (N * M > slab16.length) return fuzzyMatchV1(caseSensitive, input, pattern);
  const idx = asciiFuzzyIndex(input, pattern, caseSensitive);
  if (idx < 0) return null;

  const [afterH0, H0] = alloc16(0, N);
  const [afterC0, C0] = alloc16(afterH0, N);
  const [afterB, B] = alloc16(afterC0, N);
  const [afterF, F] = alloc32(0, M);
  const [, T] = alloc32(afterF, N);
  T.set(input);

  // Phase 1: fold the text, find the first occurrence of each pattern
  // character in order (F), and score the first character on its own (H0).
  let maxScore = 0;
  let maxScorePos = 0;
  let pidx = 0;
  let lastIdx = 0;
  const pchar0 = pattern[0]!;
  let pchar = pchar0;
  let prevH0 = 0;
  let prevClass = NON_WORD;
  let inGap = false;
  for (let col = idx; col < N; col++) {
    let char = T[col]!;
    let charClass: number;
    if (char <= 127) {
      charClass = charClassOfAscii(char);
      if (!caseSensitive && charClass === UPPER) char += 32;
    } else {
      charClass = charClassOfNonAscii(char);
      if (!caseSensitive && charClass === UPPER) char = lower(char);
      char = fold(char);
    }
    T[col] = char;
    const bonus = bonusFor(prevClass, charClass);
    B[col] = bonus;
    prevClass = charClass;
    if (char === pchar) {
      if (pidx < M) {
        F[pidx] = col;
        pidx++;
        pchar = pattern[Math.min(pidx, M - 1)]!;
      }
      lastIdx = col;
    }
    if (char === pchar0) {
      const score = SCORE_MATCH + bonus * BONUS_FIRST_CHAR_MULTIPLIER;
      H0[col] = score;
      C0[col] = 1;
      if (M === 1 && score > maxScore) {
        maxScore = score;
        maxScorePos = col;
        if (bonus === BONUS_BOUNDARY) break;
      }
      inGap = false;
    } else {
      const gap = inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START;
      H0[col] = Math.max(prevH0 + gap, 0);
      C0[col] = 0;
      inGap = true;
    }
    prevH0 = H0[col]!;
  }
  if (pidx !== M) return null;
  if (M === 1) {
    return {
      start: maxScorePos,
      score: maxScore,
      positions: new Set([maxScorePos]),
    };
  }

  // Phase 2: fill the score matrix H and the consecutive-match matrix C, one
  // row per pattern character, over columns F[0]..lastIdx.
  const f0 = F[0]!;
  const width = lastIdx - f0 + 1;
  const [afterH, H] = alloc16(afterB, width * M);
  H.set(H0.subarray(f0, lastIdx + 1));
  const [, C] = alloc16(afterH, width * M);
  C.set(C0.subarray(f0, lastIdx + 1));
  for (let row = 1; row < M; row++) {
    const f = F[row]!;
    const char = pattern[row]!;
    const I = row * width;
    let inGap = false;
    H[I + f - f0 - 1] = 0;
    for (let col = f; col <= lastIdx; col++) {
      const j0 = col - f0;
      let s1 = 0;
      let consecutive = 0;
      const gap: number = inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START;
      const s2 = H[I + j0 - 1]! + gap;
      if (char === T[col]) {
        s1 = H[I - width + j0 - 1]! + SCORE_MATCH;
        let b = B[col]!;
        consecutive = C[I - width + j0 - 1]! + 1;
        if (b === BONUS_BOUNDARY) {
          consecutive = 1;
        } else if (consecutive > 1) {
          b = Math.max(b, BONUS_CONSECUTIVE, B[col - consecutive + 1]!);
        }
        if (s1 + b < s2) {
          s1 += B[col]!;
          consecutive = 0;
        } else {
          s1 += b;
        }
      }
      C[I + j0] = consecutive;
      inGap = s1 < s2;
      const score = Math.max(s1, s2, 0);
      if (row === M - 1 && score > maxScore) {
        maxScore = score;
        maxScorePos = col;
      }
      H[I + j0] = score;
    }
  }

  // Phase 3: backtrace from the best cell to collect the matched positions.
  const positions = new Set<number>();
  let row = M - 1;
  let j = maxScorePos;
  let preferMatch = true;
  for (;;) {
    const I = row * width;
    const j0 = j - f0;
    const s = H[I + j0]!;
    const s1 = row > 0 && j >= F[row]! ? H[I - width + j0 - 1]! : 0;
    const s2 = j > F[row]! ? H[I + j0 - 1]! : 0;
    if (s > s1 && (s > s2 || (s === s2 && preferMatch))) {
      positions.add(j);
      if (row === 0) break;
      row--;
    }
    preferMatch =
      C[I + j0]! > 1 ||
      (I + width + j0 + 1 < C.length && C[I + width + j0 + 1]! > 0);
    j--;
  }
  return { start: j, score: maxScore, positions };
}

// fzf's V1: the shortest span that ends at the first full match, scored by
// calculateScore. Its backward pass does not fold letters, as in fzf.
function fuzzyMatchV1(
  caseSensitive: boolean,
  text: readonly number[],
  pattern: readonly number[],
): Match | null {
  if (asciiFuzzyIndex(text, pattern, caseSensitive) < 0) return null;
  const toCase = (rune: number) =>
    caseSensitive
      ? rune
      : rune >= 65 && rune <= 90
        ? rune + 32
        : rune > 127
          ? lower(rune)
          : rune;
  let pidx = 0;
  let start = -1;
  let end = -1;
  for (let index = 0; index < text.length; index++) {
    if (fold(toCase(text[index]!)) !== pattern[pidx]) continue;
    if (start < 0) start = index;
    if (++pidx === pattern.length) {
      end = index + 1;
      break;
    }
  }
  if (start < 0 || end < 0) return null;
  pidx--;
  for (let index = end - 1; index >= start; index--) {
    if (toCase(text[index]!) === pattern[pidx] && --pidx < 0) {
      start = index;
      break;
    }
  }
  return calculateScore(text, pattern, start, end, toCase);
}

function calculateScore(
  text: readonly number[],
  pattern: readonly number[],
  start: number,
  end: number,
  toCase: (rune: number) => number,
): Match {
  let pidx = 0;
  let score = 0;
  let inGap = false;
  let consecutive = 0;
  let firstBonus = 0;
  const positions = new Set<number>();
  let prevClass = start > 0 ? charClassOf(text[start - 1]!) : NON_WORD;
  for (let index = start; index < end; index++) {
    const rune = text[index]!;
    const charClass = charClassOf(rune);
    if (fold(toCase(rune)) === pattern[pidx]) {
      positions.add(index);
      score += SCORE_MATCH;
      let bonus = bonusFor(prevClass, charClass);
      if (consecutive === 0) {
        firstBonus = bonus;
      } else {
        if (bonus === BONUS_BOUNDARY) firstBonus = bonus;
        bonus = Math.max(bonus, firstBonus, BONUS_CONSECUTIVE);
      }
      score += pidx === 0 ? bonus * BONUS_FIRST_CHAR_MULTIPLIER : bonus;
      inGap = false;
      consecutive++;
      pidx++;
    } else {
      score += inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START;
      inGap = true;
      consecutive = 0;
      firstBonus = 0;
    }
    prevClass = charClass;
  }
  return { start, score, positions };
}

/**
 * Prepares texts once; each call returns the texts that match the query, best
 * first. Equal scores go by earlier start, then shorter text, then input
 * order. An empty query returns every text unscored, in input order.
 */
export function createFzf(
  texts: readonly string[],
  casing: Casing,
): (query: string) => FzfHit[] {
  const runesList = texts.map((text) => toRunes(text.normalize()));
  return (query) => {
    if (query.length === 0 || texts.length === 0) {
      return texts.map((_, index) => ({
        index,
        score: 0,
        start: -1,
        positions: new Set<number>(),
      }));
    }
    let normalized = query.normalize();
    const caseSensitive =
      casing === "smart-case" && normalized.toLowerCase() !== normalized;
    if (casing === "case-insensitive") normalized = normalized.toLowerCase();
    const pattern = toRunes(normalized).map(fold);
    slab16.fill(0);
    slab32.fill(0);
    const hits: FzfHit[] = [];
    runesList.forEach((runes, index) => {
      if (pattern.length > runes.length) return;
      const match = fuzzyMatchV2(caseSensitive, runes, pattern);
      if (match !== null) hits.push({ index, ...match });
    });
    return hits.sort(
      (left, right) =>
        right.score - left.score ||
        left.start - right.start ||
        texts[left.index]!.length - texts[right.index]!.length,
    );
  };
}
