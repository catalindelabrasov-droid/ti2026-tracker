-- Drop rule keys that no longer exist in the UI or the scoring RPC, so
-- existing leagues stop carrying toggles that can never pay out. Anything
-- not in the keep-list is removed; missing keys fall back to the RPC's
-- documented defaults.
update leagues
set rules = (
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
  from jsonb_each(rules) as e(k, v)
  where k in (
    'winner','exactScore','gameCountOU','loneWolf','firstGame','reverseSweep',
    'champion','grandFinalists','topFour','topEight','champFromLB',
    'scoreMode','negativePoints','tbExactHits','tbChampion','lockLeadMs'
  )
)
where rules is not null and rules <> '{}'::jsonb;

-- 'odds' scoring mode was removed (no odds data exists); fall back to flat.
update leagues set rules = jsonb_set(rules, '{scoreMode}', '"flat"')
where rules ->> 'scoreMode' = 'odds';
