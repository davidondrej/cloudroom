/**
 * @license
 * describeCron is ported from cronstrue 3.14.0
 * (https://github.com/bradymholt/cronstrue): English, 5-field crons only.
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2017 Brady Holt
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// cronstrue's exact text, quirks included, for every cron that cron-parser
// accepts, so Loops labels stay the same. Syntax cron-parser rejects (W, L-2,
// 6 fields) is left out: it throws or reads oddly, and callers never pass it.

type Describe = (value: string) => string;

/** How one field reads; %s marks where its values go. */
interface Field {
  all: string;
  single: Describe;
  increment: Describe;
  range: string;
  describe: Describe;
}

const WEEKDAYS =
  "Sunday Monday Tuesday Wednesday Thursday Friday Saturday".split(" ");
const MONTHS = (
  "January February March April May June July August September October " +
  "November December"
).split(" ");
const ORDINALS: Record<string, string | undefined> = {
  1: "first",
  2: "second",
  3: "third",
  4: "fourth",
  5: "fifth",
};
const SPECIAL = /[*,/-]/;

function format(template: string, ...values: string[]): string {
  return template.replace(/%s/g, () => String(values.shift()));
}

/** Drops empty list items and sorts the numbers, as cronstrue does. */
function sortList(field: string): string {
  if (!field.includes(",")) return field;
  const items: (number | string)[] = field
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => (Number.isNaN(Number(item)) ? item : Number(item)));
  if (items.length === 0) items.push("*");
  return items.sort((a, b) => Number(a) - Number(b)).join(",");
}

/** A step of 1 means every value; month and weekday steps get an end. */
function normalizeStep(field: string, last?: string): string {
  if (field === "*/1") return "*";
  if (last === undefined || !field.includes("/") || /^\*|[-,]/.test(field)) {
    return field;
  }
  const [start, step] = field.split("/");
  return `${start}-${last}/${step}`;
}

function check(field: string, extra: string, min: number, max: number): void {
  if (new RegExp(`[^0-9,\\-*/${extra}]`, "i").test(field)) {
    throw new Error(`Invalid cron field: ${field}`);
  }
  for (const item of field.split(",")) {
    const value = parseInt(item, 10);
    if (value < min || value > max) {
      throw new Error(`Cron field out of range: ${field}`);
    }
  }
}

