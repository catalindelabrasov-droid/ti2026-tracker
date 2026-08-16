/* Russian social-card meta for /ru/.
 *
 * WHY THIS EXISTS
 *
 * /ru/ and / are the SAME document, localised in the browser by localize().
 * Social crawlers do not run JavaScript, so a link to /ru/ shared into Telegram
 * or VK unfurled with the English og:description and the English share image.
 * The card is the whole first impression in every channel the Russian audience
 * actually uses, so it is worth getting right.
 *
 * WHY NOT THE OBVIOUS ALTERNATIVES
 *
 * A second ru/index.html is what netlify.toml already argues against: "not a
 * second copy of index.html that would drift out of sync within a week."
 * Generating one at build time avoids the drift but makes /ru/ a real file,
 * which shadows the existing 200-rewrite and means touching redirects that
 * currently work. This adds a file instead of changing the flow.
 *
 * WHAT IT DOES NOT TOUCH
 *
 * "The International 2026" is a proper noun. Russian Dota media writes it in
 * Latin, and ru/strings.json already maps the phrase to itself rather than
 * translating it. Only the descriptive half of the title moves.
 *
 * FAILURE MODE, DELIBERATELY CHOSEN
 *
 * The response is cloned before it is read, and any throw returns that clone
 * untouched. The worst case is therefore the English card - exactly what was
 * being served before this file existed - never a broken page. /ru/ is a live
 * path with real readers on it; it must not be able to 500 because a regex
 * changed shape.
 */

const RU_TITLE = "The International 2026 — трекер результатов";
const RU_DESC =
  "Результаты матчей, турнирные сетки и фэнтези-лига прогнозов, " +
  "где вы соревнуетесь с друзьями. Бесплатно, без рекламы.";
const RU_IMAGE = "https://dota2tileague.com/og-image-ru.png";
const RU_ALT =
  "dota2tileague.com — The International 2026: результаты, турнирные сетки " +
  "и лига прогнозов с друзьями.";

/* Anchored on the exact attribute pair, so a tag that is absent is simply not
   rewritten rather than matching something else further down a 450 KB file. */
const SWAPS = [
  [/(<meta property="og:title" content=")[^"]*(">)/, RU_TITLE],
  [/(<meta property="og:description" content=")[^"]*(">)/, RU_DESC],
  [/(<meta property="og:image" content=")[^"]*(">)/, RU_IMAGE],
  [/(<meta property="og:image:alt" content=")[^"]*(">)/, RU_ALT],
  [/(<meta property="og:locale" content=")[^"]*(">)/, "ru_RU"],
  [/(<meta property="og:locale:alternate" content=")[^"]*(">)/, "en_US"],
  [/(<meta name="twitter:title" content=")[^"]*(">)/, RU_TITLE],
  [/(<meta name="twitter:description" content=")[^"]*(">)/, RU_DESC],
  [/(<meta name="twitter:image" content=")[^"]*(">)/, RU_IMAGE],
  [/(<meta name="twitter:image:alt" content=")[^"]*(">)/, RU_ALT],
];

/* Exported so a test can exercise the rewrite without standing up an edge
   runtime. The test must fail if this stops doing anything - see
   tools/test_ru_social_meta.js. */
export function ruMeta(html) {
  let out = html;
  for (const [re, value] of SWAPS) {
    out = out.replace(re, (_m, open, close) => open + value + close);
  }
  return out;
}

export default async (request, context) => {
  const res = await context.next();
  const safe = res.clone();
  try {
    const type = res.headers.get("content-type") || "";
    if (!type.includes("text/html")) return safe;

    const html = await res.text();
    const out = ruMeta(html);
    if (out === html) return safe;   // nothing to rewrite: hand back the original

    const headers = new Headers(res.headers);
    headers.delete("content-length");  // the body length changed
    return new Response(out, { status: res.status, statusText: res.statusText, headers });
  } catch (_e) {
    return safe;                      // English card beats a broken page
  }
};
