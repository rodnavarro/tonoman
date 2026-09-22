// One real look at LOREALISTAR, by hand: `LOREAL_EMAIL=… LOREAL_PASSWORD=… tsx scripts/lorealistar-look.ts`.
// Prints what is open and the SHAPE of what the site sent — never the login, a token, or the email.
// One sign-in and one request: gentle on the account (DROPS-GENTLE).
import { look, siteOver, dropLine, type Campaign } from "../src/lorealistar/watch";

const email = process.env.LOREAL_EMAIL;
const password = process.env.LOREAL_PASSWORD;
if (!email || !password) {
  console.error("LOREAL_EMAIL and LOREAL_PASSWORD are needed (in the environment, not on the command line)");
  process.exit(2);
}

async function main(email: string, password: string): Promise<void> {
const site = siteOver();
let raw: Campaign[] = [];
const r = await look(
  { told: [], failures: 0 },
  { email, password },
  {
    now: () => Date.now(),
    signIn: site.signIn,
    renew: site.renew,
    list: async (t) => {
      const l = await site.list(t);
      if (l.ok) raw = l.campaigns;
      return l;
    },
  },
);
console.log(`signed in: ${!!r.state.session}; needs the person: ${!!r.state.needsPerson}; failures: ${r.state.failures}`);
if (r.notice) console.log(`notice: ${r.notice}`);
console.log(`campaigns listed: ${raw.length}; by type/status: ${JSON.stringify(raw.reduce<Record<string, number>>((a, c) => ((a[`${c.type}/${c.status}`] = (a[`${c.type}/${c.status}`] ?? 0) + 1), a), {}))}`);
if (raw[0]) console.log(`fields of one: ${Object.keys(raw[0]).sort().join(", ")}`);
console.log(`open drops: ${r.open?.length ?? 0}`);
for (const c of r.news) console.log(`  ${dropLine(c)}`);
}

void main(email, password);
