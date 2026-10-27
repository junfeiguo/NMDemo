// Writes ../voice/phone-agent-prompt.md from the same knowledge the website assistant uses.
// Run: node make-phone-prompt.mjs
import { writeFileSync } from "node:fs";
import { buildPrompt } from "./prompt.js";
const p = buildPrompt("voice", "{{current date and time in London}}");
writeFileSync(new URL("../voice/phone-agent-prompt.md", import.meta.url), p + "\n");
console.log("written", p.length, "characters");
