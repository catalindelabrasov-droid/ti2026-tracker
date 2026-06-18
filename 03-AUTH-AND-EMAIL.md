# 03 — Auth + Email Backend

Goal: turn the sign-up / sign-in UI from "local only" into real accounts with
secure passwords and confirmation emails.

## Why a backend is required

The current sign-in accepts any input and stores a local session in
`localStorage`. There's no real account check, no password storage, and no email
is sent — a static page can't do any of that safely. You need a service that:

- stores users and **hashes passwords** (never store plaintext),
- sends the **confirmation email** with a tokenized link,
- verifies that token and marks the account confirmed,
- issues a **session** the browser can keep.

Don't try to do password checking in browser JavaScript — anything in
`index.html` is visible to everyone and provides no security.

## Recommended: Supabase Auth (handles all of the above)

Supabase gives you hosted Postgres + Auth + transactional email with very little
code, and its free tier is plenty for a friends group.

### Steps

1. Create a project at supabase.com. Note the **Project URL** and **anon public
   key** (safe to use in the browser).
2. **Email confirmations**: Auth → Providers → Email → enable "Confirm email."
   Supabase sends a confirmation link automatically on sign-up.
3. **Use your template**: Auth → Email Templates → "Confirm signup." Paste the
   HTML from `email_confirmation_template.html` and map the placeholders:
   - `{{confirm_url}}` → Supabase's `{{ .ConfirmationURL }}`
   - `{{name}}` / `{{username}}` → from user metadata (see below)
   - set the redirect so the link returns to your site at `?confirmed=1`
     (the app already detects `?confirmed=1` and opens Sign in — see
     `handleConfirmationLanding()` in `index.html`).
4. Add the Supabase JS client to `index.html` (one `<script>` from their CDN),
   initialized with your URL + anon key.

### Front-end wiring (what to replace)

In `index.html`, the auth lives in `wireAuth()` with `validateSignup()` /
`validateSignin()`. The validation stays; only the **submit handlers** change.

Sign-up (replace the local-store stub):
```js
// after validateSignup() returns clean data:
const { error } = await supabase.auth.signUp({
  email: data.email,
  password: pw,                 // the password field value
  options: { data: { username: data.username, name: data.name,
                     phone: data.phone } }
});
if (error) { /* show error in #signupOk */ }
else { showCheckEmail(data.email); }   // existing "check your inbox" UI
```

Sign-in (replace the accept-anything stub):
```js
const { data: s, error } = await supabase.auth.signInWithPassword({
  email: id.includes('@') ? id : /* look up email by username, see note */,
  password: pw
});
if (error) { /* show error */ }
else {
  localStorage.setItem('ti2026_user', JSON.stringify({
    username: s.user.user_metadata.username,
    email: s.user.email, name: s.user.user_metadata.name
  }));
  renderAuthArea(); closeModals();
}
```

> **Username login note:** Supabase signs in by email. To allow username *or*
> email in the one box, either (a) store a `profiles` table mapping
> username→email and look it up first, or (b) require email in that box. The UI
> already says "Username or email," so option (a) is the nicer finish.

Sign-out: `await supabase.auth.signOut()` then clear `ti2026_user`.

Session restore on load: call `supabase.auth.getUser()` in `init()` and populate
`ti2026_user` so refreshes stay logged in.

## The confirmation email

`email_confirmation_template.html` is ready to use — standard table-based HTML,
inline styles, on-brand. Placeholders: `{{name}}`, `{{username}}`,
`{{confirm_url}}`, `{{expiry_hours}}`, `{{support_email}}`, `{{site_url}}`.
Whatever provider you use just needs to fill these and send. The link should
return users to `https://your-site/?confirmed=1`.

## Alternatives

- **Firebase Auth** — similar capability; `createUserWithEmailAndPassword`,
  `sendEmailVerification`. Good if you prefer Google's stack.
- **Auth0 / Clerk** — more features (social login, MFA), heavier.
- **Custom (Node/Express + Postgres + nodemailer)** — full control, more work:
  you implement hashing (bcrypt/argon2), token generation, an email send via
  SMTP/SendGrid/Resend/Postmark, and JWT sessions.

## Security checklist

- Passwords hashed by the provider (bcrypt/argon2) — never stored or compared in
  the browser.
- The browser only holds the public anon key + a session token, never secrets.
- Use HTTPS (hosting step already gives you this).
- Rate-limit sign-up/sign-in (Supabase does this; custom backends must add it).
- The phone field: store it, but you don't need SMS unless you later add
  phone verification.

Next: [04-LEAGUE-BACKEND.md](04-LEAGUE-BACKEND.md).
