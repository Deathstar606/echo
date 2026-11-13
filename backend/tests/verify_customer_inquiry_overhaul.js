const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { query } = require('../db');
const {
  getWorkspaceContacts,
  addFilteredContactOneClick,
  importWorkspaceCustomerCsv,
} = require('../src/services/workspaceContactsService');
const {
  extractAndValidateAudienceTargeting,
} = require('../src/services/announcementPromptBuilderService');
const {
  getCustomersMatchingAnnouncementCriteria,
} = require('../src/services/customerService');

async function runTests() {
  console.log('=== Starting Customer Inquiry Panel Overhaul & Bulk Send Verification ===\n');

  // Test setup: create two test workspaces
  const ws1Id = crypto.randomUUID();
  const ws2Id = crypto.randomUUID();
  const testUserId = '48244777-c7a4-4e30-be4b-fe1104e443b8'; // Primary user

  await query(
    `INSERT INTO workspaces (id, user_id, name, created_at)
     VALUES ($1, $3, 'Test Alpha Workspace', NOW()), ($2, $3, 'Test Beta Workspace', NOW())
     ON CONFLICT (id) DO NOTHING;`,
    [ws1Id, ws2Id, testUserId]
  );

  try {
    // --------------------------------------------------------------------------
    // Test 1: 1-Click casing deduplication in filtered
    // --------------------------------------------------------------------------
    console.log('Test 1: 1-Click Casing Deduplication in Filtered Contacts...');
    const contact1 = await addFilteredContactOneClick(ws1Id, {
      email: 'Customer.VIP@AcmeCorp.COM',
      customer_name: 'Alice Smith',
      metadata: { threadId: 'thread-001', subject: 'Urgent Order Inquiry' },
    });
    assert.ok(contact1.id, 'Expected contact to be inserted');
    assert.equal(contact1.email, 'customer.vip@acmecorp.com', 'Expected email to be lowercased');

    // Add again with different casing and updated subject
    const contact2 = await addFilteredContactOneClick(ws1Id, {
      email: '   customer.vip@acmecorp.com   ',
      customer_name: 'Alice S.',
      metadata: { threadId: 'thread-001', subject: 'Updated Subject' },
    });
    assert.equal(contact1.id, contact2.id, 'Expected same contact ID due to deduplication');

    const contactsAfterOneClick = await getWorkspaceContacts(ws1Id);
    assert.equal(
      contactsAfterOneClick.filtered_count,
      1,
      'Expected exactly 1 contact in filtered after casing deduplication'
    );
    assert.equal(
      contactsAfterOneClick.workspace_csv_count,
      0,
      'Expected 0 contacts in workspace_csv panel'
    );
    console.log('  ✔ Passed: 1-click casing deduplication verified.\n');

    // --------------------------------------------------------------------------
    // Test 2: CSV upload without email column returns HTTP 400 INVALID_CSV_SCHEMA
    // --------------------------------------------------------------------------
    console.log("Test 2: CSV Upload Without Mandatory 'email' Column...");
    const invalidCsv = `Name,Phone,Company,Region
John Doe,555-0199,TechCorp,North
Jane Smith,555-0200,BetaInc,South`;

    let threwExpectedError = false;
    try {
      await importWorkspaceCustomerCsv(ws1Id, invalidCsv);
    } catch (err) {
      threwExpectedError = true;
      assert.equal(err.code, 'INVALID_CSV_SCHEMA', 'Expected error code INVALID_CSV_SCHEMA');
      assert.equal(
        err.message,
        "The uploaded CSV file must contain an 'email' column.",
        'Expected exact required error message'
      );
      assert.equal(err.statusCode, 400, 'Expected HTTP 400');
    }
    assert.ok(threwExpectedError, 'Expected importWorkspaceCustomerCsv to reject missing email column');
    console.log('  ✔ Passed: Missing email column rejected with HTTP 400 INVALID_CSV_SCHEMA.\n');

    // --------------------------------------------------------------------------
    // Test 3: Valid CSV with duplicates merged in workspace_csv with 0 added to filtered
    // --------------------------------------------------------------------------
    console.log('Test 3: CSV Import With Duplicate Merge & Zero Filtered Leakage...');
    const validCsvWithDuplicates = `Full Name,Email,Region,Tier
Bob Builder,bob@builder.com,East,Gold
Bob B.,BOB@BUILDER.COM,East,Platinum
Charlie Brown,charlie@peanuts.org,West,Silver
Dana Scully,dana@fbi.gov,Capital,VIP
Dana S.,dana@fbi.gov,Capital,Elite`;

    const csvResult = await importWorkspaceCustomerCsv(ws1Id, validCsvWithDuplicates);
    assert.equal(csvResult.success, true, 'Expected successful import');
    assert.equal(csvResult.imported_count, 3, 'Expected 3 unique customer contacts imported');
    assert.equal(csvResult.duplicates_merged, 2, 'Expected 2 duplicate emails merged');

    const contactsAfterCsv = await getWorkspaceContacts(ws1Id);
    assert.equal(
      contactsAfterCsv.workspace_csv_count,
      3,
      'Expected 3 contacts in workspace_csv panel'
    );
    assert.equal(
      contactsAfterCsv.filtered_count,
      1,
      'Expected filtered contacts count to remain strictly 1 (zero CSV leakage into filtered)'
    );

    // Verify merged metadata on duplicate
    const bob = contactsAfterCsv.workspace_csv_contacts.find((c) => c.email === 'bob@builder.com');
    assert.ok(bob, 'Expected Bob to be in workspace contacts');
    assert.equal(bob.metadata?.Tier, 'Platinum', 'Expected duplicate metadata to merge');
    console.log('  ✔ Passed: CSV duplicates merged cleanly into workspace_csv with 0 rows added to filtered.\n');

    // --------------------------------------------------------------------------
    // Test 4: Cross-workspace isolation
    // --------------------------------------------------------------------------
    console.log('Test 4: Cross-Workspace Contact Isolation...');
    const ws2Contacts = await getWorkspaceContacts(ws2Id);
    assert.equal(ws2Contacts.filtered_count, 0, 'Workspace 2 must have 0 filtered contacts');
    assert.equal(ws2Contacts.workspace_csv_count, 0, 'Workspace 2 must have 0 CSV contacts');

    // Upload different contacts to Workspace 2
    const ws2Csv = `Name,Email,Department
Agent Mulder,mulder@fbi.gov,X-Files`;
    await importWorkspaceCustomerCsv(ws2Id, ws2Csv);

    const ws2ContactsAfter = await getWorkspaceContacts(ws2Id);
    assert.equal(ws2ContactsAfter.workspace_csv_count, 1, 'Workspace 2 must have 1 contact');
    const ws1ContactsRecheck = await getWorkspaceContacts(ws1Id);
    assert.equal(ws1ContactsRecheck.workspace_csv_count, 3, 'Workspace 1 contacts must be unaffected');
    console.log('  ✔ Passed: Workspaces are strictly isolated.\n');

    // --------------------------------------------------------------------------
    // Test 5: Bulk Send Audience Targeting for Filtered vs Workspace CSV Panel
    // --------------------------------------------------------------------------
    console.log('Test 5: Bulk Send Audience Targeting for Workspace Panels...');
    const targetingCsv = extractAndValidateAudienceTargeting(
      'Bulk send a 20% discount offer to our workspace customer base.'
    );
    assert.equal(targetingCsv.status, 'ok');
    assert.equal(targetingCsv.source, 'workspace_contacts');
    assert.equal(targetingCsv.panel_type, 'workspace_csv');
    assert.equal(targetingCsv.audience_description, 'Workspace Customer Base');

    const csvRecipients = await getCustomersMatchingAnnouncementCriteria(ws1Id, targetingCsv);
    assert.equal(csvRecipients.length, 3, 'Expected 3 recipients from Workspace 1 CSV panel');

    const targetingFiltered = extractAndValidateAudienceTargeting(
      'Bulk send a notification regarding resolution to our filtered contacts.'
    );
    assert.equal(targetingFiltered.status, 'ok');
    assert.equal(targetingFiltered.source, 'workspace_contacts');
    assert.equal(targetingFiltered.panel_type, 'filtered');
    assert.equal(targetingFiltered.audience_description, 'Filtered Contacts');

    const filteredRecipients = await getCustomersMatchingAnnouncementCriteria(ws1Id, targetingFiltered);
    assert.equal(filteredRecipients.length, 1, 'Expected 1 recipient from Workspace 1 Filtered panel');
    console.log('  ✔ Passed: Bulk send audience targeting routes accurately to workspace panels.\n');

    console.log('=== All 5 Customer Inquiry & Bulk Send Overhaul Verification Tests Passed! ===');
  } finally {
    // Cleanup test data
    await query('DELETE FROM workspace_contacts WHERE workspace_id IN ($1, $2);', [ws1Id, ws2Id]);
    await query('DELETE FROM workspaces WHERE id IN ($1, $2);', [ws1Id, ws2Id]);
  }
}

runTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Test Failed:', err);
    process.exit(1);
  });
