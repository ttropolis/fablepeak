// ADR 0003 flow 8 (inbox): filter tabs, unread clearing, replying to a thread and resolving it.
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp } from "../../test-harness/app.mjs";

const senders = app => app.$$(".msglist .msg .from span:first-child").map(s => s.textContent);
const bubbles = app => app.$$(".bubbles .bub").map(b => `${b.className.replace("bub ", "")}: ${b.textContent}`);
const tab = (app, label) => app.byText(".tabbar button", label);

async function openInbox(app) {
  await app.click(app.byText("#nav button", "Inbox"));
  await app.waitFor(() => app.$(".inboxwrap"), { label: "the inbox" });
}

test("the default filter hides resolved conversations", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openInbox(app);

  assert.deepEqual(senders(app), ["@sofia.designs", "@devmarcus", "Laura P."]);
  assert.equal(app.text(".thread"), "Select a conversation");
  assert.match(app.main().textContent, /⚠️ Sample conversations — not real messages\./);
});

test("the unread and resolved filters each show their own subset", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openInbox(app);

  await app.click(tab(app, "Unread"));
  assert.deepEqual(senders(app), ["@sofia.designs", "@devmarcus"]);

  await app.click(tab(app, "Resolved"));
  assert.deepEqual(senders(app), ["Carlos M. (Acme Corp)"]);

  await app.click(tab(app, "All"));
  assert.equal(senders(app).length, 3);
});

test("opening a conversation clears its unread marker and shows the thread", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openInbox(app);

  const unreadBefore = app.$$(".msglist .msg.unread").length;
  assert.equal(unreadBefore, 2);

  await app.click(app.$$(".msglist .msg")[0]);
  assert.equal(app.$$(".msglist .msg.unread").length, 1, "the opened thread is no longer unread");
  assert.equal(app.$(".msglist .msg.sel").getAttribute("aria-pressed"), "true");
  assert.match(app.text(".thread strong"), /^@sofia\.designs · Instagram$/);
  assert.deepEqual(bubbles(app), ["them: Hi! Do you ship internationally?"]);
  assert.equal(app.db.brands[0].inbox[0].unread, false);
});

test("replying appends to the thread and keeps it selected", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openInbox(app);
  await app.click(app.$$(".msglist .msg")[0]);

  await app.fill("#replyInp", "Yes — we ship worldwide!");
  await app.click(app.byText(".replyrow button", "Send"));

  assert.equal(app.toast(), "Reply sent");
  assert.deepEqual(bubbles(app), [
    "them: Hi! Do you ship internationally?",
    "me: Yes — we ship worldwide!",
  ]);
  assert.equal(app.$("#replyInp").value, "", "the reply box is cleared for the next message");
  assert.equal(app.text(".msglist .msg.sel .prev"), "Yes — we ship worldwide!",
    "the list preview follows the latest message");
});

test("an empty reply is ignored", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openInbox(app);
  await app.click(app.$$(".msglist .msg")[0]);

  await app.fill("#replyInp", "   ");
  await app.click(app.byText(".replyrow button", "Send"));
  assert.deepEqual(bubbles(app), ["them: Hi! Do you ship internationally?"]);
});

test("Enter in the reply box sends the message", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openInbox(app);
  await app.click(app.$$(".msglist .msg")[0]);

  await app.fill("#replyInp", "Sent with the keyboard");
  await app.press("#replyInp", "Enter");
  assert.deepEqual(bubbles(app).at(-1), "me: Sent with the keyboard");
});

test("resolving removes the conversation from the default filter and clears the selection", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openInbox(app);
  await app.click(app.$$(".msglist .msg")[0]);

  await app.click(app.byText(".thread button", "Mark resolved"));
  assert.deepEqual(senders(app), ["@devmarcus", "Laura P."]);
  assert.equal(app.text(".thread"), "Select a conversation");

  await app.click(tab(app, "Resolved"));
  assert.deepEqual(senders(app), ["@sofia.designs", "Carlos M. (Acme Corp)"]);

  await app.click(app.$$(".msglist .msg")[0]);
  await app.click(app.byText(".thread button", "Reopen"));
  await app.click(tab(app, "All"));
  assert.deepEqual(senders(app), ["@sofia.designs", "@devmarcus", "Laura P."]);
});

test("an empty filter shows the empty state rather than a broken list", async t => {
  const app = await bootApp({ mode: "local" });
  t.after(() => app.close());
  await openInbox(app);

  for (const message of app.$$(".msglist .msg")) {
    await app.click(message);
    await app.click(app.byText(".thread button", "Mark resolved"));
  }
  assert.deepEqual(senders(app), []);
  assert.equal(app.text(".msglist .empty"), "Nothing here 🎉");
});
