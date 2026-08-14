
import fs from "node:fs";
import assert from "node:assert/strict";

const main = fs.readFileSync(new URL("../src/main.mjs", import.meta.url), "utf8");
assert.match(main, /smartFinishReviewExport/);
assert.match(main, /smartFinishStartReviewedExport/);
assert.match(main, /第二道防护必须重新听“最终成品”/);
assert.match(main, /severity === "red"/);
assert.match(main, /severity === "green"/);
assert.match(main, /inverseOutputTime/);
assert.match(main, /post-review/);
console.log("post export review guard: ok");
