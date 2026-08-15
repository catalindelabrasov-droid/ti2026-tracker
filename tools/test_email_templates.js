/* Check the auth email templates against what Supabase actually substitutes.
 *
 * Run: node tools/test_email_templates.js       (no dependencies)
 *
 * WHY THIS EXISTS
 *
 * The original draft in the repo root used {{confirm_url}}, {{name}},
 * {{username}}, {{expiry_hours}} and {{support_email}}. Supabase Auth uses Go
 * template syntax and substitutes none of those — pasted as-is, the confirm
 * button points at the literal string "{{confirm_url}}" and nobody can activate
 * an account. Nothing in the file says which dialect it is written in, and a
 * broken auth email is invisible until a real person cannot sign up.
 *
 * So: every {{...}} in a template must be a variable Supabase really provides,
 * and the action link must be present.
 */
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "email-templates");

/* https://supabase.com/docs/guides/auth/auth-email-templates */
const SUPABASE_VARS = new Set([
  ".ConfirmationURL", ".Token", ".TokenHash", ".SiteURL", ".Email",
  ".NewEmail", ".RedirectTo", ".Data",
]);

let fail = 0;
const ok = (c, m, x) => { console.log((c ? "  ok   " : "  FAIL ") + m + (x ? "   " + x : "")); if (!c) fail++; };

/* A missing directory is a FAILURE, not "nothing to check". Renaming or
   moving email-templates/ turned this file into a no-op that reported
   success — the same skip-equals-pass shape as the jsdom guard. */
if (!fs.existsSync(DIR)) {
  console.error("email-templates/ is MISSING. This is a failure, not a skip —");
  console.error("the auth email templates are unverified and may be unshippable.");
  process.exit(1);
}
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".html") && !f.startsWith("DEPRECATED"));
ok(files.length > 0, `${files.length} template(s) found`);

for (const f of files) {
  const src = fs.readFileSync(path.join(DIR, f), "utf8");
  /* Ignore the comment block — it deliberately quotes the WRONG placeholders
     to warn against them. */
  const body = src.replace(/<!--[\s\S]*?-->/g, "");
  console.log(`\n${f}`);

  const vars = [...new Set([...body.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1].trim()))];
  const bad = vars.filter((v) => {
    const root = v.startsWith(".Data.") ? ".Data" : v;
    return !SUPABASE_VARS.has(root);
  });
  ok(!bad.length, "every {{...}} is a real Supabase variable",
     bad.length ? bad.map((b) => `{{ ${b} }}`).join(", ") : vars.join(", "));

  ok(/\{\{\s*\.ConfirmationURL\s*\}\}/.test(body), "carries the action link");
  ok(!/\{\{\s*(confirm_url|name|username|expiry_hours|support_email|site_url)\s*\}\}/.test(body),
     "none of the old non-Supabase placeholders survive");

  /* Bilingual is the whole point — a missing half is a silent regression. */
  ok(/[А-яЁё]/.test(body), "contains Russian");
  ok(/[A-Za-z]{4,}/.test(body), "contains English");
  const links = (body.match(/\{\{\s*\.ConfirmationURL\s*\}\}/g) || []).length;
  ok(links >= 2, "the link appears in both language blocks", `${links} occurrences`);

  /* Email clients strip <style>; everything must be inline. */
  ok(!/<style[\s>]/i.test(body), "no <style> block (email clients strip them)");
  ok(/<meta charset="UTF-8">/i.test(src), "declares UTF-8, or Cyrillic arrives as mojibake");

  let balanced = true;
  for (const t of ["html", "head", "body", "table", "tr", "td", "p", "h1", "div", "a"]) {
    const o = (body.match(new RegExp("<" + t + "[ >]", "g")) || []).length;
    const c = (body.match(new RegExp("</" + t + ">", "g")) || []).length;
    if (o !== c) { balanced = false; console.log(`         <${t}> ${o} open / ${c} close`); }
  }
  ok(balanced, "tags balanced");
}

console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nall checks pass");
process.exit(fail ? 1 : 0);
