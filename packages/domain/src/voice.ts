/**
 * Voice rebuys: understand a transcribed sentence like «علی ۲۰۰ ری‌بای», "Ali 200 rebuy",
 * "recave de 50 pour Marc" or "Ивану ребай двести" in any of the seven languages.
 *
 * Pure text in, structured request out; the bot turns it into a normal rebuy request that
 * the host confirms with a tap. Nothing here guesses silently: a sentence without a rebuy
 * word is ignored, and an unknown or ambiguous name is reported back.
 */

export interface VoicePlayer {
  id: string;
  name: string;
}

export interface VoiceAmount {
  value: number;
  /**
   * true when the speaker said the size ("200 thousand", "200k"): value is in money units.
   * false for a bare number ("200"): value is in the home's display units, like a typed amount.
   */
  absolute: boolean;
}

export type VoiceRebuy =
  | { ok: true; playerId: string; name: string; amount: VoiceAmount | null }
  | { ok: false; reason: "no_keyword" | "no_player" | "ambiguous"; candidates?: string[] };

// ---------------------------------------------------------------- normalizing

/** Lower case, Latin digits, no diacritics, one form for look-alike Persian/Arabic letters. */
export function normalizeSpeech(s: string): string {
  return (
    s
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/(\d)٬(?=\d)/g, "$1")
      .replace(/(\d)٫(?=\d)/g, "$1.")
      .toLocaleLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/ي|ى/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/ة/g, "ه")
      .replace(/ё/g, "е")
      // Zero-width joiners and tatweel: «ری‌بای» and «ریبای» are the same word.
      .replace(/[\u200c\u200d\u0640]/g, "")
      .replace(/(\d),(\d{3})(?!\d)/g, "$1$2")
      .replace(/(\d),(\d)/g, "$1.$2")
      .replace(/[^\p{L}\p{N}.]+/gu, " ")
      .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// ---------------------------------------------------------------- vocabulary

/** Rebuy words in the seven languages (normalized; several words each). */
const KEYWORDS = [
  // fa / ar
  "ریبای",
  "ری بای",
  "ری بی",
  "خرید مجدد",
  "خرید دوباره",
  "شارژ",
  "اعاده شراء",
  "اعاده الشراء",
  "شراء جدید",
  // en
  "rebuy",
  "re buy",
  "rebuys",
  "rebought",
  "top up",
  "topup",
  "reload",
  // fr
  "recave",
  "recaver",
  "rachat",
  "racheter",
  // it
  "ricarica",
  "ricaricare",
  "riacquisto",
  "ricompra",
  // es
  "recompra",
  "recomprar",
  "recarga",
  // ru
  "ребай",
  "ребаи",
  "докупка",
  "докупить",
  "докуп",
].map(normalizeSpeech);

type NumWord = { v: number } | { mul: 100 } | { big: 1000 | 1_000_000 };

