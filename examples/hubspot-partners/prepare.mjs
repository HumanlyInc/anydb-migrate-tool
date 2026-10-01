// Turns the four raw HubSpot CRM exports into flat per-entity CSV files for anydb-migrate.
//
//   node examples/hubspot-partners/prepare.mjs <exports-dir> <out-dir>
//
// <exports-dir> must hold the exports (file names are matched by keyword):
//   *records*    the custom "Partner" object export (has the Associated ... IDs columns)
//   *companies*  *contacts*  *deals*
//
// Everything HubSpot-specific lives here: reading by header name, following the ID lists on
// the partner export, picking each deal's customer company, and deriving statuses. The
// anydb-migrate plan (plan.yaml) then only maps clean columns onto AnyDB fields.
import ExcelJS from "exceljs";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [exportsDir, outDir] = process.argv.slice(2);
if (!exportsDir || !outDir) {
  console.error("Usage: node prepare.mjs <exports-dir> <out-dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

// ---------- reading ----------
function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    if ("result" in value) return cellText(value.result);
    if ("text" in value) return String(value.text);
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
  }
  return value;
}

async function readSheet(keyword) {
  const file = readdirSync(exportsDir).find((name) => name.toLowerCase().includes(keyword) && name.endsWith(".xlsx"));
  if (!file) throw new Error(`No *.xlsx containing "${keyword}" in ${exportsDir}`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(exportsDir, file));
  const sheet = workbook.worksheets[0];
  const headers = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, index) => { headers[index] = String(cellText(cell.value)).trim(); });
  const rows = [];
  for (let r = 2; r <= sheet.actualRowCount; r += 1) {
    const raw = sheet.getRow(r);
    const row = new Map();
    headers.forEach((header, index) => {
      if (!header) return;
      const value = cellText(raw.getCell(index).value);
      const key = header.toLowerCase();
      if (value !== "" && !row.has(key)) row.set(key, value); // first non-empty column wins for duplicate headers
    });
    if (row.size > 0) rows.push(row);
  }
  console.log(`Read ${rows.length} rows from ${file}`);
  return rows;
}

