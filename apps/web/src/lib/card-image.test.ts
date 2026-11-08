import { describe, expect, it } from "vitest";
import { type CardInput, cardSvg, renderCard } from "./card-image";

const input: CardInput = {
  rtl: true,
  brand: "Poker Home",
  homeName: "جمعه‌شب",
  title: "بازی ۱۲",
  date: "۸ مهر ۱۴۰۵",
  potLabel: "جمع پات",
  pot: "۳٬۲۰۰k",
  rows: Array.from({ length: 12 }, (_, i) => ({ name: i === 0 ? "<b>Hadi</b> & co" : `بازیکن ${i}`, amount: "+۱۰k", sign: 1 as const })),
  moreLabel: (n) => `و ${n} نفر دیگر`,
  verifyLabel: "برای تأیید اصالت اسکن کنید",
  verifyUrl: `https://poker.test/fa/verify/${"a".repeat(64)}`,
  hashShort: "aaaaaaaaaaaaaaaa",
};

const size = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];

describe("result card", () => {
  it("renders a post and a story PNG", () => {
    const post = renderCard(input, "post");
    expect(post.subarray(1, 4).toString()).toBe("PNG");
    expect(size(post)).toEqual([1080, 1350]);
    expect(size(renderCard({ ...input, rtl: false }, "story"))).toEqual([1080, 1920]);
  });

  it("escapes names and folds long lists into 'and N more'", () => {
    const svg = cardSvg(input, "post");
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;b&gt;Hadi&lt;/b&gt; &amp; co");
    // 8 rows fit a post: 7 names and "and 5 more" (12 rows in all).
    expect(svg).toContain("و 5 نفر دیگر");
    expect(svg).toContain('direction="rtl"');
  });
});
