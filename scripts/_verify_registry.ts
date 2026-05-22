import { getToolsForRole, getToolNamesForRole, getToolByName } from '../lib/tools/registry';

async function verify() {
  console.log("=== 1. Testing Null Role Guard ===");
  console.log("getToolNamesForRole(null):", getToolNamesForRole(null));
  console.log("getToolsForRole(null).length:", getToolsForRole(null).length);

  console.log("\n=== 2. Testing ISO-8601 Validation ===");
  const tool = getToolByName('draftCalendarEvent');

  try {
    console.log("Trying invalid date ('next tuesday')...");
    await tool.invoke({ summary: 'Test', start: 'next tuesday', end: 'after lunch' });
    console.log("❌ FAILED: Should have rejected invalid date");
  } catch (err: any) {
    console.log("✅ SUCCESS: Rejected invalid date. Error:", err.message.split('\n')[0]);
  }

  try {
    console.log("\nTrying valid ISO-8601 date ('2024-06-15T09:00:00Z')...");
    const result = await tool.invoke({
      summary: 'Standup',
      start: '2024-06-15T09:00:00Z',
      end: '2024-06-15T09:30:00Z'
    });
    console.log("✅ SUCCESS: Accepted valid date! Output:", result);
  } catch (err: any) {
    console.log("❌ FAILED: Rejected valid date", err);
  }
}

verify();
