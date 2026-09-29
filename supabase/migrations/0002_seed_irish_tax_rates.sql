-- Hand-written: Irish VAT rates as effective-dated data (valid_to is the inclusive last day).
-- Rows before 2024-01-01 are not seeded. Later rate changes are new migrations, never edits.
-- From 1 July 2026 restaurant/catering and hairdressing moved from 13.5% to 9%.
-- Alcohol, soft drinks and bottled water stay STANDARD; that is a product category, not a rate row.

create extension if not exists btree_gist with schema extensions;

-- One rate per (country, code) on any given day.
alter table public.tax_rates add constraint tax_rates_no_overlap
  exclude using gist (
    country with =,
    code with =,
    daterange(valid_from, valid_to, '[]') with &&
  );

insert into public.tax_rates (id, country, code, description, rate_bp, valid_from, valid_to) values
  (gen_random_uuid(), 'IE', 'STANDARD',        'Standard rate',                                   2300, '2024-01-01', null),
  (gen_random_uuid(), 'IE', 'REDUCED',         'Reduced rate',                                    1350, '2024-01-01', null),
  (gen_random_uuid(), 'IE', 'SECOND_REDUCED',  'Second reduced rate',                              900, '2024-01-01', null),
  (gen_random_uuid(), 'IE', 'LIVESTOCK',       'Livestock rate',                                   480, '2024-01-01', null),
  (gen_random_uuid(), 'IE', 'ZERO',            'Zero rate (e.g. cold take-away food)',               0, '2024-01-01', null),
  (gen_random_uuid(), 'IE', 'CATERING',        'Restaurant and catering services',                1350, '2024-01-01', '2026-06-30'),
  (gen_random_uuid(), 'IE', 'CATERING',        'Restaurant and catering services',                 900, '2026-07-01', null),
  (gen_random_uuid(), 'IE', 'HAIRDRESSING',    'Hairdressing services',                           1350, '2024-01-01', '2026-06-30'),
  (gen_random_uuid(), 'IE', 'HAIRDRESSING',    'Hairdressing services',                            900, '2026-07-01', null);
