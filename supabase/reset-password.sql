-- Card Tracker: set a new password for an account-name account.
--
-- What it does: gives one account that signs in with a name and a password
-- (DESIGN.md section 8) a new password, for when its owner forgot it. Those
-- accounts live at a placeholder @family.invalid address, and .invalid is
-- reserved (RFC 2606), so no reset email can ever reach them.
--
-- Where to run it: Supabase dashboard, SQL Editor, New query. Paste this,
-- replace both placeholders, and click Run. Never save the file with a real
-- password in it: the repository is public.
--
--   <name>          the account name, as typed at sign-in (e.g. member.a)
--   <new password>  a temporary password, at least 8 characters
--
-- The result lists the account it changed. No rows means no account has that
-- name: check the spelling in Authentication, Users.
--
-- Afterwards, tell the person the temporary password and ask them to change
-- it in Profile, Change password, right after signing in.

update auth.users
set encrypted_password = extensions.crypt('<new password>', extensions.gen_salt('bf')),
	updated_at = now()
where email = lower('<name>') || '@family.invalid'
returning email, updated_at;
