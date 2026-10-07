# Google Cloud setup (Google sign-in + Calendar API)

How to create the Google Cloud project this app signs in with. Checked against Google's
documentation in October 2026; the console moved its OAuth settings to **Google Auth Platform**
in 2025, so older tutorials that mention "APIs & Services > OAuth consent screen" are out of date.

You need a Google account (your Gmail is fine). Nothing here costs money.

## 1. Create the project

1. Open <https://console.cloud.google.com/>.
2. Click the project picker at the top, then **New project**.
3. Name it `Calendar Aggregator`, leave the organisation as "No organisation", click **Create**.
4. Make sure the new project is selected in the project picker before continuing.

## 2. Turn on the Google Calendar API

1. Menu > **APIs & Services** > **Library**.
2. Search for **Google Calendar API**, open it, click **Enable**.

Sign-in itself (OpenID Connect) needs no API to be enabled.

## 3. Branding (the consent screen's identity)

1. Menu > **Google Auth Platform** > **Branding** (the first time, click **Get started**).
2. **App information:** App name `Calendar Aggregator`; User support email: your Gmail.
3. **Audience:** choose **External** (Internal is only for Google Workspace organisations).
4. **Contact information:** your Gmail.
5. Agree to the Google API Services User Data Policy, then **Create**.

Home page, privacy policy and authorised domains can stay empty while the app is in Testing.
They're needed only to submit the app for Google's verification, which this project doesn't do
(see "Why Testing mode" below).

## 4. Audience: stay in Testing, add yourself as a test user

1. Google Auth Platform > **Audience**.
2. **Publishing status** must say **Testing**. Don't click "Publish app".
3. Under **Test users**, click **Add users**, enter your Gmail address, and **Save**.

Only listed test users can sign in (up to 100). Anyone else gets "Access blocked".

## 5. Data access: the scopes

1. Google Auth Platform > **Data Access** > **Add or remove scopes**.
2. Tick these, or paste them into **Manually add scopes** at the bottom of the panel:

   | Scope | What Google shows the user | Why the app needs it | Google's class |
   |---|---|---|---|
   | `openid` | Associate you with your personal info on Google | Sign-in: an ID token proving who you are | non-sensitive |
   | `https://www.googleapis.com/auth/userinfo.email` | See your primary Google Account email address | Your account email | non-sensitive |
   | `https://www.googleapis.com/auth/userinfo.profile` | See your personal info | Your name, shown on your booking page | non-sensitive |
   | `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | See the list of Google calendars you're subscribed to | So you can choose which calendars count as busy | non-sensitive |
   | `https://www.googleapis.com/auth/calendar.events.freebusy` | See the availability on Google calendars you have access to | Busy times only (`freebusy.query`), including calendars shared with you; never titles, attendees or descriptions | non-sensitive |
   | `https://www.googleapis.com/auth/calendar.events.owned` | See, create, change, and delete events on Google calendars you own | Create the booking's event (Google emails the guest the invite) and delete it on cancel | **sensitive** |

3. Click **Update**, then **Save**.

Why these and not the broad ones: `calendar.readonly` would let the app read every event's
details, and `calendar.events` would let it edit events on every calendar the user can access.
The app needs neither. `calendar.events.owned` only reaches calendars the user owns, which is
also where a booking's event belongs. `calendar.app.created` would be narrower still, but it only
covers secondary calendars the app creates itself, so bookings wouldn't land on the host's own
calendar.

## 6. Create the OAuth client

1. Google Auth Platform > **Clients** > **Create client**.
2. Application type: **Web application**. Name: `Calendar Aggregator web`.
3. **Authorised JavaScript origins:** leave empty. The browser never talks to Google's token
   endpoint; the server does.
4. **Authorised redirect URIs:** add

   ```
   http://localhost:5190/api/auth/google/callback
   ```

   It's the client's port (5190), not the API's (4200): sign-in starts on the app's own origin
   through the Vite proxy, and must come back to the same origin so the browser sends back the
   short-lived sign-in cookie and receives the session cookie there. Google allows plain `http`
   only for localhost.

   For the live site, add this one too (exactly, with `https` and no trailing slash):

   ```
   https://calendar-aggregator-app.vercel.app/api/auth/google/callback
   ```

   It's `<APP_ORIGIN>/api/auth/google/callback`, with `APP_ORIGIN` as set on Vercel. If the site
   ever moves to another domain, add that domain's URI the same way and update `APP_ORIGIN`.
5. Click **Create**.
6. **The client secret is shown only now.** Since mid-2025 Google masks it afterwards (only the
   last few characters stay visible). Click **Download JSON** or copy both values straight into
   `server/.env` (next step). If you lose it, open the client and **Add secret**, then delete the
   old one.

## 7. Put the values in `server/.env` (never in git, never in chat)

`server/.env` is gitignored. Add:

```
GOOGLE_CLIENT_ID="....apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="..."
APP_ORIGIN="http://localhost:5190"
```

and two random secrets of your own (generate each with the command below, run once per value):

```
COOKIE_SIGNING_SECRET="..."
TOKEN_ENCRYPTION_KEYS="1:..."
```

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

- `COOKIE_SIGNING_SECRET` signs the short-lived cookie that carries `state` and the PKCE verifier
  between "start" and "callback", so it can't be forged.
- `TOKEN_ENCRYPTION_KEYS` encrypts refresh tokens in the database (AES-256-GCM). The `1:` is the
  key's version, stored next to each encrypted token, so the key can be rotated later: put a new
  key first (`2:new,1:old`); new tokens use version 2, old ones still decrypt with version 1.

If you downloaded the JSON file, delete it once the values are in `.env` (or keep it in a password
manager, not in Downloads).

## 8. Try it

Start the API and the client, open <http://localhost:5190>, click **Sign in with Google** and pick
your Gmail account. Expect a "Google hasn't verified this app" screen: that's normal for an
unverified app in Testing. Click **Continue** (only test users get this option). Then Google's
consent screen lists the permissions above, each with its own tick box.

## Why Testing mode, and what it means

- **Up to 100 test users**, listed by email; nobody else can sign in.
- **Refresh tokens expire after 7 days.** Google's rule: an External app in Testing gets refresh
  tokens that expire in 7 days unless it asks only for name, email and profile. This app also asks
  for Calendar scopes, so after a week the connection shows "Reconnect Google" (phase 4 handles
  this as `invalid_grant`).
- **"Google hasn't verified this app"** is shown before the consent screen.
- Publishing to production with a sensitive scope (`calendar.events.owned`) requires Google's
  verification: a privacy policy and home page on a domain you own, and a review. That's out of
  scope for a portfolio project, which is why recruiters use the demo instead (see
  docs/PLAN.md, "Why the demo can't use real Google sign-in").

## Sources

- [Using OAuth 2.0 to access Google APIs](https://developers.google.com/identity/protocols/oauth2) (refresh token expiry in Testing)
- [Manage app audience](https://support.google.com/cloud/answer/15549945) (Testing: up to 100 test users)
- [Configure the OAuth consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent)
- [Google Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth) (scope classes)
- [OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server) (redirect URI rules, refresh tokens, revocation)
- [Usability and safety updates to Google Auth Platform](https://developers.googleblog.com/en/usability-and-safety-updates-to-google-auth-platform/) (client secrets shown once)
- [Google's OpenID configuration](https://accounts.google.com/.well-known/openid-configuration) (endpoints, PKCE `S256` support)
