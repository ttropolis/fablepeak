// ADR 0003 flow 3 (compose and schedule): each invalid media/network combination is rejected with its own toast.
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

const saveButton = app => app.$(".modalfoot .right button.btn:not(.ghost)");

/** Connect an extra network the way local/demo mode offers it: Connections → Simulate. */
async function simulate(app, ...netIds) {
  await app.click(app.byText("#nav button", "Connections"));
  for (const netId of netIds) {
    await app.waitFor(() => app.$(`#h_${netId}`), { label: `the ${netId} card` });
    await app.fill(`#h_${netId}`, "@fixture");
    await app.click(app.byText("button", "Simulate", app.$(`#h_${netId}`).closest(".conn")));
  }
  await app.click(app.byText("#nav button", "Planner"));
}

async function attempt(app, { text = "Something to say", networks = [], media, date, time }) {
  await app.click('[aria-label="Schedule a post on 2026-06-22"]');
  await app.waitFor(() => app.$("#pm_text"), { label: "the post modal" });
  await app.fill("#pm_text", text);
  for (const box of app.$$("#pm_nets input")) await app.check(box, networks.includes(box.value));
  if (media !== undefined) await app.fill("#pm_media", media);
  if (date !== undefined) await app.fill("#pm_date", date);
  if (time !== undefined) await app.fill("#pm_time", time);
  const before = app.db.brands[0].posts.length;
  await app.click(saveButton(app));
  return before;
}

async function assertRejected(app, before, message) {
  assert.equal(app.toast(), message);
  assert.equal(app.modalOpen(), true, "a rejected post keeps the composer open");
  assert.equal(app.db.brands[0].posts.length, before, "a rejected post is not saved");
}

test("empty content is rejected before anything else", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  const before = await attempt(app, { text: "   ", networks: ["x"] });
  await assertRejected(app, before, "Write some content first");
});

test("a post with no network is rejected", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  const before = await attempt(app, { networks: [] });
  await assertRejected(app, before, "Pick at least one network");
});

test("a post with no date or time is rejected", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  const before = await attempt(app, { networks: ["x"], time: "" });
  await assertRejected(app, before, "Choose a date and time");
});

test("Instagram is refused without media, and names itself in the toast", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  const before = await attempt(app, { networks: ["instagram"], media: "" });
  await assertRejected(app, before, "Instagram need an image/video URL");
});

test("every media-required network is named when several are selected", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await simulate(app, "pinterest");
  const before = await attempt(app, { networks: ["instagram", "pinterest"], media: "" });
  await assertRejected(app, before,
    "Instagram and Pinterest need an image/video URL");
});

test("insecure media URLs are refused", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  const before = await attempt(app, {
    networks: ["instagram"], media: "http://cdn.example.com/photo.jpg",
  });
  await assertRejected(app, before, "Media must use a valid https:// URL");
});

test("LinkedIn refuses a video attachment", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  const before = await attempt(app, {
    networks: ["linkedin"], media: "https://cdn.example.com/clip.mp4",
  });
  await assertRejected(app, before,
    "LinkedIn currently supports image attachments only — remove the video or LinkedIn");
});

test("Pinterest refuses a video Pin", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await simulate(app, "pinterest");
  const before = await attempt(app, {
    networks: ["pinterest"], media: "https://cdn.example.com/clip.mov",
  });
  await assertRejected(app, before,
    "Pinterest video Pins are not supported yet — choose an image or remove Pinterest");
});

test("YouTube refuses a watch page in place of a video file", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await simulate(app, "youtube");
  const before = await attempt(app, {
    networks: ["youtube"], media: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  await assertRejected(app, before,
    "YouTube needs a direct video file URL, not a YouTube watch link");
});

test("a valid Instagram post with https media is accepted", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  const before = await attempt(app, {
    networks: ["instagram"], media: "https://cdn.example.com/photo.jpg",
  });
  assert.equal(app.toast(), "Draft saved");
  assert.equal(app.modalOpen(), false);
  assert.equal(app.db.brands[0].posts.length, before + 1);
  const saved = app.db.brands[0].posts.at(-1);
  assert.equal(saved.media_url, "https://cdn.example.com/photo.jpg");
  assert.deepEqual([...saved.networks], ["instagram"]);
});

/* The mirror image of the LinkedIn and Pinterest refusals above: the guards are
   about the *kind* of attachment, so an image on the same network is accepted. */
test("an image attachment is accepted by the networks that refuse video", async t => {
  for (const network of ["linkedin", "pinterest"]) {
    const app = await bootApp({ mode: "local" });
    t.after(() => app.close());
    if (network === "pinterest") await simulate(app, "pinterest");
    const before = await attempt(app, {
      networks: [network], media: "https://cdn.example.com/launch.png",
    });
    assert.equal(app.toast(), "Draft saved", `${network} should accept an image`);
    assert.equal(app.db.brands[0].posts.length, before + 1);
    assert.equal(app.db.brands[0].posts.at(-1).media_url, "https://cdn.example.com/launch.png");
  }
});

test("a text-only network needs no media at all", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  const before = await attempt(app, { networks: ["x"], media: "" });
  assert.equal(app.toast(), "Draft saved");
  assert.equal(app.db.brands[0].posts.length, before + 1);
  assert.equal(app.db.brands[0].posts.at(-1).media_url, "");
});

test("networks the brand has not connected cannot be selected at all", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await app.click('[aria-label="Schedule a post on 2026-06-22"]');
  await app.waitFor(() => app.$("#pm_nets"));

  const gbp = app.$('#pm_nets input[value="gbp"]');
  assert.equal(gbp.disabled, true);
  assert.equal(gbp.closest("label").querySelector(".netreason").textContent, "Not connected");
});
