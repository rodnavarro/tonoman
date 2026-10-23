// TEAMS-PRIVATE-LOGIN (teams-app.md in Tonoman Cloud): on a channel with no buttons or dialogs, a
// sign-in is offered only in the person's own chat, and the code they paste back there completes it.
import { describe, it, expect } from "vitest";
import { ask, looksLikeCode, submitPastedCode, type AuthGateDeps } from "./authgate";

function fakes(o: { private: boolean; ok?: boolean }) {
  const said: { conversation: string; text: string }[] = [];
  const expected: string[] = [];
  const states: string[] = [];
  const conn = {
    reply: (conversation: string) => ({ send: async (text: string) => void said.push({ conversation, text }) }),
  };
  const deps = {
    conn: () => conn,
    ops: () => ({
      startHeadless: async () => ({ url: "https://claude.ai/oauth/authorize?code=true" }),
      submitCode: async (code: string) => ({ ok: o.ok ?? code === "good-code-0123456789abcdef#state", status: "bad code", loginTail: "" }),
    }),
    setAuthState: async (_a: string, state: string) => void states.push(state),
    isPrivate: async () => o.private,
    expectCode: (_a: string, conversation: string) => void expected.push(conversation),
  } as unknown as AuthGateDeps;
  return { deps, said, expected, states };
}

describe("signing in on a channel with no dialogs", () => {
  it("TEAMS-PRIVATE-LOGIN in the person's own chat: the link, and the code is asked for there", async () => {
    const f = fakes({ private: true });
    expect(await ask(f.deps, "jarvis", "Jarvis", "a:1chat", undefined, "aad-ana")).toBe(true);
    expect(f.said[0]!.text).toMatch(/Open this link, sign in, and send me the code it shows you, here:\nhttps:\/\/claude\.ai\/oauth/);
    expect(f.expected).toEqual(["a:1chat"]);
  });

  it("TEAMS-PRIVATE-LOGIN in a group: no link, no code — the person is asked to message the agent directly", async () => {
    const f = fakes({ private: false });
    await ask(f.deps, "jarvis", "Jarvis", "19:group", undefined, "aad-ana");
    expect(f.said[0]!.text).toMatch(/Send me a direct message/);
    expect(f.said[0]!.text).not.toMatch(/https:/);
    expect(f.expected).toEqual([]);
  });

  it("TEAMS-PRIVATE-LOGIN the code pasted back completes the login and is recorded; a wrong one says so", async () => {
    const ok = fakes({ private: true });
    expect(await submitPastedCode(ok.deps, "jarvis", "a:1chat", undefined, "aad-ana", "good-code-0123456789abcdef#state")).toBe(true);
    expect(ok.states).toEqual(["ok"]);
    expect(ok.said.at(-1)!.text).toMatch(/Connected/);
    const bad = fakes({ private: true, ok: false });
    expect(await submitPastedCode(bad.deps, "jarvis", "a:1chat", undefined, "aad-ana", "wrong-code-0123456789")).toBe(false);
    expect(bad.states).toEqual(["error"]);
    expect(bad.said.at(-1)!.text).toMatch(/didn't complete the login/);
  });

  it("TEAMS-PRIVATE-LOGIN only a message shaped like a code is taken as one; a question is not", () => {
    expect(looksLikeCode("abcDEF123456789-_xyz#STATE123")).toBe(true);
    expect(looksLikeCode("what is our refund policy?")).toBe(false);
    expect(looksLikeCode("short")).toBe(false);
  });
});
