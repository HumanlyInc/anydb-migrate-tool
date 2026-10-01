// Run inside AnyDB (anydb_simulate_script, then anydb_run_script), after the import.
//
// The registration's own "Deal" field is locked, so the REST API (and anydb-migrate) cannot
// write it, but scripts running inside AnyDB can. The import sets Deal.Registration; this copies
// that link back onto each registration. It is time-boxed and safe to run again: finished
// registrations are skipped, and the output says whether more remain.
const CONFIG = { budgetMs: 240000 };
const started = Date.now();

const refId = (value) => {
  const ref = Array.isArray(value) ? value[0] : value;
  return ref && ref.adoid ? ref.adoid : "";
};

const deals = await anydb.getRecordsByType("Deal");
let linked = 0;
let already = 0;
let withoutRegistration = 0;
let remaining = 0;
const problems = [];

for (const deal of deals) {
  await anydb.yield();
  const registrationId = refId(deal.cellValues["Registration"]);
  if (!registrationId) { withoutRegistration += 1; continue; }
  if (Date.now() - started > CONFIG.budgetMs) { remaining += 1; continue; }
  try {
    const registration = await anydb.getRecordById(registrationId);
    if (refId(registration.cellValues["Deal"]) === deal.id) { already += 1; continue; }
    await registration.setCellRefValue("Deal", deal.id);
    linked += 1;
  } catch (error) {
    problems.push(`${deal.name}: ${String(error && error.message ? error.message : error)}`);
  }
}

output.set("linked", linked);
output.set("alreadyLinked", already);
output.set("dealsWithoutRegistration", withoutRegistration);
output.set("remainingRunAgain", remaining);
output.set("problems", problems);
output.summary(`Linked ${linked}, already linked ${already}, no registration ${withoutRegistration}, remaining ${remaining}, problems ${problems.length}`);
