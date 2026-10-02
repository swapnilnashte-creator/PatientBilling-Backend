export const DEFAULT_BILLING_ITEMS = [
  { name: 'General Consultation', defaultPrice: 500.00 },
  { name: 'Follow-up Consultation', defaultPrice: 300.00 },
  { name: 'Dressing', defaultPrice: 250.00 },
  { name: 'Injection', defaultPrice: 150.00 },
  { name: 'Minor Procedure', defaultPrice: 700.00 },
];

export async function ensureDefaultBillingItems(client, hospitalId, userId = null) {
  for (const item of DEFAULT_BILLING_ITEMS) {
    await client.query(
      `INSERT INTO billing_items(hospital_id,name,default_price,created_by,updated_by)
       VALUES($1,$2,$3,$4,$4)
       ON CONFLICT (hospital_id, name) DO NOTHING`,
      [hospitalId, item.name, item.defaultPrice, userId]
    );
  }
}
