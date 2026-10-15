// Export and permanent deletion of one hospital's data.
// The tables are found from the database itself (every table with a hospital_id column), so tables added later are
// included without changing this file. Rows are deleted children first, inside the caller's transaction.

// Every table that holds hospital data, in an order that is safe to delete (tables that point at others come first).
export async function hospitalTablesInDeleteOrder(client) {
  const tables = (await client.query(
    `SELECT c.table_name FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
     WHERE c.table_schema='public' AND c.column_name='hospital_id' AND c.table_name<>'super_admin_audit_logs'
     ORDER BY c.table_name`
  )).rows.map(r => r.table_name);
  const set = new Set(tables);

  // a table without hospital_id that still points at a hospital table would block the delete: stop and say so
  const fks = (await client.query(
    `SELECT con.conrelid::regclass::text AS child, con.confrelid::regclass::text AS parent
     FROM pg_constraint con WHERE con.contype='f' AND con.connamespace='public'::regnamespace`
  )).rows.map(r => ({ child: r.child.replace(/"/g, ''), parent: r.parent.replace(/"/g, '') }));
  const stray = fks.filter(f => set.has(f.parent) && !set.has(f.child) && !['super_admin_audit_logs', 'hospitals'].includes(f.child));
  if (stray.length) throw new Error(`Cannot delete: ${[...new Set(stray.map(s => s.child))].join(', ')} reference hospital tables but have no hospital_id`);

  const remaining = new Set(tables);
  const ordered = [];
  while (remaining.size) {
    const ready = [...remaining].filter(t => !fks.some(f => f.parent === t && f.child !== t && remaining.has(f.child)));
    if (!ready.length) throw new Error('Cannot work out a safe delete order (circular references)');
    for (const t of ready) { ordered.push(t); remaining.delete(t); }
  }
  return ordered;
}

// Everything the hospital owns, as plain JSON, for the backup file.
export async function exportHospital(client, hospitalId) {
  const hospital = (await client.query(`SELECT * FROM hospitals WHERE id=$1`, [hospitalId])).rows[0];
  if (!hospital) return null;
  const order = await hospitalTablesInDeleteOrder(client);
  const data = {};
  for (const table of order.slice().reverse()) {
    const rows = (await client.query(`SELECT * FROM "${table}" WHERE hospital_id=$1`, [hospitalId])).rows;
    if (rows.length) data[table] = rows;
  }
  // password hashes are not part of the backup
  if (data.users) data.users = data.users.map(({ password_hash, ...rest }) => rest);
  return { exportedAt: new Date().toISOString(), hospital, tables: data };
}

// Permanently removes the hospital and everything it owns. Returns how many rows each table lost.
export async function purgeHospital(client, hospitalId, { superuserId, reason }) {
  const hospital = (await client.query(`SELECT id,name FROM hospitals WHERE id=$1 FOR UPDATE`, [hospitalId])).rows[0];
  if (!hospital) return null;
  const counts = {};
  // earlier audit lines stay, but without the link to the rows that are about to disappear (the name is kept in the line)
  await client.query(
    `UPDATE super_admin_audit_logs SET metadata=metadata||jsonb_build_object('hospitalName',$2::text),hospital_id=NULL,target_user_id=NULL
     WHERE hospital_id=$1 OR target_user_id IN (SELECT id FROM users WHERE hospital_id=$1)`,
    [hospitalId, hospital.name]
  );
  for (const table of await hospitalTablesInDeleteOrder(client)) {
    const r = await client.query(`DELETE FROM "${table}" WHERE hospital_id=$1`, [hospitalId]);
    if (r.rowCount) counts[table] = r.rowCount;
  }
  await client.query(`DELETE FROM hospitals WHERE id=$1`, [hospitalId]);
  await client.query(
    `INSERT INTO super_admin_audit_logs(superuser_id,action,hospital_id,metadata) VALUES($1,'HOSPITAL_DELETED',NULL,$2)`,
    [superuserId, JSON.stringify({ hospitalId: Number(hospitalId), hospitalName: hospital.name, reason, deleted: counts })]
  );
  return { name: hospital.name, counts };
}