const w = (v: number, ...words: string[]) => words.map((x) => [x, { v }] as const);
const NUMBER_WORDS = new Map<string, NumWord>(
  [
    // fa
    ...w(1, "یک", "یه"),
    ...w(2, "دو"),
    ...w(3, "سه"),
    ...w(4, "چهار"),
    ...w(5, "پنج"),
    ...w(6, "شش", "شیش"),
    ...w(7, "هفت"),
    ...w(8, "هشت"),
    ...w(9, "نه"),
    ...w(10, "ده"),
    ...w(20, "بیست"),
    ...w(30, "سی"),
    ...w(40, "چهل"),
    ...w(50, "پنجاه"),
    ...w(60, "شصت"),
    ...w(70, "هفتاد"),
    ...w(80, "هشتاد"),
    ...w(90, "نود"),
    ...w(100, "صد", "یکصد"),
    ...w(200, "دویست"),
    ...w(300, "سیصد"),
    ...w(400, "چهارصد"),
    ...w(500, "پانصد", "پونصد"),
    ...w(600, "ششصد"),
    ...w(700, "هفتصد"),
    ...w(800, "هشتصد"),
    ...w(900, "نهصد"),
    // ar
    ...w(1, "واحد"),
    ...w(2, "اثنان", "اثنین"),
    ...w(3, "ثلاث", "ثلاثه"),
    ...w(4, "اربع", "اربعه"),
    ...w(5, "خمس", "خمسه"),
    ...w(10, "عشر", "عشره"),
    ...w(20, "عشرون", "عشرین"),
    ...w(50, "خمسون", "خمسین"),
    ...w(100, "مئه", "مائه", "میه"),
    ...w(200, "مئتان", "مئتین", "میتین"),
    ...w(300, "ثلاثمئه", "ثلاثمائه"),
    ...w(500, "خمسمئه", "خمسمائه"),
    // en
    ...w(1, "one"),
    ...w(2, "two"),
    ...w(3, "three"),
    ...w(4, "four"),
    ...w(5, "five"),
    ...w(6, "six"),
    ...w(7, "seven"),
    ...w(8, "eight"),
    ...w(9, "nine"),
    ...w(10, "ten"),
    ...w(20, "twenty"),
    ...w(30, "thirty"),
    ...w(40, "forty"),
    ...w(50, "fifty"),
    ...w(60, "sixty"),
    ...w(70, "seventy"),
    ...w(80, "eighty"),
    ...w(90, "ninety"),
    // fr
    ...w(1, "un", "une"),
    ...w(2, "deux"),
    ...w(3, "trois"),
    ...w(4, "quatre"),
    ...w(5, "cinq"),
    ...w(10, "dix"),
    ...w(20, "vingt"),
    ...w(30, "trente"),
    ...w(40, "quarante"),
    ...w(50, "cinquante"),
    ...w(60, "soixante"),
    // it
    ...w(1, "uno", "una"),
    ...w(2, "due"),
    ...w(3, "tre"),
    ...w(5, "cinque"),
    ...w(10, "dieci"),
    ...w(20, "venti"),
    ...w(50, "cinquanta"),
    ...w(200, "duecento"),
    ...w(300, "trecento"),
    ...w(500, "cinquecento"),
    // es
    ...w(2, "dos"),
    ...w(3, "tres"),
    ...w(5, "cinco"),
    ...w(10, "diez"),
    ...w(20, "veinte"),
    ...w(50, "cincuenta"),
    ...w(100, "cien", "ciento"),
    ...w(200, "doscientos"),
    ...w(300, "trescientos"),
    ...w(500, "quinientos"),
    // ru
    ...w(1, "один", "одна"),
    ...w(2, "два", "две"),
    ...w(3, "три"),
    ...w(5, "пять"),
    ...w(10, "десять"),
    ...w(20, "двадцать"),
    ...w(50, "пятьдесят"),
    ...w(100, "сто"),
    ...w(200, "двести"),
    ...w(300, "триста"),
    ...w(500, "пятьсот"),
    ["hundred", { mul: 100 }] as const,
    ["hundreds", { mul: 100 }] as const,
    ["cent", { mul: 100 }] as const,
    ["cents", { mul: 100 }] as const,
    ["cento", { mul: 100 }] as const,
    ...["هزار", "الف", "الاف", "thousand", "thousands", "mille", "mila", "mil", "тысяча", "тысячи", "тысяч", "тыс", "k"].map(
      (x) => [x, { big: 1000 }] as const,
    ),
    ...[
      "میلیون",
      "ملیون",
      "million",
      "millions",
      "milione",
      "milioni",
      "millon",
      "millones",
      "миллион",
      "миллиона",
      "миллионов",
      "m",
      "mln",
    ].map((x) => [x, { big: 1_000_000 }] as const),
  ].map(([k, v]) => [normalizeSpeech(k), v as NumWord] as const),
);

