import assert from "node:assert/strict";
import test from "node:test";
import { parseEnvText } from "./env.js";

test("reads dotenv lines", () => {
  const values = parseEnvText(["# comment", "ANYDB_TEAM_ID=abc", 'ANYDB_ADB_ID="def"', "export X='y z'"].join("\n"));
  assert.deepEqual(values, { ANYDB_TEAM_ID: "abc", ANYDB_ADB_ID: "def", X: "y z" });
});

test("reads pasted PowerShell lines, including a prompt before each statement", () => {
  const text = [
    '$env:ANYDB_API_KEY="secret-one"',
    'PS C:\\Users\\someone\\project> $env:ANYDB_USER_EMAIL="me@example.com"',
    "PS C:\\Users\\someone\\project> $env:ANYDB_BASE_URL='https://dev1.example.com/api'",
  ].join("\r\n");
  assert.deepEqual(parseEnvText(text), {
    ANYDB_API_KEY: "secret-one",
    ANYDB_USER_EMAIL: "me@example.com",
    ANYDB_BASE_URL: "https://dev1.example.com/api",
  });
});

test("the last value for a repeated key wins", () => {
  assert.equal(parseEnvText('$env:ANYDB_BASE_URL="a"\n$env:ANYDB_BASE_URL="b"').ANYDB_BASE_URL, "b");
});