const get = (row, ...names) => {
  for (const name of names) {
    const value = row.get(name.toLowerCase());
    if (value !== undefined && value !== "") return value;
  }
  return "";
};
const text = (value) => String(value ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const ids = (value) => String(value ?? "").split(/[;,]/).map((part) => part.trim()).filter(Boolean);
const slug = (value) => text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const domainOf = (value) => text(value).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");

/** Excel serial day, JS Date or ISO text to epoch seconds; blank when empty. */
function epoch(value) {
  if (value === "" || value === undefined || value === null) return "";
  if (value instanceof Date) return Math.round(value.getTime() / 1000);
  const number = Number(value);
  if (Number.isFinite(number)) return number > 100000 ? Math.round(number) : Math.round((number - 25569) * 86400);
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? "" : Math.round(parsed / 1000);
}

function csv(rows, columns) {
  const cell = (value) => {
    const textValue = String(value ?? "");
    return /[",\r\n]/.test(textValue) ? `"${textValue.replace(/"/g, '""')}"` : textValue;
  };
  return `${[columns, ...rows.map((row) => columns.map((column) => row[column]))].map((line) => line.map(cell).join(",")).join("\n")}\n`;
}

// ---------- load ----------
const partnerRows = await readSheet("records");
const companyRows = await readSheet("companies");
const contactRows = await readSheet("contacts");
const dealRows = await readSheet("deals");

const byId = (rows) => new Map(rows.map((row) => [String(get(row, "record id")), row]));
const companiesById = byId(companyRows);
const contactsById = byId(contactRows);
const dealsById = byId(dealRows);

const report = [];
const warn = (message) => report.push(message);

// ---------- partners ----------
const STAGE_STATUS = {
  "signed (active)": "Active", "enablement underway (active)": "Active", "ongoing management (active)": "Active",
  "offboarded": "Churned",
  "identified or prospect": "Prospect", "drip marketing": "Prospect", "poc or evaluation underway": "Prospect", "committed and negotiation": "Prospect",
};
const HS_STATUS = { "active partner": "Active", "post: churned": "Churned", "pre: not yet a partner": "Prospect" };

const partners = [];
const companies = new Map(); // company_key -> row
const contacts = [];
const deals = [];
const claimedContacts = new Set();
const claimedDeals = new Set();

const companyKeyByName = new Map(); // normalized name -> company_key (all known companies)
for (const row of companyRows) companyKeyByName.set(slug(get(row, "company name")), String(get(row, "record id")));

// partner_hs is the partner that brought the company in (so a partner-filtered run takes it along);
// parent_partner_hs is set only for a partner's own company, which is filed under that Partner.
function addCompany(hsId, role, parentId, scopeId) {
  const row = companiesById.get(hsId);
  if (!row) return null;
  const existing = companies.get(hsId);
  if (existing) {
    if (parentId && !existing.parent_partner_hs) { existing.parent_partner_hs = parentId; existing.role = role; }
    return existing;
  }
  const entry = {
    company_key: hsId,
    name: text(get(row, "company name")),
    domain: domainOf(get(row, "company domain name")),
    website: text(get(row, "website url", "company domain name")),
    country: text(get(row, "country/region")),
    role,
    partner_hs: scopeId ?? "",
    parent_partner_hs: parentId ?? "",
  };
  companies.set(hsId, entry);
  return entry;
}

for (const row of partnerRows) {
  const hs = String(get(row, "record id"));
  const name = text(get(row, "partner name"));
  if (!hs || !name) { warn(`partner row without id or name skipped (${hs || "no id"})`); continue; }
  const stage = text(get(row, "partner pipeline stage"));
  const hsStatus = text(get(row, "active status")).toLowerCase();
  const status = HS_STATUS[hsStatus] ?? STAGE_STATUS[stage.toLowerCase()] ?? "Inactive";

  const associatedCompanies = ids(get(row, "associated company ids")).filter((id) => companiesById.has(id));
  const associatedContacts = ids(get(row, "associated contact ids")).filter((id) => contactsById.has(id));
  const contactDomains = associatedContacts.map((id) => String(get(contactsById.get(id), "email")).split("@")[1]?.toLowerCase()).filter(Boolean);
  let ownId = ids(get(row, "partner's company record ids", "partner's company record id")).find((id) => companiesById.has(id));
  if (!ownId) ownId = associatedCompanies.find((id) => contactDomains.includes(domainOf(get(companiesById.get(id), "company domain name"))));
  if (!ownId) ownId = associatedCompanies.find((id) => slug(get(companiesById.get(id), "company name")) === slug(name));
  let own = ownId ? addCompany(ownId, "Partner", hs, hs) : null;
  if (!own) {
    // HubSpot has no company for this partner, so make one from the partner itself
    const key = `nohs:partner-${hs}`;
    own = { company_key: key, name, domain: contactDomains[0] ?? "", website: contactDomains[0] ?? "", country: "", role: "Partner", partner_hs: hs, parent_partner_hs: hs };
    companies.set(key, own);
    warn(`partner ${hs} "${name}" has no company in HubSpot; one will be created from the partner name`);
  }
  for (const id of associatedCompanies) if (id !== ownId) addCompany(id, "Customer", null, hs);

  const domain = own?.domain || contactDomains[0] || "";
  const primaryId = associatedContacts.find((id) => !claimedContacts.has(id) && String(get(contactsById.get(id), "email")).includes("@"));
  partners.push({
    partner_hs: hs,
    partner_name: name,
    status,
    region: text(get(row, "management region")),
    pipeline_stage: stage,
    partner_types: text(get(row, "type")),
    website_domain: domain,
    allowed_domains: [...new Set([domain, ...contactDomains])].filter(Boolean).join(", "),
    contract_end: epoch(get(row, "contract end date")),
    contract_renewal: epoch(get(row, "contract renewal date")),
    owner: text(get(row, "owner")),
    level: text(get(row, "partner tier")),
    own_company_key: own?.company_key ?? "",
    primary_contact_hs: primaryId ?? "",
  });

  // contacts: a contact linked to several partners belongs to the first one that claims it
  for (const id of associatedContacts) {
    if (claimedContacts.has(id)) { warn(`contact ${id} is linked to more than one partner; kept with the first`); continue; }
    claimedContacts.add(id);
    const c = contactsById.get(id);
    const email = text(get(c, "email")).toLowerCase();
    if (!email.includes("@")) { warn(`contact ${id} has no usable email and was skipped`); continue; }
    contacts.push({
      contact_hs: id,
      first_name: text(get(c, "first name")),
      last_name: text(get(c, "last name")),
      email,
      job_title: text(get(c, "job title")),
      phone: text(get(c, "phone number")),
      mobile: text(get(c, "mobile phone number")),
      partner_hs: hs,
      company_key: own?.company_key ?? "",
    });
  }

  // deals: the customer company is the deal's own company columns when present, else the partner's other company, else its own
  const customerCandidates = associatedCompanies.filter((id) => id !== ownId);
  for (const id of ids(get(row, "associated deal ids"))) {
    const d = dealsById.get(id);
    if (!d) continue;
    if (claimedDeals.has(id)) { warn(`deal ${id} is linked to more than one partner; kept with the first`); continue; }
    claimedDeals.add(id);
    const customerName = text(get(d, "customer company name (submitted by partner)", "company name"));
    let companyKey = "";
    if (customerName) {
      const wanted = slug(customerName);
      companyKey = customerCandidates.find((cid) => slug(get(companiesById.get(cid), "company name")) === wanted)
        ?? (own && slug(own.name) === wanted ? own.company_key : undefined)
        ?? companyKeyByName.get(wanted) ?? "";
      if (companyKey) addCompany(companyKey, "Customer", null, hs);
      else {
        companyKey = `nohs:${wanted.replace(/ /g, "-")}`;
        if (!companies.has(companyKey)) {
          companies.set(companyKey, { company_key: companyKey, name: customerName, domain: "", website: "", country: "", role: "Customer", partner_hs: hs, parent_partner_hs: "" });
          warn(`deal ${id}: customer "${customerName}" is not in the companies export; a company will be created`);
        }
      }
    } else if (customerCandidates.length === 1) {
      companyKey = customerCandidates[0];
    } else {
      companyKey = own?.company_key ?? "";
    }
    if (!companyKey) { warn(`deal ${id} has no company and was skipped`); continue; }

    const pipeline = text(get(d, "pipeline"));
    const stage = text(get(d, "deal stage"));
    const isPartnersPipeline = pipeline.toLowerCase() === "partners";
    const lower = stage.toLowerCase().replace(/[-–:]/g, " ").replace(/\s+/g, " ");
    let registrationStatus = "";
    if (isPartnersPipeline) {
      if (/closed won|msp customer/.test(lower)) registrationStatus = "Won";
      else if (/closed lost/.test(lower)) registrationStatus = "Lost";
      else if (/new sales ready/.test(lower)) registrationStatus = "Submitted";
      else if (/booked a call|intro call/.test(lower)) registrationStatus = "In Review";
      else registrationStatus = "Registered";
    }
    deals.push({
      deal_hs: id,
      deal_name: text(get(d, "deal name")),
      amount: get(d, "amount"),
      close_date: epoch(get(d, "close date")),
      pipeline,
      stage,
      deal_type: text(get(d, "deal type")),
      owner: text(get(d, "deal owner")),
      partner_hs: hs,
      company_key: companyKey,
      customer_name: customerName,
      partner_role: isPartnersPipeline ? "Registered By" : "Managed",
      registration_status: registrationStatus,
      primary_contact_hs: primaryId ?? "",
    });
  }
}

const unlinkedDeals = dealRows.filter((row) => !claimedDeals.has(String(get(row, "record id")))).length;
if (unlinkedDeals > 0) warn(`${unlinkedDeals} deals in the export are not linked to any partner and were left out`);

// ---------- write ----------
const write = (name, rows, columns) => {
  writeFileSync(path.join(outDir, name), csv(rows, columns), "utf8");
  console.log(`Wrote ${rows.length} rows to ${name}`);
};
write("partners.csv", partners, ["partner_hs", "partner_name", "status", "region", "pipeline_stage", "partner_types", "website_domain", "allowed_domains", "contract_end", "contract_renewal", "owner", "level", "own_company_key", "primary_contact_hs"]);
write("companies.csv", [...companies.values()], ["company_key", "name", "domain", "website", "country", "role", "partner_hs", "parent_partner_hs"]);
write("contacts.csv", contacts, ["contact_hs", "first_name", "last_name", "email", "job_title", "phone", "mobile", "partner_hs", "company_key"]);
write("deals.csv", deals, ["deal_hs", "deal_name", "amount", "close_date", "pipeline", "stage", "deal_type", "owner", "partner_hs", "company_key", "customer_name", "partner_role", "registration_status", "primary_contact_hs"]);
writeFileSync(path.join(outDir, "prepare-report.txt"), `${report.join("\n")}\n`, "utf8");
console.log(`\n${report.length} notes written to prepare-report.txt`);