function parseFields(cron: string): string[] {
  const fields = cron.trim().split(/ +/).map(sortList);
  if (fields.length !== 5) throw new Error("A cron has 5 fields");
  let [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  hour = hour.replace("?", "*");
  dayOfMonth = dayOfMonth.replace("?", "*");
  dayOfWeek = dayOfWeek.replace("?", "*");
  if (minute.startsWith("0/")) minute = `*${minute.slice(1)}`;
  if (hour.startsWith("0/")) hour = `*${hour.slice(1)}`;
  if (dayOfMonth.startsWith("1/")) dayOfMonth = `*${dayOfMonth.slice(1)}`;
  if (month.startsWith("1/")) month = `*${month.slice(1)}`;
  dayOfWeek = dayOfWeek.replace(/(^\d)|([^#/\s]\d)/g, (match) =>
    match.replace(/\D/, "") === "7" ? match.replace("7", "0") : match,
  );
  if (dayOfWeek === "L") dayOfWeek = "6";
  WEEKDAYS.forEach((day, index) => {
    dayOfWeek = dayOfWeek.replace(
      new RegExp(day.slice(0, 3), "gi"),
      `${index}`,
    );
  });
  MONTHS.forEach((name, index) => {
    month = month.replace(new RegExp(name.slice(0, 3), "gi"), `${index + 1}`);
  });
  if (!SPECIAL.test(hour) && /[*/]/.test(minute)) hour += `-${hour}`;
  minute = normalizeStep(minute);
  hour = normalizeStep(hour);
  dayOfMonth = normalizeStep(dayOfMonth);
  month = normalizeStep(month, "12");
  dayOfWeek = normalizeStep(dayOfWeek, "6");
  check(minute, "", 0, 59);
  check(hour, "", 0, 23);
  check(dayOfMonth, "L", 1, 31);
  check(month, "", 1, 12);
  check(dayOfWeek, "L#", 0, 6);
  return [minute, hour, dayOfMonth, month, dayOfWeek];
}

function formatTime(hourText: string, minuteText: string): string {
  const hour = parseInt(hourText, 10);
  const minute = parseInt(minuteText, 10);
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  const pad = (value: number) => `0${value}`.slice(-2);
  return `${pad(twelveHour)}:${pad(minute)} ${hour >= 12 ? "PM" : "AM"}`;
}

function describeRange(expression: string, field: Field): string {
  const [from, to] = expression.split("-");
  return format(field.range, field.single(from), field.single(to));
}

function describeField(expression: string, field: Field): string {
  if (!expression) return "";
  if (expression === "*") return field.all;
  const hasStep = expression.includes("/");
  if (expression.includes(",")) {
    const items = expression.split(",");
    let content = "";
    items.forEach((item, index) => {
      if (index > 0 && items.length > 2) {
        content += index < items.length - 1 ? ", " : ",";
      }
      if (index > 0 && (index === items.length - 1 || items.length === 2)) {
        content += " and ";
      }
      if (item.includes("-") && !item.includes("/")) {
        const range = { ...field, range: ", %s through %s" };
        content += describeField(item, range).replace(", ", "");
      } else if (item.includes("/")) {
        content += describeField(item, field);
      } else if (!hasStep) {
        content += field.single(item);
      } else {
        const text = describeField(item, field);
        content += text.startsWith(", ") ? text.slice(2) : text;
      }
    });
    return hasStep ? content : format(field.describe(expression), content);
  }
  if (hasStep) {
    const [start, step] = expression.split("/");
    let text = format(field.increment(step), step);
    if (start.includes("-")) {
      const range = describeRange(start, field);
      text += range.startsWith(", ") ? range : `, ${range}`;
    } else if (!start.includes("*")) {
      const startText = format(field.describe(start), field.single(start));
      text += format(", starting %s", startText.replace(", ", ""));
    }
    return text;
  }
  if (expression.includes("-")) return describeRange(expression, field);
  return format(field.describe(expression), field.single(expression));
}

function describeTimeOfDay(minute: string, hour: string): string {
  if (!SPECIAL.test(minute) && !SPECIAL.test(hour)) {
    return `At ${formatTime(hour, minute)}`;
  }
  if (minute.includes("-") && !/[,/]/.test(minute) && !SPECIAL.test(hour)) {
    const [from, to] = minute.split("-");
    return `Every minute between ${formatTime(hour, from)} and ${formatTime(hour, to)}`;
  }
  if (hour.includes(",") && !/[-/]/.test(hour) && !SPECIAL.test(minute)) {
    const times = hour.split(",").map((value) => formatTime(value, minute));
    const last = times.pop();
    return `At ${times.join(", ")} and ${last}`;
  }
  const minutes = describeField(minute, {
    all: "every minute",
    single: (value) => value,
    increment: () => "every %s minutes",
    range: "minutes %s through %s past the hour",
    describe: (value) =>
      value !== "0"
        ? "at %s minutes past the hour"
        : hour.includes("/")
          ? "on the hour"
          : "every hour",
  });
  // A range's last hour runs to :59 unless the minute is 0.
  const rangeEnds: string[] = [];
  let index = 0;
  for (const item of hour.split("/")[0].split(",")) {
    const ends = item.split("-");
    if (ends.length === 2) rangeEnds[index + 1] = ends[1];
    index += ends.length;
  }
  let evaluation = 0;
  const hours = describeField(hour, {
    all: "every hour",
    single: (value) =>
      formatTime(
        value,
        rangeEnds[evaluation++] === value && minute !== "0" ? "59" : "0",
      ),
    increment: () => "every %s hours",
    range: "between %s and %s",
    describe: () => "at %s",
  });
  if (minutes === hours) return minutes;
  return minutes && hours ? `${minutes}, ${hours}` : minutes + hours;
}

function describeDayOfMonth(dayOfMonth: string, dayOfWeek: string): string {
  if (dayOfMonth === "L") return ", on the last day of the month";
  if (dayOfMonth === "*" && dayOfWeek !== "*") return "";
  return describeField(dayOfMonth, {
    all: ", every day",
    single: (value) => (value === "L" ? "the last day" : value),
    increment: (value) =>
      value === "1" ? ", every day" : ", every %s days in a month",
    range: ", between day %s and %s of the month",
    describe: () => ", on day %s of the month",
  });
}

function describeDayOfWeek(dayOfWeek: string, dayOfMonth: string): string {
  if (dayOfWeek === "*") return "";
  return describeField(dayOfWeek, {
    all: ", every day",
    single: (value) => {
      const hash = value.indexOf("#");
      const day = hash > -1 ? value.slice(0, hash) : value.replace("L", "");
      const name = WEEKDAYS[parseInt(day, 10)];
      // cronstrue writes "null" for an ordinal it doesn't know, such as #01.
      if (hash === -1) return name;
      return `${ORDINALS[value.slice(hash + 1)] ?? "null"} ${name}`;
    },
    increment: (value) =>
      parseInt(value, 10) === 1 ? "" : ", every %s days of the week",
    range: ", %s through %s",
    describe: (value) =>
      value.includes("#")
        ? ", on the %s of the month"
        : value.includes("L")
          ? ", on the last %s of the month"
          : dayOfMonth === "*"
            ? ", only on %s"
            : ", and on %s",
  });
}

function describeMonth(month: string): string {
  return describeField(month, {
    all: "",
    single: (value) => MONTHS[parseInt(value, 10) - 1],
    increment: (value) =>
      parseInt(value, 10) === 1 ? "" : ", every %s months",
    range: ", %s through %s",
    describe: () => ", only in %s",
  });
}

/** English for a 5-field cron, like "At 09:00 AM, Monday through Friday". */
export function describeCron(cron: string): string {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parseFields(cron);
  const text = [
    describeTimeOfDay(minute, hour),
    describeDayOfMonth(dayOfMonth, dayOfWeek),
    describeDayOfWeek(dayOfWeek, dayOfMonth),
    describeMonth(month),
  ]
    .join("")
    .replace(/, every minute/g, "")
    .replace(/, every hour/g, "")
    .replace(/, every day/g, "")
    .replace(/, ?$/, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
