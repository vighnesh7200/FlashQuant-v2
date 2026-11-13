# Cloud accounts: one-time Supabase setup

`config.js` already contains your project URL and publishable key. Do these four things in the Supabase dashboard.

## 1. Create the tables (SQL Editor, paste, Run)

```sql
create table rounds (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  ts bigint not null,
  data jsonb not null,
  primary key (user_id, id)
);

create table facts (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table rounds enable row level security;
alter table facts  enable row level security;

create policy "own rounds" on rounds for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own facts" on facts for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
```

Row-level security is what makes the publishable key safe to expose. Do not skip it.

## 2. Make the email contain a code

FlashQuant signs people in with a one-time code typed into the page (this works across devices).
Authentication > Email Templates. Edit BOTH "Magic Link" and "Confirm signup" and put this in the body:

```html
<h2>Your FlashQuant code</h2>
<p>Enter this code on the sign-in screen:</p>
<p style="font-size:28px;letter-spacing:4px"><b>{{ .Token }}</b></p>
<p>Or open this link on the same device: <a href="{{ .ConfirmationURL }}">Sign in</a></p>
```

## 3. Allow your site address

Authentication > URL Configuration: set Site URL to `https://flashquant.vercel.app` and add the same
address to Redirect URLs.

## 4. Email sending limits (important before real users)

Supabase's built-in email sender is for testing and allows only a few emails per hour across the whole project.
Before you share the site, set up your own SMTP provider (Resend, Brevo, Postmark, etc.) under
Project Settings > Authentication > SMTP Settings.

## Check it works

Sign in on your phone and your laptop with the same email. Play a round on one; press "Sync now" on the other.
