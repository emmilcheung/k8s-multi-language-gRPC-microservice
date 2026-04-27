// backfill-quota.js — one-time migration for ticket documents created before CP-02.
//
// Run with: mongosh <MONGO_URI> services/ticket-service/scripts/backfill-quota.js
//
// Safe to re-run: the $exists filter only touches documents that are missing
// the quota field, so already-migrated documents are unchanged.

const db = connection.getDB("tickets_db");
const result = db.tickets.updateMany(
  { quota: { $exists: false } },
  {
    $set: {
      quota: 1,
      reserved: 0,
      sold: 0,
      maxPerUser: 1,
    },
  }
);

print(`Backfill complete. Modified: ${result.modifiedCount}`);

// Verify: no documents should remain without quota after migration.
const remaining = db.tickets.countDocuments({ quota: { $exists: false } });
if (remaining > 0) {
  print(`WARNING: ${remaining} documents still missing quota field.`);
} else {
  print("All ticket documents now have quota fields.");
}
