-- Admins dürfen auch bei Vorgängen von Kollegen Unterschriften speichern
-- (z. B. Dennis unterschreibt auf seinem iPad einen Vertrag, den ein Verkäufer am PC vorbereitet hat).
alter policy signatures_insert on public.signatures
  with check (exists (select 1 from public.deals d where d.id = signatures.deal_id and (d.seller_id = auth.uid() or public.is_admin())));
