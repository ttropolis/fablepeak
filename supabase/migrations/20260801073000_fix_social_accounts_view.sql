-- The token table has RLS enabled with no browser-facing policies. An
-- invoker-security view therefore cannot read it and the UI sees no connected
-- accounts. Run this token-free projection as the privileged view owner while
-- retaining the authenticated membership predicate as its authorization gate.
alter view public.social_accounts_public
  set (security_invoker = false, security_barrier = true);
