-- Pre-#197 web sign-in exposed these credentials in JSON; cookie expiry cannot revoke bearer access.
DELETE FROM account_sessions;
