// The app ships an SVG favicon (white orca mark on black) and index.html links it,
// so both the Vite dev server and the built dist serve it.
import { expect, test } from "bun:test";

test("favicon.svg exists, is white-on-black, and is linked from index.html", async () => {
  const svg = await Bun.file(new URL("../web/public/favicon.svg", import.meta.url)).text();
  expect(svg).toContain('fill="#000"'); // black background
  expect(svg).toContain('fill="#fff"'); // white mark

  const html = await Bun.file(new URL("../web/index.html", import.meta.url)).text();
  expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
});