const CONNECTORS = new Set(["و", "and", "et", "e", "y", "и"]);

/** Words that are never a name: filler around the request in the seven languages. */
const FILLER = new Set(
  [
    "برای", "واسه", "واسه ی", "به", "از", "یک", "لطفا", "میخواد", "میخواهد", "بده", "بزن", "کن", "تومن", "تومان", "ریال",
    "ل", "لـ", "من", "الی", "من فضلک", "یرید", "دینار", "درهم", "ریال",
    "for", "to", "please", "a", "an", "of", "wants", "the", "more", "another",
    "pour", "de", "des", "du", "une", "encore", "sil", "vous", "plait",
    "per", "di", "un", "altro", "altra", "vuole",
    "para", "de", "otra", "otro", "quiere", "por", "favor",
    "для", "на", "еще", "ещё", "пожалуйста", "хочет",
    "euro", "euros", "dollar", "dollars", "rubles", "рублей", "руб",
  ].map(normalizeSpeech),
);

// ---------------------------------------------------------------- amount

interface Parsed {
  amount: VoiceAmount | null;
  rest: string[];
}

function numberToken(t: string): { value: number; big?: number } | null {
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(t);
  if (!m) return null;
  return { value: Number(m[1]), big: m[2] === "k" ? 1000 : m[2] === "m" ? 1_000_000 : undefined };
}

/** Arabic and Persian glue "and" onto the next word: «وخمسین». */
function wordValue(t: string): NumWord | undefined {
  return NUMBER_WORDS.get(t) ?? (t.length > 2 && t.startsWith("و") ? NUMBER_WORDS.get(t.slice(1)) : undefined);
}

/** Take the first run of number tokens out of the words. */
function takeAmount(tokens: string[]): Parsed {
  let total = 0;
  let current = 0;
  let absolute = false;
  let start = -1;
  let end = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const n = numberToken(t);
    const word = n ? undefined : wordValue(t);
    const inRun = start >= 0;
    if (n) {
      current += n.value;
      if (n.big) {
        total += current * n.big;
        current = 0;
        absolute = true;
      }
    } else if (word && "v" in word) {
      // "یک" alone right after a name is the article "a", handled below.
      current += word.v;
    } else if (word && "mul" in word) {
      current = (current || 1) * word.mul;
    } else if (word && "big" in word && (inRun || t.length > 1)) {
      total += (current || 1) * word.big;
      current = 0;
      absolute = true;
    } else if (inRun && CONNECTORS.has(t) && i + 1 < tokens.length && (numberToken(tokens[i + 1]!) || wordValue(tokens[i + 1]!))) {
      continue;
    } else {
      if (inRun) break;
      continue;
    }
    if (start < 0) start = i;
    end = i;
  }
  if (start < 0) return { amount: null, rest: tokens };
  const rest = [...tokens.slice(0, start), ...tokens.slice(end + 1)];
  const value = total + current;
  // "Ali one rebuy": a lone "one" counts rebuys, it is not an amount.
  if (!absolute && value === 1) return { amount: null, rest };
  if (!(value > 0) || !Number.isFinite(value)) return { amount: null, rest };
  return { amount: { value: absolute ? Math.round(value) : value, absolute }, rest };
}

// ---------------------------------------------------------------- names

const TRANSLIT: Record<string, string> = {
  ا: "a", آ: "a", ء: "", ب: "b", پ: "p", ت: "t", ث: "s", ج: "j", چ: "ch", ح: "h", خ: "kh", د: "d", ذ: "z", ر: "r",
  ز: "z", ژ: "zh", س: "s", ش: "sh", ص: "s", ض: "z", ط: "t", ظ: "z", ع: "", غ: "gh", ف: "f", ق: "gh", ک: "k", گ: "g",
  ل: "l", م: "m", ن: "n", و: "o", ه: "h", ی: "i",
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "sh", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};

