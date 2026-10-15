-- Triggerfunktionen nicht per REST aufrufbar; is_admin nur für angemeldete Nutzer (RLS).
revoke execute on function public.chain_audit(), public.check_signup_domain(), public.handle_new_user(), public.guard_deal() from public, anon, authenticated;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
