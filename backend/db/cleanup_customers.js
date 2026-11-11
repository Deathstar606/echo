const { query, getPool } = require('./index');

async function cleanupCustomers() {
  const targetBusinessId = '684a8863-5094-4c8b-9b15-c50c06335b7f';
  console.log(`Starting customer cleanup. Setting all customers to business_id: ${targetBusinessId}...`);

  // Ensure target business exists
  const bizCheck = await query('SELECT id, name FROM businesses WHERE id = $1', [targetBusinessId]);
  if (bizCheck.rowCount === 0) {
    console.log(`Target business ${targetBusinessId} not found. Creating it...`);
    await query('INSERT INTO businesses (id, name) VALUES ($1, $2)', [targetBusinessId, 'Veloura Apparel']);
  } else {
    console.log(`Target business verified: ${bizCheck.rows[0].name} (${targetBusinessId})`);
  }

  // Update existing customers
  const updateResult = await query(
    `UPDATE customers SET business_id = $1 RETURNING id, customer_name, email, business_id;`,
    [targetBusinessId]
  );

  console.log(`Updated ${updateResult.rowCount} customer(s):`);
  for (const c of updateResult.rows) {
    console.log(` - ${c.customer_name} (${c.email}) -> business_id: ${c.business_id}`);
  }

  // Verify
  const total = await query('SELECT count(*) as count FROM customers WHERE business_id = $1', [targetBusinessId]);
  console.log(`Total customers with business_id ${targetBusinessId}: ${total.rows[0].count}`);

  const pool = getPool();
  await pool.end();
}

cleanupCustomers().catch((err) => {
  console.error('Customer cleanup failed:', err);
  process.exit(1);
});
