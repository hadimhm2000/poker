-- Debt confirmation: only the debtor themselves or the host may mark a debt paid.
-- Before, the CREDITOR (to_player) confirmed; the person who owes (from_player) could not.
-- The host keeps the right (is_owner), and "mark all as paid" stays host-only.

ALTER POLICY payments_mark ON debt_payments
  WITH CHECK (
    marked_by = app.current_user_id()
    AND (kind = 'paid' OR (kind = 'carried' AND app.can_write(app.game_home(carried_to_game))))
    AND EXISTS (
      SELECT 1 FROM settlements s JOIN players p ON p.id = s.from_player
      WHERE s.id = settlement_id
        AND (app.is_owner(p.home_id) OR p.user_id = app.current_user_id())
    )
  );
