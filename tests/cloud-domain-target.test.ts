import assert from "node:assert/strict";
import { normalizeTarget } from "../supabase/functions/marugo-qr/handler.ts";

Deno.test("custom-domain tracking URLs cannot redirect back into their own tracking page", () => {
  for (const host of ["marugo-waltz.com", "www.marugo-waltz.com"]) {
    for (const protocol of ["https:", "http:"]) {
      for (const path of ["/#abcdefghijkl", "/?s=q#abcdefghijkl", "/marugo/#abcdefghijkl", "/marugo"]) {
        assert.throws(() => normalizeTarget(`${protocol}//${host}${path}`), /計測用URL自身/);
      }
    }
  }
});

Deno.test("custom-domain non-tracking files and normal external targets are unchanged", () => {
  for (const url of ["https://marugo-waltz.com/", "https://marugo-waltz.com/?file=abcdefghijkl", "https://example.com/#abcdefghijkl"]) {
    assert.equal(normalizeTarget(url), url);
  }
});
