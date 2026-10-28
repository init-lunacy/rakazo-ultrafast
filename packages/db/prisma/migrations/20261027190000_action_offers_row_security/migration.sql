-- Row-level security for action cards, in the shape of
-- 20261022120000_row_level_security_tenant_tables: a *_tenant policy for the Space
-- set by the app and a *_system policy for the explicit cross-tenant bypass.
--
-- The previous release reads action cards only inside its own Space or as system,
-- so it keeps working beside this one without a *_previous_release policy. The
-- card's user stays a filter in the queries, as it is for runs and bots.

ALTER TABLE "action_offers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY action_offers_tenant ON "action_offers"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY action_offers_system ON "action_offers"
  USING (current_setting('app.rls_bypass', true) = 'on');