/** A rough Latin spelling, so «علی», "Ali" and «Али» can be compared. */
export function latinize(s: string): string {
  return [...s]
    .map((c) => TRANSLIT[c] ?? c)
    .join("")
    .replace(/q/g, "gh")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/w/g, "v")
    .replace(/ou|oo|uo/g, "u")
    .replace(/ee/g, "i")
    .replace(/(.)\1+/g, "$1");
}

/** Consonants only: Persian and Arabic usually do not write short vowels. */
const skeleton = (latin: string) => latin.replace(/[aeiouy]/g, "");

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/** Distance between something said and a name; Infinity when they are clearly different. */
function nameDistance(said: string, name: string): number {
  if (said === name) return 0;
  const a = latinize(said);
  const b = latinize(name);
  if (a === b) return 0.25;
  const d = levenshtein(a, b);
  const allowed = Math.max(1, Math.floor(Math.min(a.length, b.length) / 4));
  const sa = skeleton(a);
  const sb = skeleton(b);
  if (sa.length >= 2 && sa === sb) return Math.min(d, 1);
  // Short names ("Ali") need their consonants to agree too.
  if (d <= allowed && (Math.min(a.length, b.length) > 4 || levenshtein(sa, sb) <= (sa.length >= 3 ? 1 : 0))) return d;
  return Number.POSITIVE_INFINITY;
}

/** Candidate spans: every word, a word without an Arabic prefix («لعلی»), and word pairs. */
function spans(tokens: string[]): string[] {
  const out: string[] = [];
  tokens.forEach((t, i) => {
    out.push(t);
    if (/^[لوب]\p{L}{2,}/u.test(t)) out.push(t.slice(1));
    if (i + 1 < tokens.length) out.push(`${t} ${tokens[i + 1]}`);
  });
  return out;
}

function matchPlayer(tokens: string[], players: readonly VoicePlayer[]) {
  const candidates = spans(tokens.filter((t) => t.length >= 2 && !FILLER.has(t)));
  const scored = players.map((p) => {
    const full = normalizeSpeech(p.name);
    const parts = full.split(" ");
    let best = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      best = Math.min(best, nameDistance(c, full));
      // First name only for a two-word name, with a small penalty.
      if (parts.length > 1) for (const part of parts) if (part.length >= 3) best = Math.min(best, nameDistance(c, part) + 0.5);
    }
    return { p, d: best };
  });
  const found = scored.filter((s) => Number.isFinite(s.d)).sort((x, y) => x.d - y.d);
  if (!found.length) return { reason: "no_player" as const };
  if (found.length > 1 && found[1]!.d - found[0]!.d < 0.5) {
    return { reason: "ambiguous" as const, candidates: found.filter((f) => f.d - found[0]!.d < 0.5).map((f) => f.p.name) };
  }
  return { player: found[0]!.p };
}

// ---------------------------------------------------------------- entry point

export function parseVoiceRebuy(text: string, players: readonly VoicePlayer[]): VoiceRebuy {
  let s = ` ${normalizeSpeech(text)} `;
  let found = false;
  // Longest words first, so «ری بای» is taken whole before «ری».
  for (const k of [...KEYWORDS].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<=\\s)${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s)`, "gu");
    if (re.test(s)) {
      found = true;
      s = s.replace(re, " | ");
    }
  }
  if (!found) return { ok: false, reason: "no_keyword" };
  const tokens = s.split(" ").filter((t) => t && t !== "|");
  const { amount, rest } = takeAmount(tokens);
  const m = matchPlayer(rest, players);
  if (!("player" in m)) return { ok: false, reason: m.reason, candidates: m.candidates };
  return { ok: true, playerId: m.player!.id, name: m.player!.name, amount };
}

/** The stored amount for a parsed request in a home (display units × divisor, like typing it). */
export function voiceAmountToMoney(a: VoiceAmount, divisor: number): number | null {
  const v = Math.round(a.absolute ? a.value : a.value * divisor);
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}
