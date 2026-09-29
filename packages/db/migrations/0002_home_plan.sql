-- Pro features (exports, import, full stats) follow the plan of the home's owner.
-- Members cannot read the owner's users row, so expose just the plan, and only to members.
CREATE FUNCTION app.home_plan(h uuid) RETURNS plan
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT u.plan FROM homes ho JOIN users u ON u.id = ho.owner_id
  WHERE ho.id = h AND app.is_member(h)
$$;
REVOKE ALL ON FUNCTION app.home_plan(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_plan(uuid) TO app_user;
