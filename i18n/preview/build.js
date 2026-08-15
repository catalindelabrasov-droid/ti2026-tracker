/* Build the standalone Russian preview: ru-preview.src.html + embedded fonts.
 *
 * Run: node i18n/preview/build.js
 * Writes: i18n/preview/ru-preview.html  (~390 KB, opens with no network)
 *
 * WHY THE FONTS ARE EMBEDDED
 *
 * The preview has to be judgeable on its own — sent, opened offline, viewed in
 * a sandbox that blocks external hosts. More importantly, the site itself only
 * self-hosts the *latin* and *latin-ext* subsets of its three faces. There is
 * no Cyrillic in them, so a Russian page served by the real site today would
 * silently fall back to the system font and look foreign on its own domain.
 * Embedding both subsets here is what makes the comparison honest: the English
 * column renders in exactly the face the live site uses, and the Russian column
 * renders in the face we would have to add.
 *
 * A first pass embedded only the Cyrillic subsets and dropped unicode-range.
 * That broke the English half — with no Latin face declared, it fell back to
 * system-ui and the two columns were no longer comparable. Both subsets, with
 * their real ranges, is the correct build.
 */
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const GF =
  "https://fonts.googleapis.com/css2" +
  "?family=Oswald:wght@500;600" +
  "&family=Inter:wght@400;600" +
  "&family=JetBrains+Mono:wght@400;500" +
  "&display=swap";

/* Google serves different files per browser; this UA gets woff2. */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const WANT = {
  Oswald: ["500", "600"],
  Inter: ["400", "600"],
  "JetBrains Mono": ["400", "500"],
};
const SUBSETS = new Set(["latin", "cyrillic"]);

(async () => {
  const css = await (await fetch(GF, { headers: { "user-agent": UA } })).text();
  const parts = css.split(/\/\*\s*([a-z-]+)\s*\*\//);

  const faces = [];
  const seen = new Set();
  let bytes = 0;

  for (let i = 1; i < parts.length; i += 2) {
    const subset = parts[i];
    const block = parts[i + 1];
    if (!SUBSETS.has(subset)) continue;

    const fam = /font-family:\s*'([^']+)'/.exec(block)[1];
    const wt = /font-weight:\s*(\d+)/.exec(block)[1];
    if (!WANT[fam] || !WANT[fam].includes(wt)) continue;

    const key = fam + wt + subset;
    if (seen.has(key)) continue;
    seen.add(key);

    const url = /url\((https:\/\/fonts\.gstatic\.com[^)]+\.woff2)\)/.exec(block)[1];
    const range = /unicode-range:\s*([^;}]+)/.exec(block);
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());

    if (buf.slice(0, 4).toString("latin1") !== "wOF2")
      throw new Error(`${fam} ${wt} ${subset} is not a woff2`);

    bytes += buf.length;
    faces.push(
      `@font-face{font-family:'${fam}';font-style:normal;font-weight:${wt};` +
        `font-display:swap;src:url(data:font/woff2;base64,${buf.toString("base64")}) ` +
        `format('woff2')` +
        (range ? `;unicode-range:${range[1].trim()}` : "") +
        `}`
    );
    console.log(`  ${fam} ${wt} ${subset} — ${Math.round(buf.length / 1024)} KB`);
  }

  const body = fs.readFileSync(path.join(HERE, "ru-preview.src.html"), "utf8");
  const nl = body.indexOf("\n"); // <title> must stay the first line
  const out =
    body.slice(0, nl + 1) + "<style>\n" + faces.join("\n") + "\n</style>\n" + body.slice(nl + 1);

  const dest = path.join(HERE, "ru-preview.html");
  fs.writeFileSync(dest, out);
  console.log(
    `\n${faces.length} faces, ${Math.round(bytes / 1024)} KB raw ` +
      `→ ru-preview.html (${Math.round(out.length / 1024)} KB)`
  );
})();
