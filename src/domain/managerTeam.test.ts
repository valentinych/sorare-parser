import assert from "node:assert/strict";
import test from "node:test";
import { squadBuilderImageUrl } from "./managerTeam.js";

const S3 = "https://mantrafootball.s3.eu-west-1.amazonaws.com";

function proxied(href: string) {
  return `/mantra/image?url=${encodeURIComponent(href)}`;
}

test("squadBuilderImageUrl proxies relative and S3 mantra photos", () => {
  assert.equal(
    squadBuilderImageUrl("/player_avatars/wareham.png"),
    proxied(`${S3}/player_avatars/wareham.png`),
  );
  assert.equal(
    squadBuilderImageUrl(`${S3}/player_avatars/stockley.png`),
    proxied(`${S3}/player_avatars/stockley.png`),
  );
  const already = proxied(`${S3}/player_avatars/foo.png`);
  assert.equal(squadBuilderImageUrl(already), already);
  assert.equal(squadBuilderImageUrl("https://evil.example/player_avatars/x.png"), null);
  assert.equal(squadBuilderImageUrl(null), null);
  assert.equal(squadBuilderImageUrl(""), null);
  assert.equal(squadBuilderImageUrl("  "), null);
});
